"""Helpers to assemble a bigger training corpus.

Commands:
    # Download "tiny Shakespeare" (~1 MB) to data/shakespeare.txt
    python fetch_data.py shakespeare

    # Download Norvig's big.txt (~6.5 MB of public-domain English prose:
    # Sherlock Holmes, War and Peace, a US history, ...) — with the Project
    # Gutenberg licence boilerplate stripped — to data/big.txt
    python fetch_data.py big

    # Strip Gutenberg boilerplate from any text you already have
    python fetch_data.py clean raw.txt data/clean.txt

    # The "classics" mix the shipped ApexAI model is trained on (~12 MB):
    # big.txt plus eleven public-domain novels/story collections from the
    # NLTK Gutenberg corpus (Austen, Carroll, Chesterton, Melville, ...),
    # all Gutenberg boilerplate stripped -> data/classics.txt
    python fetch_data.py classics

    # Concatenate every .txt under a folder into one corpus file
    python fetch_data.py concat /path/to/texts data/corpus.txt

Then train on it:
    python train.py --data data/big.txt --arch v2 --tokenizer bpe --vocab_size 2048 \
        --steps 3000 --n_layer 6 --n_embd 256 --block_size 256
"""

from __future__ import annotations

import glob
import os
import re
import sys
import urllib.request

SHAKESPEARE_URL = (
    "https://raw.githubusercontent.com/karpathy/char-rnn/"
    "master/data/tinyshakespeare/input.txt"
)
BIG_URL = "https://raw.githubusercontent.com/dscape/spell/master/test/resources/big.txt"
GUTENBERG_ZIP_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/gutenberg.zip"
# Prose only — the poetry, verse drama and the Bible in that archive are a
# different register and would dilute a small model's grasp of plain English.
CLASSICS = [
    "austen-emma.txt", "austen-persuasion.txt", "austen-sense.txt", "bryant-stories.txt",
    "burgess-busterbrown.txt", "carroll-alice.txt", "chesterton-ball.txt", "chesterton-brown.txt",
    "chesterton-thursday.txt", "edgeworth-parents.txt", "melville-moby_dick.txt",
]


def fetch_shakespeare(out="data/shakespeare.txt"):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    print(f"downloading {SHAKESPEARE_URL}")
    urllib.request.urlretrieve(SHAKESPEARE_URL, out)
    print(f"saved {out} ({os.path.getsize(out):,} bytes)")


# Project Gutenberg files wrap each book in a licence header/footer. big.txt is
# four such books concatenated, so about 3% of it (210 KB) is the same legal
# text repeated, plus a tail of word lists — which a small model then happily
# learns to recite. These markers bound the actual book text in both the old
# ("*END*THE SMALL PRINT") and the newer ("*** START OF ... ***") formats.
_START_RE = re.compile(r"^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$", re.M)
_END_RE = re.compile(
    r"^(\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*|End of (the )?Project Gutenberg('s)?\b.*"
    r"|\*END\*? ?THE SMALL PRINT.*)$", re.M)
_HEADER_RE = re.compile(r"^The Project Gutenberg EBook of .*$", re.M)


def clean_gutenberg(text: str) -> str:
    """Keep only the book bodies: text between each START marker and the next
    END marker. Anything before the first START, between an END and the next
    START, or after the last END is licence boilerplate and is dropped."""
    starts = [m.end() for m in _START_RE.finditer(text)]
    if not starts:
        # No START marker (the NLTK copies drop the header but some keep the
        # footer): cut at the first END marker, if there is one.
        e = _END_RE.search(text)
        return text[:e.start()] if e else text
    parts = []
    for s in starts:
        e = _END_RE.search(text, s)
        body = text[s:e.start() if e else len(text)]
        # the newer format repeats a "Produced by ..." credit right after START
        body = re.sub(r"\A(\s*Produced by[^\n]*\n(?:[^\n]*\n){0,3})", "", body)
        parts.append(body.strip("\n") + "\n")
    out = "\n".join(parts)
    # any header lines that slipped through (a book without a START marker)
    out = _HEADER_RE.sub("", out)
    out = re.sub(r"\n{4,}", "\n\n\n", out)
    return out


def fetch_big(out="data/big.txt", clean=True):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    print(f"downloading {BIG_URL}")
    raw, _ = urllib.request.urlretrieve(BIG_URL)
    with open(raw, encoding="utf-8", errors="replace") as f:
        text = f.read()
    if clean:
        before = len(text)
        text = clean_gutenberg(text)
        print(f"stripped Gutenberg boilerplate: {before:,} -> {len(text):,} chars")
    with open(out, "w", encoding="utf-8") as w:
        w.write(text)
    print(f"saved {out} ({os.path.getsize(out):,} bytes)")


def fetch_classics(out="data/classics.txt"):
    """big.txt (cleaned) + the CLASSICS novels from the NLTK Gutenberg archive."""
    import io
    import zipfile
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    print(f"downloading {BIG_URL}")
    raw, _ = urllib.request.urlretrieve(BIG_URL)
    with open(raw, encoding="utf-8", errors="replace") as f:
        parts = [clean_gutenberg(f.read())]
    print(f"downloading {GUTENBERG_ZIP_URL}")
    zraw, _ = urllib.request.urlretrieve(GUTENBERG_ZIP_URL)
    with zipfile.ZipFile(zraw) as z:
        names = {os.path.basename(n): n for n in z.namelist()}
        for want in CLASSICS:                      # fixed list: no surprises from the archive
            if want not in names:
                print(f"  missing from archive: {want} (skipped)")
                continue
            text = z.read(names[want]).decode("utf-8", errors="replace")
            text = re.sub(r"\A\[[^\]\n]{0,120}\]\s*", "", text)   # NLTK's "[Emma by Jane Austen 1816]" tag
            parts.append(clean_gutenberg(text).strip("\n") + "\n")
            print(f"  + {want} ({len(text):,} chars)")
    corpus = "\n\n".join(parts)
    corpus = "".join(c for c in corpus if c == "\n" or c == "\t" or ord(c) >= 32)  # drop control chars
    with open(out, "w", encoding="utf-8") as w:
        w.write(corpus)
    print(f"saved {out} ({os.path.getsize(out):,} bytes, {len(parts)} sources)")


def clean_file(src, out):
    with open(src, encoding="utf-8", errors="replace") as f:
        text = f.read()
    cleaned = clean_gutenberg(text)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as w:
        w.write(cleaned)
    print(f"cleaned {src}: {len(text):,} -> {len(cleaned):,} chars -> {out}")


def concat(folder, out):
    files = sorted(glob.glob(os.path.join(folder, "**", "*.txt"), recursive=True))
    if not files:
        print(f"no .txt files found under {folder}")
        return
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as w:
        for f in files:
            with open(f, encoding="utf-8", errors="ignore") as r:
                w.write(r.read())
                w.write("\n")
    print(f"combined {len(files)} files into {out} ({os.path.getsize(out):,} bytes)")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "shakespeare":
        fetch_shakespeare(args[1] if len(args) > 1 else "data/shakespeare.txt")
    elif cmd == "big":
        fetch_big(args[1] if len(args) > 1 else "data/big.txt")
    elif cmd == "classics":
        fetch_classics(args[1] if len(args) > 1 else "data/classics.txt")
    elif cmd == "clean":
        if len(args) < 3:
            print("usage: python fetch_data.py clean <in.txt> <out.txt>")
            return
        clean_file(args[1], args[2])
    elif cmd == "concat":
        if len(args) < 3:
            print("usage: python fetch_data.py concat <folder> <out.txt>")
            return
        concat(args[1], args[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
