"""The GPT language model: a decoder-only transformer.

Architecture (same family as GPT-2 / Llama, just small):
    token embedding (+ positional embedding, or rotary positions in attention)
      -> N transformer blocks (causal self-attention + MLP)
      -> final norm
      -> linear head projecting to vocabulary logits (or the token embedding
         transposed, when the two are tied)

Everything is assembled from `nn.py`, which is in turn built on the autograd
engine in `autograd.py`. There is no deep-learning framework underneath.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from backend import np, to_numpy  # numpy, or CuPy when LLM_BACKEND=cupy
import numpy as _hnp  # host-side numpy for sampling & RNG

from autograd import Tensor, cross_entropy, no_grad
from nn import Block, Embedding, Linear, Module, make_norm, swiglu_hidden


@dataclass
class GPTConfig:
    vocab_size: int = 256
    block_size: int = 64       # max context length (tokens)
    n_layer: int = 4
    n_head: int = 4
    n_embd: int = 128
    # --- architecture switches. The defaults are the original (v1, GPT-2 style)
    # model, so every checkpoint and model.json trained before these existed
    # loads unchanged. `--arch v2` in train.py flips all of them to Llama style.
    pos_emb: str = "learned"       # "learned" table | "rope" (rotary, in attention)
    norm: str = "layernorm"        # "layernorm" | "rmsnorm"
    mlp: str = "gelu"              # "gelu" (fc/proj, 4x) | "swiglu" (gate/up/down, 8/3x)
    tie_embeddings: bool = False   # reuse wte as the output head
    bias: bool = True              # biases on the linear layers
    rope_theta: float = 10000.0
    mlp_hidden: int = 0            # 0 = default width for the mlp kind

    V2 = dict(pos_emb="rope", norm="rmsnorm", mlp="swiglu", tie_embeddings=True, bias=False)

    def __post_init__(self):
        assert self.pos_emb in ("learned", "rope"), self.pos_emb
        assert self.norm in ("layernorm", "rmsnorm"), self.norm
        assert self.mlp in ("gelu", "swiglu"), self.mlp
        if not self.mlp_hidden:
            self.mlp_hidden = swiglu_hidden(self.n_embd) if self.mlp == "swiglu" else 4 * self.n_embd

    @property
    def arch(self):
        """'v1' / 'v2' when the switches match a named recipe, else 'custom'."""
        v2 = all(getattr(self, k) == v for k, v in self.V2.items())
        v1 = (self.pos_emb == "learned" and self.norm == "layernorm" and self.mlp == "gelu"
              and not self.tie_embeddings and self.bias)
        return "v2" if v2 else ("v1" if v1 else "custom")

    def to_dict(self):
        return {
            "vocab_size": self.vocab_size,
            "block_size": self.block_size,
            "n_layer": self.n_layer,
            "n_head": self.n_head,
            "n_embd": self.n_embd,
            "pos_emb": self.pos_emb,
            "norm": self.norm,
            "mlp": self.mlp,
            "tie_embeddings": self.tie_embeddings,
            "bias": self.bias,
            "rope_theta": self.rope_theta,
            "mlp_hidden": self.mlp_hidden,
        }

    @classmethod
    def from_dict(cls, d):
        """Build from a saved dict, ignoring keys this version doesn't know."""
        known = {k: v for k, v in dict(d).items() if k in cls.__dataclass_fields__}
        return cls(**known)


class GPT(Module):
    def __init__(self, config: GPTConfig):
        self.config = config
        self.wte = Embedding(config.vocab_size, config.n_embd)   # token embeddings
        self.wpe = (Embedding(config.block_size, config.n_embd)  # position embeddings (v1)
                    if config.pos_emb == "learned" else None)
        self.blocks = [
            Block(config.n_embd, config.n_head, config.block_size,
                  norm=config.norm, mlp=config.mlp, bias=config.bias,
                  use_rope=(config.pos_emb == "rope"), rope_theta=config.rope_theta,
                  mlp_hidden=config.mlp_hidden)
            for _ in range(config.n_layer)
        ]
        self.ln_f = make_norm(config.norm, config.n_embd)
        self.head = (None if config.tie_embeddings
                     else Linear(config.n_embd, config.vocab_size, bias=False))
        # GPT-2's residual-stream init: the two projections that write into the
        # residual stream are scaled by 1/sqrt(2·n_layer) so the stream's
        # variance doesn't grow with depth. Pure init — no effect on loading.
        s = 1.0 / math.sqrt(2 * config.n_layer)
        for b in self.blocks:
            b.attn.proj.weight.data *= s
            b.mlp.out_proj.weight.data *= s

    def parameters(self):
        params = self.wte.parameters()
        if self.wpe is not None:
            params += self.wpe.parameters()
        for b in self.blocks:
            params += b.parameters()
        params += self.ln_f.parameters()
        if self.head is not None:
            params += self.head.parameters()
        return params

    def decay_parameters(self):
        """The weights AdamW should decay: matrices (embeddings, linears) — not
        the 1-D norm gains and biases, which decay would only pull toward zero
        for no benefit."""
        return [p for p in self.parameters() if p.data.ndim >= 2]

    def num_params(self):
        return sum(int(p.data.size) for p in self.parameters())

    def forward(self, idx: np.ndarray, targets: np.ndarray | None = None):
        """idx: int array (B, T). Returns (logits, loss-or-None)."""
        B, T = idx.shape
        assert T <= self.config.block_size, "sequence longer than block size"

        x = self.wte(idx)                                   # (B, T, n_embd)
        if self.wpe is not None:
            x = x + self.wpe(np.arange(T))                  # pos broadcasts over batch
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        if self.head is not None:
            logits = self.head(x)                           # (B, T, vocab_size)
        else:
            # Tied head: the same matrix that turns a token into a vector turns
            # a vector back into token scores (one less V×d matrix to ship).
            V = self.config.vocab_size
            logits = (x.reshape(B * T, self.config.n_embd) @ self.wte.weight.transpose()).reshape(B, T, V)

        loss = None
        if targets is not None:
            V = self.config.vocab_size
            loss = cross_entropy(logits.reshape(B * T, V), targets.reshape(B * T))
        return logits, loss

    # --- inference ------------------------------------------------------------
    @staticmethod
    def crop_window(window, block_size):
        """The context policy shared with web/gpt.js: once more than block_size
        tokens are in play, keep the newest 3/4 (the token just added included)
        and carry on. The browser rebuilds its KV cache over exactly this
        window, so both engines see the same context at every step."""
        if len(window) > block_size:
            keep = block_size - max(1, block_size // 4)
            return window[-keep:]
        return window

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
        B = self.config.block_size
        window = [int(t) for t in idx[0][-B:]]
        for _ in range(max_new_tokens):
            window = self.crop_window(window, B)
            idx_cond = _hnp.asarray([window])
            with no_grad():
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
                nucleus = order[:max(1, int(_hnp.searchsorted(cum, top_p) + 1))]
                mask = _hnp.zeros_like(probs[0]); mask[nucleus] = 1.0
                probs = (probs * mask)
                probs = probs / probs.sum(axis=-1, keepdims=True)

            next_id = rng.choice(probs.shape[-1], p=probs[0])
            idx = _hnp.concatenate([idx, [[next_id]]], axis=1)
            window.append(int(next_id))
        return idx

    # --- checkpointing --------------------------------------------------------
    def state(self):
        return [p.data for p in self.parameters()]

    def load_state(self, arrays):
        arrays = list(arrays)
        params = self.parameters()
        assert len(params) == len(arrays), (
            f"checkpoint has {len(arrays)} tensors, model expects {len(params)} "
            f"(architecture mismatch: {self.config.to_dict()})")
        for p, a in zip(params, arrays):
            assert p.data.shape == a.shape, "checkpoint shape mismatch"
            p.data = np.asarray(a).astype(np.float32)  # host → active backend


def _softmax_np(x):
    x = x - x.max(axis=-1, keepdims=True)
    e = _hnp.exp(x)
    return e / e.sum(axis=-1, keepdims=True)
