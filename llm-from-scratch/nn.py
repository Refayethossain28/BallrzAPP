"""Neural-network building blocks, composed from the autograd primitives.

Each module is a small object with learnable `Tensor` parameters and a
`__call__` that runs the forward pass. Because everything is expressed through
the ops in `autograd.py`, backprop through these modules is automatic.

Two block flavours live here, selected by the model config:

* **v1 (GPT-2 style)**: learned positional embeddings, LayerNorm, a GELU MLP,
  biases everywhere, a separate output head. This is what every previously
  trained ApexAI model uses, and it still loads and runs unchanged.
* **v2 (Llama style)**: rotary position embeddings (RoPE) inside attention,
  RMSNorm, a SwiGLU MLP, no biases, and the token embedding reused as the
  output head. Same parameter budget, measurably lower loss — see README.
"""

from __future__ import annotations

import math

from backend import np  # numpy, or CuPy when LLM_BACKEND=cupy

from autograd import (Tensor, gelu, layernorm, rmsnorm, rope, rope_tables,
                      silu, softmax, unbind)


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
    def __init__(self, in_features, out_features, bias=True, std=0.02):
        # GPT-2's init: small normal weights, zero biases. (The residual-stream
        # projections are additionally scaled down by the model, see model.py.)
        self.weight = Tensor(np.random.randn(in_features, out_features).astype(np.float32) * std)
        self.bias = Tensor(np.zeros(out_features, dtype=np.float32)) if bias else None

    def forward(self, x: Tensor) -> Tensor:
        # Flatten leading dims so a (B, T, C) input is ONE (B*T, C) @ (C, O)
        # BLAS call instead of B small ones (and one transposed call in backward).
        shape = x.shape
        if len(shape) > 2:
            x = x.reshape(-1, shape[-1])
        out = x @ self.weight
        if self.bias is not None:
            out = out + self.bias
        if len(shape) > 2:
            out = out.reshape(*shape[:-1], self.weight.shape[1])
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
        return layernorm(x, self.gamma, self.beta, self.eps)


class RMSNorm(Module):
    """Llama's normaliser: scale only, no centring, no bias — one parameter vector."""

    def __init__(self, dim, eps=1e-5):
        self.gamma = Tensor(np.ones(dim, dtype=np.float32))
        self.eps = eps

    def forward(self, x: Tensor) -> Tensor:
        return rmsnorm(x, self.gamma, self.eps)


def make_norm(kind, dim):
    return RMSNorm(dim) if kind == "rmsnorm" else LayerNorm(dim)


class CausalSelfAttention(Module):
    """Multi-head masked self-attention, optionally with rotary positions."""

    def __init__(self, n_embd, n_head, block_size, bias=True, use_rope=False, rope_theta=10000.0):
        assert n_embd % n_head == 0
        self.n_head = n_head
        self.head_dim = n_embd // n_head
        self.qkv = Linear(n_embd, 3 * n_embd, bias=bias)
        self.proj = Linear(n_embd, n_embd, bias=bias)
        # Lower-triangular mask: position t may only attend to <= t.
        mask = np.tril(np.ones((block_size, block_size), dtype=np.float32))
        self.mask = (1.0 - mask) * -1e9  # 0 where allowed, -inf where not
        self.use_rope = use_rope
        if use_rope:
            assert self.head_dim % 2 == 0, "RoPE needs an even head_dim"
            self.rope_cos, self.rope_sin = rope_tables(block_size, self.head_dim, rope_theta)

    def forward(self, x: Tensor) -> Tensor:
        B, T, C = x.shape
        qkv = self.qkv(x)                      # (B, T, 3C)
        # Split into q, k, v: reshape, then move the qkv axis to the front.
        qkv = qkv.reshape(B, T, 3, self.n_head, self.head_dim)
        # Move to (3, B, n_head, T, head_dim)
        qkv = qkv.transpose(2, 0, 3, 1, 4)
        q, k, v = unbind(qkv, axis=0)

        if self.use_rope:
            # Rotate q and k by their position: attention then depends on the
            # RELATIVE distance between tokens, with no position table to learn.
            cos, sin = self.rope_cos[:T], self.rope_sin[:T]
            q = rope(q, cos, sin)
            k = rope(k, cos, sin)

        # Attention scores: (B, n_head, T, T). The 1/sqrt(d) scale goes on q
        # (B, n_head, T, d) — eight-plus times smaller than the score map — and
        # the causal mask is folded into the fused softmax, so no full-size
        # temporaries are made just to scale and mask.
        q = q * (1.0 / math.sqrt(self.head_dim))
        att = q @ k.transpose(0, 1, 3, 2)
        att = softmax(att, axis=-1, mask=self.mask[:T, :T])  # mask broadcasts over batch/heads

        out = att @ v                          # (B, n_head, T, head_dim)
        out = out.transpose(0, 2, 1, 3).reshape(B, T, C)
        return self.proj(out)


class MLP(Module):
    """The GPT-2 feed-forward: expand 4x, GELU, project back."""

    def __init__(self, n_embd, hidden=None, bias=True):
        hidden = hidden or 4 * n_embd
        self.fc = Linear(n_embd, hidden, bias=bias)
        self.proj = Linear(hidden, n_embd, bias=bias)

    def forward(self, x: Tensor) -> Tensor:
        return self.proj(gelu(self.fc(x)))

    @property
    def out_proj(self):
        return self.proj


class SwiGLU(Module):
    """The Llama feed-forward: down(silu(gate(x)) * up(x)).

    Three matrices instead of two, so the hidden width is 8/3·d (rounded up to
    a multiple of 32) to keep the parameter count equal to the GELU MLP's.
    """

    def __init__(self, n_embd, hidden=None, bias=False):
        hidden = hidden or swiglu_hidden(n_embd)
        self.gate = Linear(n_embd, hidden, bias=bias)
        self.up = Linear(n_embd, hidden, bias=bias)
        self.down = Linear(hidden, n_embd, bias=bias)

    def forward(self, x: Tensor) -> Tensor:
        return self.down(silu(self.gate(x)) * self.up(x))

    @property
    def out_proj(self):
        return self.down


def swiglu_hidden(n_embd):
    return int(math.ceil((8.0 * n_embd / 3.0) / 32.0) * 32)


class Block(Module):
    """A transformer block: pre-norm attention + pre-norm MLP, with residuals."""

    def __init__(self, n_embd, n_head, block_size, norm="layernorm", mlp="gelu",
                 bias=True, use_rope=False, rope_theta=10000.0, mlp_hidden=None):
        self.ln1 = make_norm(norm, n_embd)
        self.attn = CausalSelfAttention(n_embd, n_head, block_size, bias=bias,
                                        use_rope=use_rope, rope_theta=rope_theta)
        self.ln2 = make_norm(norm, n_embd)
        self.mlp = (SwiGLU(n_embd, mlp_hidden, bias=bias) if mlp == "swiglu"
                    else MLP(n_embd, mlp_hidden, bias=bias))

    def forward(self, x: Tensor) -> Tensor:
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
        return x
