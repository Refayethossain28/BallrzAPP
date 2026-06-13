"""Generate text from a trained checkpoint.

Example:
    python sample.py --ckpt ckpt.npz --prompt "The gym" --tokens 400
"""

from __future__ import annotations

import argparse

import numpy as np

from model import GPT, GPTConfig
from tokenizer import load_tokenizer


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", default="ckpt.npz")
    p.add_argument("--prompt", default="\n")
    p.add_argument("--tokens", type=int, default=400)
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top_k", type=int, default=20)
    p.add_argument("--seed", type=int, default=None)
    return p.parse_args()


def main():
    args = parse_args()
    ck = np.load(args.ckpt, allow_pickle=True)
    config = GPTConfig(**ck["config"][0])
    tok = load_tokenizer(ck["tokenizer"][0])

    model = GPT(config)
    model.load_state(list(ck["params"]))

    rng = np.random.default_rng(args.seed)
    ids = tok.encode(args.prompt) or [tok.stoi.get("\n", 0)]
    idx = np.array([ids], dtype=np.int64)
    out = model.generate(
        idx,
        max_new_tokens=args.tokens,
        temperature=args.temperature,
        top_k=args.top_k,
        rng=rng,
    )
    print(tok.decode(out[0]))


if __name__ == "__main__":
    main()
