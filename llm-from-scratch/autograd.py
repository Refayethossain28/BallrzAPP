"""A tiny reverse-mode automatic differentiation engine, backed by NumPy.

This is the foundation everything else is built on. A `Tensor` wraps a NumPy
array and records the operations performed on it as a graph. Calling
`.backward()` on a scalar walks that graph in reverse topological order and
fills in `.grad` for every tensor that contributed to it -- the same idea as
PyTorch's autograd, implemented from scratch in a few hundred lines.

Two kinds of ops live here:

* **Primitives** (`+`, `*`, `@`, `sum`, `exp`, `reshape`, ...): the handful of
  building blocks a transformer needs. Anything composed from them gets its
  gradient for free.
* **Fused ops** (`gelu`, `silu`, `layernorm`, `rmsnorm`, `softmax`, `rope`,
  `cross_entropy`): the hot spots of the forward pass, each written as ONE graph
  node with a hand-derived backward. Composing `gelu` from primitives costs
  ten nodes, ten temporaries and a slow `x ** 3`; the fused version is one
  node and one `tanh`. The derivative of every fused op is checked against
  finite differences in `test_autograd.py`, so nothing is taken on faith.
"""

from __future__ import annotations

import math

from backend import np, index_add  # numpy, or CuPy when LLM_BACKEND=cupy


# --- grad mode -----------------------------------------------------------------
# Every op's `_backward` closure captures its output tensor, so each graph node
# is a reference cycle that only cyclic GC can reclaim — and a forward pass at
# B16xT256 holds a gigabyte or two of intermediates. backward() snaps those
# cycles, but evaluation and sampling never call backward(): 12 validation
# forwards in a row were enough to OOM a 15 GB machine. Under `no_grad()` ops
# record no children and attach no closure, so intermediates die by refcount
# the moment the Python code lets go of them.
_grad_enabled = True


class no_grad:
    """`with no_grad(): model.forward(x)` — build no graph, keep no intermediates."""

    def __enter__(self):
        global _grad_enabled
        self._prev = _grad_enabled
        _grad_enabled = False
        return self

    def __exit__(self, *exc):
        global _grad_enabled
        _grad_enabled = self._prev
        return False


def _attach(out, fn):
    """Register `fn` as out's backward — unless we are in no_grad mode."""
    if _grad_enabled:
        out._backward = fn


def _acc(existing, new):
    """Accumulate a gradient contribution (grads start as None to save memory)."""
    return new if existing is None else existing + new


def _unbroadcast(grad, shape):
    """Reverse NumPy broadcasting: sum `grad` back down to `shape`."""
    # Collapse leading dims that were added by broadcasting.
    while grad.ndim > len(shape):
        grad = grad.sum(axis=0)
    # Collapse dims that were size 1 in the original but got broadcast.
    for i, dim in enumerate(shape):
        if dim == 1 and grad.shape[i] != 1:
            grad = grad.sum(axis=i, keepdims=True)
    return grad.reshape(shape)


class Tensor:
    """A node in the autodiff graph."""

    def __init__(self, data, _children=(), _op="", requires_grad=True):
        self.data = np.asarray(data, dtype=np.float32)
        self.grad = None
        # Constants (masks, scalars) are wrapped as Tensors too; marking them
        # requires_grad=False lets the ops skip computing a gradient nobody
        # reads — for the (B, H, T, T) attention mask that is a full extra
        # pass over the largest array in the model.
        self.requires_grad = requires_grad
        self._backward = lambda: None
        self._prev = set(_children) if _grad_enabled else set()
        self._op = _op

    # --- construction helpers -------------------------------------------------
    @property
    def shape(self):
        return self.data.shape

    def __repr__(self):
        return f"Tensor(shape={self.data.shape}, op={self._op!r})"

    # --- primitive ops --------------------------------------------------------
    def __add__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other, requires_grad=False)
        out = Tensor(self.data + other.data, (self, other), "+")

        def _backward():
            if self.requires_grad:
                self.grad = _acc(self.grad, _unbroadcast(out.grad, self.data.shape))
            if other.requires_grad:
                other.grad = _acc(other.grad, _unbroadcast(out.grad, other.data.shape))

        _attach(out, _backward)
        return out

    def __mul__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other, requires_grad=False)
        out = Tensor(self.data * other.data, (self, other), "*")

        def _backward():
            if self.requires_grad:
                self.grad = _acc(self.grad, _unbroadcast(other.data * out.grad, self.data.shape))
            if other.requires_grad:
                other.grad = _acc(other.grad, _unbroadcast(self.data * out.grad, other.data.shape))

        _attach(out, _backward)
        return out

    def matmul(self, other):
        out = Tensor(self.data @ other.data, (self, other), "@")

        def _backward():
            g = out.grad
            if self.requires_grad:
                sg = g @ np.swapaxes(other.data, -1, -2)
                self.grad = _acc(self.grad, _unbroadcast(sg, self.data.shape))
            if other.requires_grad:
                og = np.swapaxes(self.data, -1, -2) @ g
                other.grad = _acc(other.grad, _unbroadcast(og, other.data.shape))

        _attach(out, _backward)
        return out

    def __matmul__(self, other):
        return self.matmul(other)

    def __pow__(self, p):
        assert isinstance(p, (int, float)), "only scalar powers supported"
        out = Tensor(self.data ** p, (self,), f"**{p}")

        def _backward():
            self.grad = _acc(self.grad, (p * self.data ** (p - 1)) * out.grad)

        _attach(out, _backward)
        return out

    def sum(self, axis=None, keepdims=False):
        out = Tensor(self.data.sum(axis=axis, keepdims=keepdims), (self,), "sum")

        def _backward():
            g = out.grad
            if axis is not None and not keepdims:
                g = np.expand_dims(g, axis)
            self.grad = _acc(self.grad, np.broadcast_to(g, self.data.shape).copy())

        _attach(out, _backward)
        return out

    def mean(self, axis=None, keepdims=False):
        if axis is None:
            n = self.data.size
        else:
            ax = axis if isinstance(axis, tuple) else (axis,)
            n = int(np.prod([self.data.shape[a] for a in ax]))
        return self.sum(axis=axis, keepdims=keepdims) * (1.0 / n)

    def exp(self):
        e = np.exp(self.data)
        out = Tensor(e, (self,), "exp")

        def _backward():
            self.grad = _acc(self.grad, e * out.grad)

        _attach(out, _backward)
        return out

    def log(self):
        out = Tensor(np.log(self.data), (self,), "log")

        def _backward():
            self.grad = _acc(self.grad, (1.0 / self.data) * out.grad)

        _attach(out, _backward)
        return out

    def tanh(self):
        t = np.tanh(self.data)
        out = Tensor(t, (self,), "tanh")

        def _backward():
            self.grad = _acc(self.grad, (1 - t * t) * out.grad)

        _attach(out, _backward)
        return out

    def relu(self):
        out = Tensor(np.maximum(0, self.data), (self,), "relu")

        def _backward():
            self.grad = _acc(self.grad, (self.data > 0) * out.grad)

        _attach(out, _backward)
        return out

    # --- shape ops ------------------------------------------------------------
    def reshape(self, *shape):
        out = Tensor(self.data.reshape(*shape), (self,), "reshape")

        def _backward():
            self.grad = _acc(self.grad, out.grad.reshape(self.data.shape))

        _attach(out, _backward)
        return out

    def transpose(self, *axes):
        if not axes:
            axes = tuple(reversed(range(self.data.ndim)))
        out = Tensor(self.data.transpose(*axes), (self,), "transpose")
        # Inverse permutation, computed host-side (axes is a tiny Python tuple;
        # under the CuPy backend np.argsort would needlessly make a GPU array).
        inv = [0] * len(axes)
        for i, a in enumerate(axes):
            inv[a] = i
        inv = tuple(inv)

        def _backward():
            self.grad = _acc(self.grad, out.grad.transpose(*inv))

        _attach(out, _backward)
        return out

    # --- sugar ----------------------------------------------------------------
    def __neg__(self):
        return self * -1.0

    def __sub__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other, requires_grad=False)
        return self + (-other)

    def __rsub__(self, other):
        return (-self) + other

    def __truediv__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other, requires_grad=False)
        return self * (other ** -1)

    __radd__ = __add__
    __rmul__ = __mul__

    # --- backprop -------------------------------------------------------------
    def backward(self):
        """Populate `.grad` for every tensor that fed into this scalar."""
        topo = []
        visited = set()
        # Iterative post-order DFS so deep graphs don't blow the recursion limit.
        stack = [(self, False)]
        while stack:
            node, processed = stack.pop()
            if processed:
                topo.append(node)
                continue
            if node in visited:
                continue
            visited.add(node)
            stack.append((node, True))
            for child in node._prev:
                if child not in visited:
                    stack.append((child, False))

        self.grad = np.ones_like(self.data)
        for node in reversed(topo):
            node._backward()

        # Free the graph. Every op's `_backward` closure captures its own output
        # tensor, so each node sits in a reference cycle (out -> closure -> out)
        # that plain refcounting can't reclaim — and one training step's graph
        # holds gigabytes of intermediate arrays. Python's cyclic GC triggers on
        # object *counts*, not bytes, so at ~1 step/minute the garbage outruns
        # collection and training OOMs (observed: >14 GB RSS in 5 minutes).
        # Snapping the cycles here lets refcounting free each step's arrays the
        # moment the loss tensor goes out of scope. Parameters keep their
        # `.grad` (the optimizer reads it after backward); intermediates and
        # their grads die with the graph.
        for node in topo:
            node._prev = set()
            node._backward = lambda: None


# --- functions that build their own graph nodes ------------------------------

def embedding(weight: Tensor, idx: np.ndarray) -> Tensor:
    """Gather rows of `weight` (V, d) at integer indices `idx` (any shape)."""
    out = Tensor(weight.data[idx], (weight,), "embedding")

    def _backward():
        g = np.zeros_like(weight.data)
        index_add(g, idx, out.grad)  # np.add.at has no CuPy equivalent
        weight.grad = _acc(weight.grad, g)

    _attach(out, _backward)
    return out


def unbind(t: Tensor, axis: int = 0) -> list:
    """Split `t` along `axis` into graph-connected slices (one Tensor each).

    All slices share ONE gradient buffer the size of `t`: the first slice to
    run installs it as `t.grad`, the others add their part in place — unless
    another consumer of `t` has replaced `t.grad` meanwhile, in which case a
    slice falls back to a plain accumulate. A slice that never reaches the
    loss simply never runs, and the others are unaffected. Doing it with N
    separate `zeros_like + add` passes (the old `_take`) allocated N full-size
    arrays per attention layer — a quarter of the backward pass.
    """
    n = t.data.shape[axis]
    state = {"buf": None}   # the buffer we installed as t.grad, if we did
    outs = []

    def make(i):
        sl = [slice(None)] * t.data.ndim
        sl[axis] = i
        sl = tuple(sl)
        out = Tensor(t.data[sl], (t,), "unbind")

        def _backward():
            if out.grad is None:
                return
            if state["buf"] is not None and t.grad is state["buf"]:
                state["buf"][sl] += out.grad          # still our buffer: add in place
                return
            buf = np.zeros_like(t.data)
            buf[sl] += out.grad
            if t.grad is None:
                t.grad = buf                          # we own t.grad from here on
                state["buf"] = buf
            else:
                t.grad = _acc(t.grad, buf)            # someone else got there first
                state["buf"] = None

        _attach(out, _backward)
        return out

    for i in range(n):
        outs.append(make(i))
    return outs


def softmax(x: Tensor, axis: int = -1, mask=None) -> Tensor:
    """Numerically stable softmax as one fused node.

    `mask` is an optional additive constant (0 / −1e9 for causal attention)
    folded into the same pass, so the mask never costs a graph node of its own.
    With s = softmax(x):  ds_i/dx_j = s_i (δ_ij − s_j), so for an upstream
    gradient g the input gradient is  s ⊙ (g − Σ_j g_j s_j)  along `axis`.
    """
    z = x.data if mask is None else x.data + mask
    m = z.max(axis=axis, keepdims=True)
    e = np.exp(z - m)
    s = e / e.sum(axis=axis, keepdims=True)
    out = Tensor(s, (x,), "softmax")
    last = axis == -1 or axis == x.data.ndim - 1

    def _backward():
        g = out.grad
        if last:
            # row-wise dot products without materialising g*s (the (B,H,T,T)
            # attention map is the biggest array in the whole model)
            dot = np.einsum("...i,...i->...", g, s)[..., None]
        else:
            dot = (g * s).sum(axis=axis, keepdims=True)
        d = g - dot
        d *= s
        x.grad = _acc(x.grad, d)

    _attach(out, _backward)
    return out


_GELU_C = math.sqrt(2.0 / math.pi)
_GELU_K = 0.044715


def gelu(x: Tensor) -> Tensor:
    """Gaussian Error Linear Unit (tanh approximation), the GPT-2 activation.

    y = ½·x·(1 + tanh(u)),  u = c·(x + k·x³),  c = √(2/π), k = 0.044715
    dy/dx = ½·(1 + tanh u) + ½·x·(1 − tanh²u)·c·(1 + 3k·x²)
    """
    xd = x.data
    x2 = xd * xd
    t = np.tanh(_GELU_C * (xd + _GELU_K * x2 * xd))
    out = Tensor(0.5 * xd * (1.0 + t), (x,), "gelu")

    def _backward():
        du = _GELU_C * (1.0 + 3.0 * _GELU_K * x2)
        dy = 0.5 * (1.0 + t) + 0.5 * xd * (1.0 - t * t) * du
        x.grad = _acc(x.grad, dy * out.grad)

    _attach(out, _backward)
    return out


def silu(x: Tensor) -> Tensor:
    """SiLU / swish: x·σ(x). Used by the SwiGLU MLP.  d/dx = σ(x)·(1 + x·(1 − σ(x)))."""
    xd = x.data
    s = 1.0 / (1.0 + np.exp(-xd))
    out = Tensor(xd * s, (x,), "silu")

    def _backward():
        x.grad = _acc(x.grad, (s * (1.0 + xd * (1.0 - s))) * out.grad)

    _attach(out, _backward)
    return out


def layernorm(x: Tensor, gamma: Tensor, beta: Tensor, eps: float = 1e-5) -> Tensor:
    """LayerNorm over the last axis as one fused node.

    x̂ = (x − μ)·r with r = 1/√(σ² + eps);  y = γ·x̂ + β.
    With ĝ = g·γ:  dx = r·(ĝ − mean(ĝ) − x̂·mean(ĝ·x̂)),  dγ = Σ g·x̂,  dβ = Σ g
    (means and sums over the normalised axis / all other axes respectively).
    """
    xd = x.data
    mu = xd.mean(axis=-1, keepdims=True)
    xc = xd - mu
    var = (xc * xc).mean(axis=-1, keepdims=True)
    rstd = 1.0 / np.sqrt(var + eps)
    xn = xc * rstd
    out = Tensor(xn * gamma.data + beta.data, (x, gamma, beta), "layernorm")

    def _backward():
        g = out.grad
        n = xd.shape[-1]
        gamma.grad = _acc(gamma.grad, (g * xn).reshape(-1, n).sum(axis=0))
        beta.grad = _acc(beta.grad, g.reshape(-1, n).sum(axis=0))
        gh = g * gamma.data
        dx = rstd * (gh - gh.mean(axis=-1, keepdims=True)
                     - xn * (gh * xn).mean(axis=-1, keepdims=True))
        x.grad = _acc(x.grad, dx)

    _attach(out, _backward)
    return out


def rmsnorm(x: Tensor, gamma: Tensor, eps: float = 1e-5) -> Tensor:
    """RMSNorm (the Llama normaliser): no mean subtraction, no bias.

    x̂ = x·r with r = 1/√(mean(x²) + eps);  y = γ·x̂.
    With ĝ = g·γ:  dx = r·(ĝ − x̂·mean(ĝ·x̂)),  dγ = Σ g·x̂.
    """
    xd = x.data
    ms = (xd * xd).mean(axis=-1, keepdims=True)
    rstd = 1.0 / np.sqrt(ms + eps)
    xn = xd * rstd
    out = Tensor(xn * gamma.data, (x, gamma), "rmsnorm")

    def _backward():
        g = out.grad
        n = xd.shape[-1]
        gamma.grad = _acc(gamma.grad, (g * xn).reshape(-1, n).sum(axis=0))
        gh = g * gamma.data
        dx = rstd * (gh - xn * (gh * xn).mean(axis=-1, keepdims=True))
        x.grad = _acc(x.grad, dx)

    _attach(out, _backward)
    return out


def rope_tables(block_size: int, head_dim: int, theta: float = 10000.0):
    """cos/sin tables (T, D) for rotary position embeddings, "rotate-half" layout.

    inv_freq_j = theta^(−2j/D) for j < D/2; angle(t, j) = t·inv_freq_j. Each
    half of the table repeats the D/2 angles, so `x*cos + rotate_half(x)*sin`
    applies the rotation to the pair (x_j, x_{j+D/2}). Built in float64 and
    cast to float32 — web/gpt.js builds the identical table the same way, so
    the browser forward pass matches Python to float32 precision.
    """
    import numpy as hnp  # host-side: a tiny table, and bit-identical to the JS port
    half = head_dim // 2
    inv_freq = theta ** (-(hnp.arange(0, half, dtype=hnp.float64) * 2.0) / head_dim)
    ang = hnp.arange(block_size, dtype=hnp.float64)[:, None] * inv_freq[None, :]   # (T, D/2)
    ang = hnp.concatenate([ang, ang], axis=1)                                       # (T, D)
    return (np.asarray(hnp.cos(ang).astype(hnp.float32)),
            np.asarray(hnp.sin(ang).astype(hnp.float32)))


def rope(x: Tensor, cos, sin) -> Tensor:
    """Apply rotary position embeddings to x (..., T, D) with tables (T, D).

    y = x·cos + R(x)·sin, where R(x) = [−x₂, x₁] rotates the two halves.
    R is linear with Rᵀ(g) = [g₂, −g₁], so  dx = g·cos + Rᵀ(g·sin).
    """
    xd = x.data
    half = xd.shape[-1] // 2
    x1, x2 = xd[..., :half], xd[..., half:]
    rot = np.concatenate([-x2, x1], axis=-1)
    out = Tensor(xd * cos + rot * sin, (x,), "rope")

    def _backward():
        g = out.grad
        gs = g * sin
        rt = np.concatenate([gs[..., half:], -gs[..., :half]], axis=-1)
        x.grad = _acc(x.grad, g * cos + rt)

    _attach(out, _backward)
    return out


def cross_entropy(logits: Tensor, targets: np.ndarray) -> Tensor:
    """Mean softmax cross-entropy. `logits` (N, V), `targets` int (N,).

    Implemented as a single fused op for speed and numerical stability -- the
    gradient of softmax+CE is just (softmax - onehot).
    """
    x = logits.data
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    p = e / e.sum(axis=-1, keepdims=True)
    n = targets.shape[0]
    loss_val = -np.log(p[np.arange(n), targets] + 1e-9).mean()
    out = Tensor(loss_val, (logits,), "cross_entropy")

    def _backward():
        g = p.copy()
        g[np.arange(n), targets] -= 1.0
        g /= n
        logits.grad = _acc(logits.grad, g * out.grad)

    _attach(out, _backward)
    return out
