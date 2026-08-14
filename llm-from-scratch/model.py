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

from backend import np, to_numpy  # numpy, or CuPy when LLM_BACKEND=cupy
import numpy as _hnp  # host-side numpy for sampling & RNG

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
    def generate(self, idx, max_new_tokens, temperature=1.0, top_k=None,
                 top_p=1.0, repetition_penalty=1.0, rng=None):
        """Autoregressively sample `max_new_tokens` tokens. idx: (1, T) int array.

        top_k / top_p (nucleus) restrict the candidate set; repetition_penalty
        (>1) discourages re-picking tokens already in the context, which stops a
        small model from collapsing into loops. Kept in sync with web/gpt.js.
        """
        # Sampling is host-side by design: the forward pass may run on the GPU
        # (CuPy backend), but the tiny per-token softmax/top-k/top-p math and
        # the RNG stay in plain numpy — to_numpy() is the device boundary.
        rng = rng or _hnp.random.default_rng()
        idx = _hnp.asarray(idx)
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.config.block_size:]
            logits, _ = self.forward(idx_cond)
            logits = to_numpy(logits.data)[:, -1, :].astype(_hnp.float64)  # (1, V)

            if repetition_penalty and repetition_penalty != 1.0:
                for tok in _hnp.unique(idx_cond[0]):
                    if logits[0, tok] > 0:
                        logits[0, tok] /= repetition_penalty
                    else:
                        logits[0, tok] *= repetition_penalty

            logits = logits / max(temperature, 1e-6)
            if top_k is not None:
                k = min(top_k, logits.shape[-1])
                kth = _hnp.sort(logits, axis=-1)[:, -k][:, None]
                logits = _hnp.where(logits < kth, -_hnp.inf, logits)
            probs = _softmax_np(logits)

            if top_p and top_p < 1.0:
                order = _hnp.argsort(probs[0])[::-1]
                cum = _hnp.cumsum(probs[0][order])
                keep = order[:max(1, int(_hnp.searchsorted(cum, top_p) + 1))]
                mask = _hnp.zeros_like(probs[0]); mask[keep] = 1.0
                probs = (probs * mask)
                probs = probs / probs.sum(axis=-1, keepdims=True)

            next_id = rng.choice(probs.shape[-1], p=probs[0])
            idx = _hnp.concatenate([idx, [[next_id]]], axis=1)
        return idx

    # --- checkpointing --------------------------------------------------------
    def state(self):
        return [p.data for p in self.parameters()]

    def load_state(self, arrays):
        for p, a in zip(self.parameters(), arrays):
            assert p.data.shape == a.shape, "checkpoint shape mismatch"
            p.data = np.asarray(a).astype(np.float32)  # host → active backend


def _softmax_np(x):
    x = x - x.max(axis=-1, keepdims=True)
    e = _hnp.exp(x)
    return e / e.sum(axis=-1, keepdims=True)
