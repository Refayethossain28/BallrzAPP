"""Tokenizers: turn text into integer token ids and back.

Two implementations, both from scratch:

- `CharTokenizer`: one token per distinct character. Tiny vocab, zero training,
  but sequences are long and the model has to learn everything from characters.
- `BPETokenizer`: byte-pair encoding. Starts from characters and repeatedly
  merges the most frequent adjacent pair into a new token, learning a subword
  vocabulary. Fewer tokens per sentence and more meaningful units, which is what
  real LLMs use.

`load_tokenizer(json_str)` reconstructs whichever one a checkpoint was saved
with, so `sample.py` / `chat.py` don't need to know which you trained.
"""

from __future__ import annotations

import json
import re
from collections import Counter

# Split text into runs of whitespace and runs of non-whitespace. BPE merges
# happen *within* these chunks, so tokens never span a word boundary.
_SPLIT_RE = re.compile(r"\s+|\S+")


class CharTokenizer:
    def __init__(self, chars):
        self.chars = list(chars)
        self.stoi = {ch: i for i, ch in enumerate(self.chars)}
        self.itos = {i: ch for i, ch in enumerate(self.chars)}

    @property
    def vocab_size(self):
        return len(self.chars)

    @classmethod
    def from_text(cls, text):
        return cls(sorted(set(text)))

    def encode(self, text):
        return [self.stoi[c] for c in text if c in self.stoi]

    def decode(self, ids):
        return "".join(self.itos[int(i)] for i in ids if int(i) in self.itos)

    def to_json(self):
        return json.dumps({"type": "char", "chars": self.chars})

    @classmethod
    def from_json(cls, s):
        return cls(json.loads(s)["chars"])


def _merge_syms(syms, pair, new_tok):
    """Replace every adjacent occurrence of `pair` in `syms` with `new_tok`."""
    out = []
    i = 0
    n = len(syms)
    while i < n:
        if i < n - 1 and syms[i] == pair[0] and syms[i + 1] == pair[1]:
            out.append(new_tok)
            i += 2
        else:
            out.append(syms[i])
            i += 1
    return out


class BPETokenizer:
    def __init__(self, vocab, merges):
        self.vocab = list(vocab)                       # id -> token string
        self.stoi = {t: i for i, t in enumerate(self.vocab)}
        self.itos = {i: t for i, t in enumerate(self.vocab)}
        self.merges = [tuple(m) for m in merges]       # ordered list of (a, b)
        self.merge_rank = {pair: i for i, pair in enumerate(self.merges)}
        self._cache = {}

    @property
    def vocab_size(self):
        return len(self.vocab)

    @classmethod
    def train(cls, text, vocab_size=512):
        """Learn a BPE vocabulary of (up to) `vocab_size` tokens from `text`."""
        vocab = sorted(set(text))                      # base vocab = characters
        # Work on unique chunks weighted by frequency -- far faster than scanning
        # the whole corpus on every merge.
        chunk_freq = Counter(_SPLIT_RE.findall(text))
        chunk_syms = {c: list(c) for c in chunk_freq}
        merges = []

        while len(vocab) < vocab_size:
            # Count every adjacent pair across the corpus.
            pairs = Counter()
            for chunk, freq in chunk_freq.items():
                syms = chunk_syms[chunk]
                for a, b in zip(syms, syms[1:]):
                    pairs[(a, b)] += freq
            if not pairs:
                break
            best = max(pairs, key=pairs.get)
            if pairs[best] < 2:                        # no repeated pair left
                break
            new_tok = best[0] + best[1]
            merges.append([best[0], best[1]])
            vocab.append(new_tok)
            for chunk in chunk_syms:
                chunk_syms[chunk] = _merge_syms(chunk_syms[chunk], best, new_tok)

        return cls(vocab, merges)

    def _encode_chunk(self, chunk):
        if chunk in self._cache:
            return self._cache[chunk]
        syms = list(chunk)
        while len(syms) >= 2:
            # Apply the highest-priority (lowest-rank) learned merge present.
            best, best_rank = None, None
            for a, b in zip(syms, syms[1:]):
                r = self.merge_rank.get((a, b))
                if r is not None and (best_rank is None or r < best_rank):
                    best, best_rank = (a, b), r
            if best is None:
                break
            syms = _merge_syms(syms, best, best[0] + best[1])
        ids = [self.stoi[s] for s in syms if s in self.stoi]
        self._cache[chunk] = ids
        return ids

    def encode(self, text):
        ids = []
        for chunk in _SPLIT_RE.findall(text):
            ids.extend(self._encode_chunk(chunk))
        return ids

    def decode(self, ids):
        return "".join(self.itos[int(i)] for i in ids if int(i) in self.itos)

    def to_json(self):
        return json.dumps({"type": "bpe", "vocab": self.vocab, "merges": self.merges})

    @classmethod
    def from_json(cls, s):
        d = json.loads(s)
        return cls(d["vocab"], d["merges"])


def load_tokenizer(s):
    """Rebuild a tokenizer from its JSON, dispatching on the saved type."""
    kind = json.loads(s).get("type", "char")
    return BPETokenizer.from_json(s) if kind == "bpe" else CharTokenizer.from_json(s)
