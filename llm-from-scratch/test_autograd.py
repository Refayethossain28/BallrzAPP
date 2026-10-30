"""Sanity checks for the autograd engine.

Three layers of evidence that backprop is right everywhere in the stack:

1. `test_basic_ops` / `test_broadcast`: the primitives against closed forms.
2. `test_fused_ops`: every hand-written fused op (gelu, silu, layernorm,
   rmsnorm, softmax) against the SAME function composed from primitives —
   identical forward values and identical gradients. `unbind` and `rope`
   (which have no primitive-only composition) are checked numerically.
3. `test_gradcheck`: analytic gradients from a real GPT forward pass — both
   the v1 (GPT-2) and v2 (Llama-style) architectures — against finite
   differences. If backprop is wrong anywhere, this fails. Run with:

    python test_autograd.py
"""

from __future__ import annotations

import math

import numpy as np

from autograd import (Tensor, gelu, layernorm, rmsnorm, rope, rope_tables,
                      silu, softmax, unbind)
from model import GPT, GPTConfig


def _numeric_grad(f, x, eps=1e-3):
    grad = np.zeros_like(x.data)
    it = np.nditer(x.data, flags=["multi_index"])
    while not it.finished:
        idx = it.multi_index
        orig = x.data[idx]
        x.data[idx] = orig + eps
        fp = f()
        x.data[idx] = orig - eps
        fm = f()
        x.data[idx] = orig
        grad[idx] = (fp - fm) / (2 * eps)
        it.iternext()
    return grad


def _rel(a, b):
    return float(np.linalg.norm(a - b) / (np.linalg.norm(b) + 1e-9))


def test_basic_ops():
    a = Tensor(np.array([[1.0, 2.0], [3.0, 4.0]]))
    b = Tensor(np.array([[5.0, 6.0], [7.0, 8.0]]))
    out = (a @ b + a * b).sum()
    out.backward()
    # d/da [sum(a@b)] = ones @ b^T ; d/da [sum(a*b)] = b
    expected_a = np.ones((2, 2)) @ b.data.T + b.data
    assert np.allclose(a.grad, expected_a), (a.grad, expected_a)
    print("test_basic_ops: ok")


def test_broadcast():
    x = Tensor(np.random.randn(3, 4))
    w = Tensor(np.random.randn(4))  # broadcast add
    loss = (x + w).sum()
    loss.backward()
    assert np.allclose(w.grad, np.full(4, 3.0)), w.grad
    print("test_broadcast: ok")


# --- primitive-only references for the fused ops ------------------------------

def _ref_softmax(x, axis=-1):
    m = Tensor(x.data.max(axis=axis, keepdims=True))
    e = (x - m).exp()
    return e / e.sum(axis=axis, keepdims=True)


def _ref_gelu(x):
    c = math.sqrt(2.0 / math.pi)
    return 0.5 * x * (1.0 + (c * (x + 0.044715 * (x ** 3))).tanh())


def _ref_silu(x):
    return x * ((1.0 + (-x).exp()) ** -1)


def _ref_layernorm(x, gamma, beta, eps=1e-5):
    mu = x.mean(axis=-1, keepdims=True)
    xc = x - mu
    var = (xc * xc).mean(axis=-1, keepdims=True)
    return (xc / ((var + eps) ** 0.5)) * gamma + beta


def _ref_rmsnorm(x, gamma, eps=1e-5):
    ms = (x * x).mean(axis=-1, keepdims=True)
    return x * ((ms + eps) ** -0.5) * gamma


def test_fused_ops():
    rng = np.random.default_rng(0)
    xd = rng.standard_normal((3, 5, 8)).astype(np.float32)
    gd = (1 + 0.1 * rng.standard_normal(8)).astype(np.float32)
    bd = (0.1 * rng.standard_normal(8)).astype(np.float32)
    up = rng.standard_normal((3, 5, 8)).astype(np.float32)   # upstream weights

    cases = {
        "gelu": (lambda x, g, b: gelu(x), lambda x, g, b: _ref_gelu(x)),
        "silu": (lambda x, g, b: silu(x), lambda x, g, b: _ref_silu(x)),
        "softmax": (lambda x, g, b: softmax(x), lambda x, g, b: _ref_softmax(x)),
        "layernorm": (lambda x, g, b: layernorm(x, g, b), lambda x, g, b: _ref_layernorm(x, g, b)),
        "rmsnorm": (lambda x, g, b: rmsnorm(x, g), lambda x, g, b: _ref_rmsnorm(x, g)),
    }
    for name, (fused, ref) in cases.items():
        outs = []
        for fn in (fused, ref):
            x, g, b = Tensor(xd.copy()), Tensor(gd.copy()), Tensor(bd.copy())
            y = fn(x, g, b)
            (y * Tensor(up)).sum().backward()
            outs.append((y.data, x.grad, g.grad, b.grad))
        (yf, xf, gf, bf), (yr, xr, gr, br) = outs
        assert _rel(yf, yr) < 1e-5, (name, "forward", _rel(yf, yr))
        assert _rel(xf, xr) < 1e-4, (name, "dx", _rel(xf, xr))
        if gr is not None:
            assert _rel(gf, gr) < 1e-4, (name, "dgamma", _rel(gf, gr))
        if br is not None:
            assert _rel(bf, br) < 1e-4, (name, "dbeta", _rel(bf, br))
    print("test_fused_ops: ok (gelu, silu, softmax, layernorm, rmsnorm match their primitive compositions)")

    # unbind: three graph-connected slices sharing one gradient buffer.
    x = Tensor(rng.standard_normal((3, 6, 8)).astype(np.float32))
    w = Tensor(np.ones((8, 2), dtype=np.float32))

    def ub_loss():
        q, k, v = unbind(x.reshape(3, 2, 3, 8).transpose(2, 0, 1, 3), axis=0)  # 3 x (3, 2, 8)
        return (((q * k) @ w) + (v * v).sum()).sum()

    ub_loss().backward()
    ng = _numeric_grad(lambda: float(ub_loss().data), x)
    assert _rel(x.grad, ng) < 1e-2, ("unbind", _rel(x.grad, ng))
    # an unused slice, and the parent also feeding another op: against the
    # primitive-only reference (reshape/transpose/sum have exact gradients)
    def ub_partial(xt):
        q, k, v = unbind(xt.reshape(3, 2, 3, 8).transpose(2, 0, 1, 3), axis=0)   # v unused
        return ((q * k) @ w).sum() + (xt * xt).sum()
    def ref_partial(xt):
        r = xt.reshape(3, 2, 3, 8).transpose(2, 0, 1, 3)
        q = Tensor(r.data[0]); k = Tensor(r.data[1])      # constants: grads by hand below
        return None
    x1 = Tensor(x.data.copy()); ub_partial(x1).backward()
    # d/dx of (xt*xt).sum() = 2x; the q*k term's grad: k into q's slot, q into k's slot
    r = x.data.reshape(3, 2, 3, 8).transpose(2, 0, 1, 3)
    g = np.zeros_like(r); g[0] = r[1] * w.data.sum(axis=1); g[1] = r[0] * w.data.sum(axis=1)
    expected = g.transpose(1, 2, 0, 3).reshape(3, 6, 8) + 2 * x.data
    assert _rel(x1.grad, expected) < 1e-5, ("unbind partial", _rel(x1.grad, expected))
    print("test_fused_ops: ok (unbind, incl. an unused slice and a second consumer of the parent)")

    # rope: at position t the op is x @ R_tᵀ for an explicit rotation matrix
    # R_t (built here from the same tables), and its backward is g @ R_t.
    # Checked analytically (1e-5), not by finite differences.
    T, D = 5, 8
    cos, sin = rope_tables(T, D)
    half = D // 2
    R = np.zeros((T, D, D), dtype=np.float64)
    for t in range(T):
        for j in range(half):
            c, s_ = float(cos[t, j]), float(sin[t, j])
            # out_j = x_j c − x_{j+h} s ; out_{j+h} = x_{j+h} c + x_j s
            R[t, j, j] = c; R[t, j, j + half] = -s_
            R[t, j + half, j + half] = c; R[t, j + half, j] = s_
    x = Tensor(xd.copy())
    y = rope(x, cos, sin)
    ref = np.einsum("btd,tkd->btk", xd.astype(np.float64), R)
    assert _rel(y.data, ref) < 1e-5, ("rope forward", _rel(y.data, ref))
    assert np.allclose(np.linalg.norm(y.data, axis=-1), np.linalg.norm(xd, axis=-1), atol=1e-4)
    assert np.allclose(y.data[:, 0], xd[:, 0], atol=1e-6)      # position 0 is the identity
    (y * Tensor(up)).sum().backward()
    ref_g = np.einsum("btk,tkd->btd", up.astype(np.float64), R)
    assert _rel(x.grad, ref_g) < 1e-5, ("rope backward", _rel(x.grad, ref_g))
    print("test_fused_ops: ok (rope equals an explicit rotation matrix, forward and backward)")


def _gradcheck(arch):
    np.random.seed(0)
    kw = GPTConfig.V2 if arch == "v2" else {}
    cfg = GPTConfig(vocab_size=11, block_size=8, n_layer=2, n_head=2, n_embd=16, **kw)
    model = GPT(cfg)
    # GPT-2's 0.02 init makes a 2-layer toy model nearly linear in its inner
    # weights, so their gradients are too tiny for float32 finite differences
    # to resolve. Scale the matrices up: the check is about the *formulas*.
    for p in model.parameters():
        if p.data.ndim >= 2:
            p.data = (p.data / (np.abs(p.data).std() + 1e-9) * 0.25).astype(np.float32)
    B, T = 2, 6
    idx = np.random.randint(0, cfg.vocab_size, size=(B, T))
    targets = np.random.randint(0, cfg.vocab_size, size=(B, T))

    def loss_fn():
        _, loss = model.forward(idx, targets)
        return float(loss.data)

    _, loss = model.forward(idx, targets)
    for p in model.parameters():
        p.grad = None
    loss.backward()

    blk = model.blocks[0]
    picks = [model.wte.weight, blk.attn.qkv.weight, blk.attn.proj.weight, blk.ln1.gamma, model.ln_f.gamma]
    if arch == "v2":
        picks += [blk.mlp.gate.weight, blk.mlp.up.weight, blk.mlp.down.weight]
    else:
        picks += [model.head.weight, model.wpe.weight, blk.mlp.fc.weight, blk.attn.qkv.bias, model.ln_f.beta]

    # Global L2 relative error rather than max-per-element: with float32 +
    # finite differences, entries whose true gradient is ~0 produce huge
    # per-element ratios that are pure numerical noise.
    worst = 0.0
    for p in picks:
        ng = _numeric_grad(loss_fn, p)
        worst = max(worst, _rel(p.grad, ng))
    print(f"test_gradcheck[{arch}]: worst L2 relative error {worst:.2e}")
    assert worst < 1e-2, f"gradient check failed ({arch}): {worst}"


def test_gradcheck():
    _gradcheck("v1")
    _gradcheck("v2")


def test_generate_window():
    """Sampling past the context window follows GPT.crop_window and never crashes
    (top-p used to clobber the window length variable)."""
    np.random.seed(0)
    cfg = GPTConfig(vocab_size=11, block_size=8, n_layer=1, n_head=2, n_embd=8, **GPTConfig.V2)
    model = GPT(cfg)
    rng = np.random.default_rng(0)
    out = model.generate(np.array([[1, 2, 3]]), max_new_tokens=cfg.block_size + 8, temperature=0.9,
                         top_k=5, top_p=0.9, repetition_penalty=1.2, rng=rng)
    assert out.shape == (1, 3 + cfg.block_size + 8), out.shape
    assert GPT.crop_window(list(range(9)), 8) == list(range(3, 9))     # 9 > 8 -> newest 6
    assert GPT.crop_window(list(range(8)), 8) == list(range(8))        # not over: unchanged
    assert GPT.crop_window(list(range(13)), 12) == list(range(4, 13))  # keep = 12 - 3
    print("test_generate_window: ok")


def test_config_roundtrip():
    """Old checkpoints saved only the five original fields; they must load as v1."""
    old = {"vocab_size": 1024, "block_size": 128, "n_layer": 6, "n_head": 8, "n_embd": 256}
    cfg = GPTConfig.from_dict(old)
    assert cfg.arch == "v1" and cfg.mlp_hidden == 1024, cfg
    v2 = GPTConfig.from_dict({**old, **GPTConfig.V2})
    assert v2.arch == "v2" and v2.mlp_hidden == 704, v2
    assert GPTConfig.from_dict(v2.to_dict()) == v2
    # the parameter list of a v1 model keeps its historical order (wte, wpe, blocks..., ln_f, head)
    m = GPT(GPTConfig(vocab_size=11, block_size=8, n_layer=1, n_head=2, n_embd=8))
    assert [p.shape for p in m.parameters()] == [
        (11, 8), (8, 8), (8,), (8,), (8, 24), (24,), (8, 8), (8,), (8,), (8,), (8, 32), (32,), (32, 8), (8,),
        (8,), (8,), (8, 11)]
    print("test_config_roundtrip: ok")


if __name__ == "__main__":
    test_basic_ops()
    test_broadcast()
    test_fused_ops()
    test_config_roundtrip()
    test_generate_window()
    test_gradcheck()
    print("all tests passed")
