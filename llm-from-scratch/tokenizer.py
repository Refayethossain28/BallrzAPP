"""A character-level tokenizer.

The simplest tokenizer that works: every distinct character in the training
text becomes one token id. Small vocab, no external dependencies, and you can
read the model's raw output directly. (A real LLM would use byte-pair encoding;
the architecture in `model.py` is agnostic to which tokenizer you plug in.)
"""

from __future__ import annotations

import json


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
        return "".join(self.itos[int(i)] for i in ids)

    def to_json(self):
        return json.dumps({"chars": self.chars})

    @classmethod
    def from_json(cls, s):
        return cls(json.loads(s)["chars"])
