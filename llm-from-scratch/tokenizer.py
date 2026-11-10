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

import heapq
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


def _best_pair(pair_counts):
    """The pair to merge next: highest count, ties broken by the lexicographically
    smallest (a, b). The tie-break has to be explicit -- "whichever the Counter
    saw first" depends on iteration order, and the incremental trainer and the
    reference trainer only agree merge-for-merge if they break ties the same way.
    """
    return min(pair_counts, key=lambda p: (-pair_counts[p], p))


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
        """Learn a BPE vocabulary of (up to) `vocab_size` tokens from `text`.

        This is the incremental version of the textbook algorithm; the textbook
        one is `_train_reference` below and the two produce identical results.

        The textbook loop recounts every adjacent pair in every chunk after every
        merge -- O(unique chunks x merges) Python work, which is minutes on a
        few-MB corpus. But merging (a, b) into "ab" only rewrites the symbols of
        chunks that actually contain a followed by b; every other chunk is
        untouched, so every pair count that comes from it is untouched too. So
        instead of recounting we keep two structures up to date:

          pair_counts  (a, b) -> adjacent occurrences across the corpus, each
                       weighted by how often its chunk occurs
          pair_index   (a, b) -> ids of the chunks that contain (a, b)

        After picking the best pair we walk only the chunks in its index set.
        Each occurrence `... p a b n ...` becoming `... p ab n ...` destroys the
        pairs (p, a), (a, b), (b, n) and creates (p, ab), (ab, n), so we apply
        exactly those deltas (times the chunk's frequency) and splice the chunk
        in place. Nothing else in the corpus can have changed.

        The index is allowed to go stale in one direction: when a *different*
        merge breaks (a, b) inside a chunk we don't bother removing the chunk
        from (a, b)'s set, we just find no occurrence when we eventually walk
        it. The set is still a superset of the chunks that contain the pair,
        which is all correctness needs.

        Picking the best pair is a min-heap of (-count, pair) with lazy
        invalidation: a count change pushes a fresh entry and the old one is
        discarded when it reaches the top and no longer matches `pair_counts`.
        Every live pair always has one entry with its current count, so the
        first entry that does match is the true maximum, with ties broken on the
        lexicographically smallest (a, b) exactly as `_best_pair` does.
        """
        vocab = sorted(set(text))                      # base vocab = characters
        # Work on unique chunks weighted by frequency -- far faster than scanning
        # the whole corpus. Chunks get small integer ids so the index sets are
        # cheap.
        chunk_freq = Counter(_SPLIT_RE.findall(text))
        words = [list(c) for c in chunk_freq]          # chunk id -> symbols
        freqs = list(chunk_freq.values())              # chunk id -> occurrences
        merges = []

        pair_counts = {}
        pair_index = {}
        for cid, syms in enumerate(words):
            f = freqs[cid]
            for pair in zip(syms, syms[1:]):
                pair_counts[pair] = pair_counts.get(pair, 0) + f
                s = pair_index.get(pair)
                if s is None:
                    pair_index[pair] = {cid}
                else:
                    s.add(cid)
        heap = [(-c, p) for p, c in pair_counts.items()]
        heapq.heapify(heap)

        while len(vocab) < vocab_size:
            # Drop stale heap entries until the top one is current.
            while heap and pair_counts.get(heap[0][1], 0) != -heap[0][0]:
                heapq.heappop(heap)
            if not heap:
                break                                  # no pairs left at all
            neg_count, best = heapq.heappop(heap)
            if -neg_count < 2:                         # no repeated pair left
                break
            a, b = best
            new_tok = a + b
            merges.append([a, b])
            vocab.append(new_tok)

            # Net count change per pair for this merge. Accumulated and applied
            # once at the end so each changed pair gets one heap push, and so a
            # pair that is both created and destroyed by this merge (e.g. (ab, a)
            # in "abab") nets to zero instead of getting a bogus entry.
            delta = {}
            for cid in pair_index.pop(best):
                syms = words[cid]
                f = freqs[cid]
                i, n = 0, len(syms)
                while i < n - 1:
                    if syms[i] == a and syms[i + 1] == b:
                        if i > 0:
                            prev = syms[i - 1]
                            delta[(prev, a)] = delta.get((prev, a), 0) - f
                            delta[(prev, new_tok)] = delta.get((prev, new_tok), 0) + f
                            s = pair_index.get((prev, new_tok))
                            if s is None:
                                pair_index[(prev, new_tok)] = {cid}
                            else:
                                s.add(cid)
                        if i + 2 < n:
                            nxt = syms[i + 2]
                            delta[(b, nxt)] = delta.get((b, nxt), 0) - f
                            delta[(new_tok, nxt)] = delta.get((new_tok, nxt), 0) + f
                            s = pair_index.get((new_tok, nxt))
                            if s is None:
                                pair_index[(new_tok, nxt)] = {cid}
                            else:
                                s.add(cid)
                        # Same greedy left-to-right, non-overlapping replacement
                        # as _merge_syms: splice and continue after the new token.
                        syms[i:i + 2] = [new_tok]
                        n -= 1
                    i += 1
            # Every occurrence of the merged pair is gone, and the merge cannot
            # create a new one (a + b == b is impossible), so it leaves the table.
            del pair_counts[best]
            for pair, d in delta.items():
                if d == 0:
                    continue
                c = pair_counts.get(pair, 0) + d
                if c > 0:
                    pair_counts[pair] = c
                    heapq.heappush(heap, (-c, pair))
                else:
                    pair_counts.pop(pair, None)
                    pair_index.pop(pair, None)

        return cls(vocab, merges)

    @classmethod
    def _train_reference(cls, text, vocab_size=512):
        """The textbook BPE trainer: recount every pair after every merge.

        Far too slow for real corpora; it exists so the tests can check that the
        incremental `train` above makes exactly the same merges in exactly the
        same order. Keep the stopping rules and tie-break identical to `train`.
        """
        vocab = sorted(set(text))                      # base vocab = characters
        chunk_freq = Counter(_SPLIT_RE.findall(text))
        chunk_syms = {c: list(c) for c in chunk_freq}
        merges = []

        while len(vocab) < vocab_size:
            # Count every adjacent pair across the corpus.
            pairs = Counter()
            for chunk, freq in chunk_freq.items():
                syms = chunk_syms[chunk]
                for pair in zip(syms, syms[1:]):
                    pairs[pair] += freq
            if not pairs:
                break                                  # no pairs left at all
            best = _best_pair(pairs)
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
