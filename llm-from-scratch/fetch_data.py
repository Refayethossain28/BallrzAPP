"""Helpers to assemble a bigger training corpus.

Commands:
    # Download "tiny Shakespeare" (~1 MB) to data/shakespeare.txt
    python fetch_data.py shakespeare

    # Concatenate every .txt under a folder into one corpus file
    python fetch_data.py concat /path/to/texts data/corpus.txt

Then train on it:
    python train.py --data data/shakespeare.txt --tokenizer bpe \
        --steps 5000 --n_layer 6 --n_embd 256 --block_size 128
"""

from __future__ import annotations

import glob
import os
import sys
import urllib.request

SHAKESPEARE_URL = (
    "https://raw.githubusercontent.com/karpathy/char-rnn/"
    "master/data/tinyshakespeare/input.txt"
)


def fetch_shakespeare(out="data/shakespeare.txt"):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    print(f"downloading {SHAKESPEARE_URL}")
    urllib.request.urlretrieve(SHAKESPEARE_URL, out)
    print(f"saved {out} ({os.path.getsize(out):,} bytes)")


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
    elif cmd == "concat":
        if len(args) < 3:
            print("usage: python fetch_data.py concat <folder> <out.txt>")
            return
        concat(args[1], args[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
