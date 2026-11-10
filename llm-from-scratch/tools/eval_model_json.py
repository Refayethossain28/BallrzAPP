"""Score an exported web/model.json on text files: held-out loss and bits per byte.

    python tools/eval_model_json.py web/model.json data/classics.txt data/shakespeare.txt

Bits per byte is comparable across tokenizers and vocab sizes, so this is how
two different models are compared on the same text. The last 10% of each file
is used (the same split train.py holds out), on a fixed set of windows.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np  # noqa: E402

from autograd import no_grad  # noqa: E402
from export_web import model_from_spec  # noqa: E402
from train import split_train_val  # noqa: E402


def heldout(tok, text, split):
    """The held-out tokens of `text` under a train.py split rule ("chunked",
    "contiguous") — or every token of it ("all": a text neither model trained on)."""
    data = np.array(tok.encode(text), dtype=np.int64)
    if split == "all":
        return data
    return split_train_val(data, split)[1]


def score(model, tok, val, batches=24, batch_size=16, seed=1, full=False):
    """Mean next-token loss over `val`: `full` = every non-overlapping block_size
    window (a complete pass), otherwise `batches` x `batch_size` random windows."""
    T = model.config.block_size
    if len(val) <= T + 1:
        raise SystemExit("text too short for one window")
    bytes_per_token = len(tok.decode(val).encode("utf-8")) / len(val)
    if full:
        starts = np.arange(0, len(val) - T - 1, T)
        rows = [starts[i:i + batch_size] for i in range(0, len(starts), batch_size)]
    else:
        rng = np.random.default_rng(seed)
        rows = list(rng.integers(0, len(val) - T - 1, size=(batches, batch_size)))
    losses, weights = [], []
    with no_grad():
        for row in rows:
            x = np.stack([val[i:i + T] for i in row])
            y = np.stack([val[i + 1:i + 1 + T] for i in row])
            losses.append(float(model.forward(x, y)[1].data))
            weights.append(len(row))
    loss = float(np.average(losses, weights=weights))
    return loss, loss / (math.log(2) * bytes_per_token), bytes_per_token


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_json")
    ap.add_argument("texts", nargs="+")
    ap.add_argument("--batches", type=int, default=24)
    ap.add_argument("--split", choices=["chunked", "contiguous", "all"], default="chunked",
                    help="which part of each text to score: train.py's held-out slices (chunked / "
                         "contiguous) or the whole text (all)")
    ap.add_argument("--full", action="store_true", help="a complete pass over the held-out tokens, not a sample")
    args = ap.parse_args()
    with open(args.model_json, encoding="utf-8") as f:
        spec = json.load(f)
    model, tok = model_from_spec(spec)
    n = model.num_params()
    print(f"{args.model_json}: arch {model.config.arch}, {n:,} params, ctx {model.config.block_size}, "
          f"vocab {model.config.vocab_size}, meta {json.dumps(spec.get('meta', {}))[:160]}")
    for t in args.texts:
        with open(t, encoding="utf-8", errors="replace") as f:
            text = f.read()
        val = heldout(tok, text, args.split)
        loss, bpb, bpt = score(model, tok, val, args.batches, full=args.full)
        how = ("full pass" if args.full else f"{args.batches}x16 windows") + f", {args.split}"
        print(f"  {os.path.basename(t):22s} loss {loss:.4f} nats/token | {bpb:.4f} bits/byte "
              f"({bpt:.2f} bytes/token, {len(val):,} held-out tokens, {how})")


if __name__ == "__main__":
    main()
