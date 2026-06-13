"""The GPT language model: a decoder-only transformer.

Architecture (same family as GPT-2, just small):
    token embedding + positional embedding
      -> N transformer blocks (causal self-attention + MLP)
      -> final layernorm
      -> linear head projecting to vocabulary logits

Everything is assembled from `nn.py`, which is in turn built on the autograd
engine in `autograd.py`. There is no deep-learning framework underneath.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from autograd import Tensor, cross_entropy
from nn import Block, Embedding, LayerNorm, Linear, Module


@dataclass
class GPTConfig:
    vocab_size: int = 256
    block_size: int = 64       # max context length (tokens)
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 128

    def to_dict(self):
        return {
            "vocab_size": self.vocab_size,
            "block_size": self.block_size,
            "n_layer": self.n_layer,
            "n_head": self.n_head,
            "n_embd": self.n_embd,
        }


class GPT(Module):
    def __init__(self, config: GPTConfig):
        self.config = config
        self.wte = Embedding(config.vocab_size, config.n_embd)   # token embeddings
        self.wpe = Embedding(config.block_size, config.n_embd)   # position embeddings
        self.blocks = [
            Block(config.n_embd, config.n_head, config.block_size)
            for _ in range(config.n_layer)
        ]
        self.ln_f = LayerNorm(config.n_embd)
        self.head = Linear(config.n_embd, config.vocab_size, bias=False)

    def parameters(self):
        params = self.wte.parameters() + self.wpe.parameters()
        for b in self.blocks:
            params += b.parameters()
        params += self.ln_f.parameters() + self.head.parameters()
        return params

    def forward(self, idx: np.ndarray, targets: np.ndarray | None = None):
        """idx: int array (B, T). Returns (logits, loss-or-None)."""
        B, T = idx.shape
        assert T <= self.config.block_size, "sequence longer than block size"

        pos = np.arange(T)
        x = self.wte(idx) + self.wpe(pos)       # (B, T, n_embd), pos broadcasts over batch
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        logits = self.head(x)                   # (B, T, vocab_size)

        loss = None
        if targets is not None:
            V = self.config.vocab_size
            loss = cross_entropy(logits.reshape(B * T, V), targets.reshape(B * T))
        return logits, loss

    # --- inference ------------------------------------------------------------
    def generate(self, idx, max_new_tokens, temperature=1.0, top_k=None, rng=None):
        """Autoregressively sample `max_new_tokens` tokens. idx: (1, T) int array."""
        rng = rng or np.random.default_rng()
        idx = np.asarray(idx)
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.config.block_size:]
            logits, _ = self.forward(idx_cond)
            logits = logits.data[:, -1, :] / max(temperature, 1e-6)  # (1, V)
            if top_k is not None:
                k = min(top_k, logits.shape[-1])
                kth = np.sort(logits, axis=-1)[:, -k][:, None]
                logits = np.where(logits < kth, -np.inf, logits)
            probs = _softmax_np(logits)
            next_id = rng.choice(probs.shape[-1], p=probs[0])
            idx = np.concatenate([idx, [[next_id]]], axis=1)
        return idx

    # --- checkpointing --------------------------------------------------------
    def state(self):
        return [p.data for p in self.parameters()]

    def load_state(self, arrays):
        for p, a in zip(self.parameters(), arrays):
            assert p.data.shape == a.shape, "checkpoint shape mismatch"
            p.data = a.astype(np.float32)


def _softmax_np(x):
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)
