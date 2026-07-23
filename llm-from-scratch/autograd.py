"""A tiny reverse-mode automatic differentiation engine, backed by NumPy.

This is the foundation everything else is built on. A `Tensor` wraps a NumPy
array and records the operations performed on it as a graph. Calling
`.backward()` on a scalar walks that graph in reverse topological order and
fills in `.grad` for every tensor that contributed to it -- the same idea as
PyTorch's autograd, implemented from scratch in a few hundred lines.

Only the handful of primitive ops a transformer needs are implemented. Higher
level pieces (layernorm, softmax, attention) are composed from these, so their
gradients come for free.
"""

from __future__ import annotations

import numpy as np


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

    def __init__(self, data, _children=(), _op=""):
        self.data = np.asarray(data, dtype=np.float32)
        self.grad = None
        self._backward = lambda: None
        self._prev = set(_children)
        self._op = _op

    # --- construction helpers -------------------------------------------------
    @property
    def shape(self):
        return self.data.shape

    def __repr__(self):
        return f"Tensor(shape={self.data.shape}, op={self._op!r})"

    # --- primitive ops --------------------------------------------------------
    def __add__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = Tensor(self.data + other.data, (self, other), "+")

        def _backward():
            self.grad = _acc(self.grad, _unbroadcast(out.grad, self.data.shape))
            other.grad = _acc(other.grad, _unbroadcast(out.grad, other.data.shape))

        out._backward = _backward
        return out

    def __mul__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = Tensor(self.data * other.data, (self, other), "*")

        def _backward():
            self.grad = _acc(self.grad, _unbroadcast(other.data * out.grad, self.data.shape))
            other.grad = _acc(other.grad, _unbroadcast(self.data * out.grad, other.data.shape))

        out._backward = _backward
        return out

    def matmul(self, other):
        out = Tensor(self.data @ other.data, (self, other), "@")

        def _backward():
            g = out.grad
            sg = g @ np.swapaxes(other.data, -1, -2)
            og = np.swapaxes(self.data, -1, -2) @ g
            self.grad = _acc(self.grad, _unbroadcast(sg, self.data.shape))
            other.grad = _acc(other.grad, _unbroadcast(og, other.data.shape))

        out._backward = _backward
        return out

    def __matmul__(self, other):
        return self.matmul(other)

    def __pow__(self, p):
        assert isinstance(p, (int, float)), "only scalar powers supported"
        out = Tensor(self.data ** p, (self,), f"**{p}")

        def _backward():
            self.grad = _acc(self.grad, (p * self.data ** (p - 1)) * out.grad)

        out._backward = _backward
        return out

    def sum(self, axis=None, keepdims=False):
        out = Tensor(self.data.sum(axis=axis, keepdims=keepdims), (self,), "sum")

        def _backward():
            g = out.grad
            if axis is not None and not keepdims:
                g = np.expand_dims(g, axis)
            self.grad = _acc(self.grad, np.broadcast_to(g, self.data.shape).copy())

        out._backward = _backward
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

        out._backward = _backward
        return out

    def log(self):
        out = Tensor(np.log(self.data), (self,), "log")

        def _backward():
            self.grad = _acc(self.grad, (1.0 / self.data) * out.grad)

        out._backward = _backward
        return out

    def tanh(self):
        t = np.tanh(self.data)
        out = Tensor(t, (self,), "tanh")

        def _backward():
            self.grad = _acc(self.grad, (1 - t * t) * out.grad)

        out._backward = _backward
        return out

    def relu(self):
        out = Tensor(np.maximum(0, self.data), (self,), "relu")

        def _backward():
            self.grad = _acc(self.grad, (self.data > 0) * out.grad)

        out._backward = _backward
        return out

    # --- shape ops ------------------------------------------------------------
    def reshape(self, *shape):
        out = Tensor(self.data.reshape(*shape), (self,), "reshape")

        def _backward():
            self.grad = _acc(self.grad, out.grad.reshape(self.data.shape))

        out._backward = _backward
        return out

    def transpose(self, *axes):
        if not axes:
            axes = tuple(reversed(range(self.data.ndim)))
        out = Tensor(self.data.transpose(*axes), (self,), "transpose")
        inv = np.argsort(axes)

        def _backward():
            self.grad = _acc(self.grad, out.grad.transpose(*inv))

        out._backward = _backward
        return out

    # --- sugar ----------------------------------------------------------------
    def __neg__(self):
        return self * -1.0

    def __sub__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        return self + (-other)

    def __rsub__(self, other):
        return (-self) + other

    def __truediv__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
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


# --- functions that build their own graph nodes ------------------------------

def embedding(weight: Tensor, idx: np.ndarray) -> Tensor:
    """Gather rows of `weight` (V, d) at integer indices `idx` (any shape)."""
    out = Tensor(weight.data[idx], (weight,), "embedding")

    def _backward():
        g = np.zeros_like(weight.data)
        np.add.at(g, idx, out.grad)
        weight.grad = _acc(weight.grad, g)

    out._backward = _backward
    return out


def softmax(x: Tensor, axis: int = -1) -> Tensor:
    """Numerically stable softmax built from primitive ops."""
    m = Tensor(x.data.max(axis=axis, keepdims=True))  # constant shift, no grad needed
    e = (x - m).exp()
    return e / e.sum(axis=axis, keepdims=True)


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

    out._backward = _backward
    return out
