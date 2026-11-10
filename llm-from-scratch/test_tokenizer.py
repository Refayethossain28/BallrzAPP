"""Tests for the tokenizers: encode/decode must round-trip exactly, and the
incremental BPE trainer must make exactly the merges the textbook one makes."""

from __future__ import annotations

import os
import re
import time

from tokenizer import BPETokenizer, CharTokenizer, load_tokenizer

SAMPLE = "The game gives back exactly what you put in, and it keeps perfect books.\n"

# Heavy whitespace runs: double spaces, blank lines, tab pairs, and growing
# multi-space indentation, so whitespace chunks get merged too.
WHITESPACE = ("a  b\n\n  c\t\td " * 40) + "".join(
    " " * (2 * k) + "indented line\n" for k in range(1, 6))

# Accented letters, an em dash, and an emoji that is a surrogate pair in JS /
# JSON, mixed with multi-space runs, tabs and newlines.
UNICODE = ("café naïve — ünïcode 😀\n"
           "  two  spaces\tand\t\ttabs\n\n"
           "    indented 😀 café\n")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_ALL_WS = re.compile(r"\s+")
_ALL_NON_WS = re.compile(r"\S+")


def _read_data(name, limit=None):
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
        text = f.read()
    return text if limit is None else text[:limit]


def _assert_same_training(text, vocab_size):
    """Train both ways and insist on identical merges (order included) and vocab."""
    fast = BPETokenizer.train(text, vocab_size=vocab_size)
    slow = BPETokenizer._train_reference(text, vocab_size=vocab_size)
    assert fast.merges == slow.merges, "incremental trainer diverged from reference merges"
    assert fast.vocab == slow.vocab, "incremental trainer diverged from reference vocab"
    return fast


def test_char_roundtrip():
    tok = CharTokenizer.from_text(SAMPLE)
    assert tok.decode(tok.encode(SAMPLE)) == SAMPLE
    assert load_tokenizer(tok.to_json()).decode(tok.encode(SAMPLE)) == SAMPLE
    print("test_char_roundtrip: ok")


def test_bpe_roundtrip():
    text = SAMPLE * 20  # enough repetition for merges to form
    tok = BPETokenizer.train(text, vocab_size=120)
    assert tok.decode(tok.encode(SAMPLE)) == SAMPLE
    # BPE should compress vs raw characters.
    assert len(tok.encode(text)) < len(text)
    # Survives serialization through the generic loader.
    loaded = load_tokenizer(tok.to_json())
    assert isinstance(loaded, BPETokenizer)
    assert loaded.decode(loaded.encode(SAMPLE)) == SAMPLE
    print(f"test_bpe_roundtrip: ok (vocab {tok.vocab_size}, "
          f"{len(SAMPLE)} chars -> {len(tok.encode(SAMPLE))} tokens)")


def test_bpe_matches_reference_sample():
    tok = _assert_same_training(SAMPLE * 20, 120)
    assert len(tok.merges) > 0
    print(f"test_bpe_matches_reference_sample: ok ({len(tok.merges)} merges)")


def test_bpe_matches_reference_microcopy():
    text = _read_data("microcopy.txt", limit=200_000)
    tok = _assert_same_training(text, 400)
    assert tok.vocab_size == 400
    print(f"test_bpe_matches_reference_microcopy: ok ({len(tok.merges)} merges)")


def test_bpe_matches_reference_whitespace():
    tok = _assert_same_training(WHITESPACE, 80)
    # The whitespace runs must have produced multi-character whitespace tokens.
    assert any(len(t) > 1 and t.isspace() for t in tok.vocab)
    print(f"test_bpe_matches_reference_whitespace: ok ({len(tok.merges)} merges)")


def test_bpe_stop_conditions():
    # Empty text, vocab already reached, and nothing repeated: both trainers
    # must stop in the same place with the same (possibly empty) merges.
    for text, size in [("", 10), ("abab", 2), ("abcdef", 100), ("ab ab", 100)]:
        _assert_same_training(text, size)
    assert BPETokenizer.train("", 10).vocab == []
    assert BPETokenizer.train("abcdef", 100).merges == []     # no pair repeats
    assert BPETokenizer.train("abab", 2).merges == []         # base vocab fills it
    print("test_bpe_stop_conditions: ok")


def test_bpe_roundtrip_unicode_whitespace():
    text = UNICODE * 10 + WHITESPACE
    tok = BPETokenizer.train(text, vocab_size=96)
    loaded = load_tokenizer(tok.to_json())
    assert "😀" in loaded.vocab                       # survives the JSON escape
    # Strings whose characters all appear in the training text round-trip
    # exactly, including ones that re-combine the training text in new ways.
    for s in [text, UNICODE, WHITESPACE, "café  😀\t\tnaïve\n\n—",
              "😀😀 ünïcode", "   \n\t  ", "\t\t\t\td  c"]:
        assert set(s) <= set(text)
        assert tok.decode(tok.encode(s)) == s
        assert loaded.decode(loaded.encode(s)) == s
    print("test_bpe_roundtrip_unicode_whitespace: ok")


def test_bpe_tokens_respect_whitespace_boundary():
    text = _read_data("microcopy.txt", limit=50_000) + WHITESPACE + UNICODE * 5
    tok = BPETokenizer.train(text, vocab_size=300)

    def is_clean(t):
        return bool(_ALL_WS.fullmatch(t) or _ALL_NON_WS.fullmatch(t))

    # No learned token mixes whitespace and non-whitespace ...
    assert all(is_clean(t) for t in tok.vocab)
    # ... and neither does any token the encoder actually emits.
    assert all(is_clean(tok.itos[i]) for i in tok.encode(text))
    print("test_bpe_tokens_respect_whitespace_boundary: ok")


def test_bpe_train_speed():
    # Regression guard for the incremental trainer: the naive recount-everything
    # loop took tens of seconds here; the bound is deliberately loose.
    text = _read_data("microcopy.txt") + _read_data("names.txt")
    t0 = time.perf_counter()
    tok = BPETokenizer.train(text, vocab_size=1024)
    dt = time.perf_counter() - t0
    assert tok.decode(tok.encode(text[:5000])) == text[:5000]
    assert dt < 20.0, f"BPE training took {dt:.1f}s"
    print(f"test_bpe_train_speed: ok ({len(text)} chars -> vocab {tok.vocab_size} "
          f"in {dt:.2f}s)")


if __name__ == "__main__":
    test_char_roundtrip()
    test_bpe_roundtrip()
    test_bpe_matches_reference_sample()
    test_bpe_matches_reference_microcopy()
    test_bpe_matches_reference_whitespace()
    test_bpe_stop_conditions()
    test_bpe_roundtrip_unicode_whitespace()
    test_bpe_tokens_respect_whitespace_boundary()
    test_bpe_train_speed()
    print("all tokenizer tests passed")
