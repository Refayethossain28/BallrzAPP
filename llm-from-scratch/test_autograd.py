"""Sanity checks for the autograd engine.

The important one is `test_gradcheck`: it compares the analytic gradients from
backprop against numerical (finite-difference) gradients on a real GPT forward
pass. If backprop is wrong anywhere in the stack, this fails. Run with:

    python test_autograd.py
"""

from __future__ import annotations

import numpy as np

from autograd import Tensor, cross_entropy
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


def test_gradcheck():
    np.random.seed(0)
    cfg = GPTConfig(vocab_size=11, block_size=8, n_layer=2, n_head=2, n_embd=16)
    model = GPT(cfg)
    B, T = 2, 6
    idx = np.random.randint(0, cfg.vocab_size, size=(B, T))
    targets = np.random.randint(0, cfg.vocab_size, size=(B, T))

    def loss_fn():
        _, loss = model.forward(idx, targets)
        return float(loss.data)

    # Analytic gradient via backprop.
    _, loss = model.forward(idx, targets)
    for p in model.parameters():
        p.grad = None
    loss.backward()

    # Check a few parameters against finite differences. We use a global L2
    # relative error rather than max-per-element: with float32 + finite
    # differences, entries whose true gradient is ~0 produce huge per-element
    # ratios that are pure numerical noise and say nothing about correctness.
    worst = 0.0
    for p in [model.head.weight, model.wte.weight, model.blocks[0].attn.qkv.weight,
              model.blocks[0].mlp.fc.weight, model.blocks[0].ln1.gamma, model.ln_f.beta]:
        ng = _numeric_grad(loss_fn, p)
        l2_rel = np.linalg.norm(ng - p.grad) / (np.linalg.norm(ng) + 1e-9)
        worst = max(worst, l2_rel)
    print(f"test_gradcheck: worst L2 relative error {worst:.2e}")
    assert worst < 1e-2, f"gradient check failed: {worst}"


if __name__ == "__main__":
    test_basic_ops()
    test_broadcast()
    test_gradcheck()
    print("all tests passed")
