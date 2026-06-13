"""Tests for the tokenizers: encode/decode must round-trip exactly."""

from __future__ import annotations

from tokenizer import BPETokenizer, CharTokenizer, load_tokenizer

SAMPLE = "The game gives back exactly what you put in, and it keeps perfect books.\n"


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


if __name__ == "__main__":
    test_char_roundtrip()
    test_bpe_roundtrip()
    print("all tokenizer tests passed")
