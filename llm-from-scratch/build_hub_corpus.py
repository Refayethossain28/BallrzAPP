"""Assemble a training corpus from *everything in the Ballrz Hub*.

Pulls the hub's app catalog (names / descriptions / tags / section titles from
hub/index.html), the README's per-app write-ups, and each app's <title> +
meta-description, into one plain-ASCII text file. Feed it to train.py to get a
model that "dreams" in the voice of your own apps.

    python build_hub_corpus.py                 # -> data/hub.txt
    python train.py --data data/hub.txt --tokenizer char --n_layer 4 \
        --n_embd 128 --block_size 96 --steps 1500 --out ckpt.npz
"""
from __future__ import annotations
import glob
import html
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build(out="data/hub.txt"):
    parts = []

    hub = os.path.join(REPO, "hub", "index.html")
    if os.path.exists(hub):
        t = open(hub, encoding="utf-8", errors="ignore").read()
        for m in re.finditer(r"(title|name|desc|tags):\s*'([^']*)'", t):
            v = m.group(2).strip()
            if v:
                parts.append(v)

    readme = os.path.join(REPO, "README.md")
    if os.path.exists(readme):
        rd = open(readme, encoding="utf-8", errors="ignore").read()
        rd = re.sub(r"```.*?```", "", rd, flags=re.S)          # drop code blocks
        rd = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", rd)         # links -> text
        rd = re.sub(r"<[^>]+>", " ", rd)                          # html tags
        rd = re.sub(r"[`*#>|_]+", " ", rd)                        # md syntax
        for line in rd.splitlines():
            line = html.unescape(line).strip()
            if len(line) > 40:
                parts.append(line)

    # Each app's title + meta description (a clean one-line summary per app).
    for f in glob.glob(os.path.join(REPO, "*", "index.html")) + \
            glob.glob(os.path.join(REPO, "*.html")):
        try:
            t = open(f, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        for pat in (r"<title>([^<]+)</title>",
                    r'name="description"\s+content="([^"]+)"'):
            m = re.search(pat, t)
            if m:
                parts.append(html.unescape(m.group(1)).strip())

    text = "\n".join(parts)
    text = "".join(c for c in text if c == "\n" or 32 <= ord(c) < 127)  # ASCII
    text = re.sub(r"\n{2,}", "\n", text)

    os.makedirs(os.path.join(REPO, "llm-from-scratch", os.path.dirname(out)) or ".",
                exist_ok=True)
    dst = os.path.join(REPO, "llm-from-scratch", out)
    with open(dst, "w", encoding="utf-8") as w:
        w.write(text)
    print(f"wrote {dst}: {len(text):,} chars, {text.count(chr(10))} lines")


if __name__ == "__main__":
    build()
