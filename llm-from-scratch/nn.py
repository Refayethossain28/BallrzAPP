"""Neural-network building blocks, composed from the autograd primitives.

Each module is a small object with learnable `Tensor` parameters and a
`__call__` that runs the forward pass. Because everything is expressed through
the ops in `autograd.py`, backprop through these modules is automatic.
"""

from __future__ import annotations

import math

import numpy as np

from autograd import Tensor, softmax


class Module:
    """Base class: collects parameters from attributes for the optimizer."""

    def parameters(self):
        params = []
        for v in self.__dict__.values():
            if isinstance(v, Tensor):
                params.append(v)
            elif isinstance(v, Module):
                params.extend(v.parameters())
            elif isinstance(v, (list, tuple)):
                for item in v:
                    if isinstance(item, Module):
                        params.extend(item.parameters())
                    elif isinstance(item, Tensor):
                        params.append(item)
        return params

    def __call__(self, *args, **kwargs):
        return self.forward(*args, **kwargs)


class Linear(Module):
    def __init__(self, in_features, out_features, bias=True):
        # Kaiming-ish init keeps activations sane at the start of training.
        std = 1.0 / math.sqrt(in_features)
        self.weight = Tensor(np.random.randn(in_features, out_features).astype(np.float32) * std)
        self.bias = Tensor(np.zeros(out_features, dtype=np.float32)) if bias else None

    def forward(self, x: Tensor) -> Tensor:
        out = x @ self.weight
        if self.bias is not None:
            out = out + self.bias
        return out


class Embedding(Module):
    def __init__(self, num_embeddings, embedding_dim):
        self.weight = Tensor(np.random.randn(num_embeddings, embedding_dim).astype(np.float32) * 0.02)

    def forward(self, idx: np.ndarray) -> Tensor:
        from autograd import embedding

        return embedding(self.weight, idx)


class LayerNorm(Module):
    def __init__(self, dim, eps=1e-5):
        self.gamma = Tensor(np.ones(dim, dtype=np.float32))
        self.beta = Tensor(np.zeros(dim, dtype=np.float32))
        self.eps = eps

    def forward(self, x: Tensor) -> Tensor:
        mu = x.mean(axis=-1, keepdims=True)
        xc = x - mu
        var = (xc * xc).mean(axis=-1, keepdims=True)
        xn = xc / ((var + self.eps) ** 0.5)
        return xn * self.gamma + self.beta


def gelu(x: Tensor) -> Tensor:
    """Gaussian Error Linear Unit (tanh approximation), the GPT activation."""
    c = math.sqrt(2.0 / math.pi)
    return 0.5 * x * (1.0 + (c * (x + 0.044715 * (x ** 3))).tanh())


class CausalSelfAttention(Module):
    """Multi-head masked self-attention."""

    def __init__(self, n_embd, n_head, block_size):
        assert n_embd % n_head == 0
        self.n_head = n_head
        self.head_dim = n_embd // n_head
        self.qkv = Linear(n_embd, 3 * n_embd)
        self.proj = Linear(n_embd, n_embd)
        # Lower-triangular mask: position t may only attend to <= t.
        mask = np.tril(np.ones((block_size, block_size), dtype=np.float32))
        self.mask = (1.0 - mask) * -1e9  # 0 where allowed, -inf where not

    def forward(self, x: Tensor) -> Tensor:
        B, T, C = x.shape
        qkv = self.qkv(x)                      # (B, T, 3C)
        # Split into q, k, v: reshape, then move the qkv axis to the front.
        qkv = qkv.reshape(B, T, 3, self.n_head, self.head_dim)
        # Move to (3, B, n_head, T, head_dim)
        qkv = qkv.transpose(2, 0, 3, 1, 4)
        q = _take(qkv, 0)
        k = _take(qkv, 1)
        v = _take(qkv, 2)

        # Attention scores: (B, n_head, T, T)
        scale = 1.0 / math.sqrt(self.head_dim)
        att = (q @ k.transpose(0, 1, 3, 2)) * scale
        att = att + Tensor(self.mask[:T, :T])  # broadcast mask over batch/heads
        att = softmax(att, axis=-1)

        out = att @ v                          # (B, n_head, T, head_dim)
        out = out.transpose(0, 2, 1, 3).reshape(B, T, C)
        return self.proj(out)


def _take(t: Tensor, i: int) -> Tensor:
    """Index the leading axis of a Tensor (returns a graph-connected slice)."""
    out = Tensor(t.data[i], (t,), "take")

    def _backward():
        g = np.zeros_like(t.data)
        g[i] = out.grad
        from autograd import _acc

        t.grad = _acc(t.grad, g)

    out._backward = _backward
    return out


class MLP(Module):
    def __init__(self, n_embd):
        self.fc = Linear(n_embd, 4 * n_embd)
        self.proj = Linear(4 * n_embd, n_embd)

    def forward(self, x: Tensor) -> Tensor:
        return self.proj(gelu(self.fc(x)))


class Block(Module):
    """A transformer block: pre-norm attention + pre-norm MLP, with residuals."""

    def __init__(self, n_embd, n_head, block_size):
        self.ln1 = LayerNorm(n_embd)
        self.attn = CausalSelfAttention(n_embd, n_head, block_size)
        self.ln2 = LayerNorm(n_embd)
        self.mlp = MLP(n_embd)

    def forward(self, x: Tensor) -> Tensor:
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
        return x
