"""Interactive generation loop.

Type a prompt, press Enter, and the model continues it. Keeps running until
you type 'quit' (or Ctrl-D / Ctrl-C). Loads the model once and reuses it, so
each turn is fast.

    python chat.py --ckpt ckpt.npz
"""

from __future__ import annotations

import argparse

import numpy as np

from model import GPT, GPTConfig
from tokenizer import load_tokenizer


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", default="ckpt.npz")
    p.add_argument("--tokens", type=int, default=300)
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top_k", type=int, default=20)
    return p.parse_args()


def main():
    args = parse_args()
    try:
        ck = np.load(args.ckpt, allow_pickle=True)
    except FileNotFoundError:
        print(f"No checkpoint at '{args.ckpt}'. Train one first:\n"
              f"    python train.py --steps 2000")
        return

    config = GPTConfig(**ck["config"][0])
    tok = load_tokenizer(ck["tokenizer"][0])
    model = GPT(config)
    model.load_state(list(ck["params"]))
    rng = np.random.default_rng()

    print(f"Loaded {args.ckpt} (vocab {tok.vocab_size}, "
          f"{config.n_layer} layers, {config.n_embd} dim).")
    print(f"Generating {args.tokens} chars at temperature {args.temperature}, "
          f"top_k {args.top_k}.")
    print("Type a prompt and press Enter. Type 'quit' to exit.\n")

    while True:
        try:
            prompt = input("you> ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if prompt.strip().lower() in {"quit", "exit"}:
            break
        ids = tok.encode(prompt) or [tok.stoi.get("\n", 0)]
        idx = np.array([ids], dtype=np.int64)
        out = model.generate(
            idx,
            max_new_tokens=args.tokens,
            temperature=args.temperature,
            top_k=args.top_k,
            rng=rng,
        )
        # Print only the newly generated continuation.
        print("llm> " + tok.decode(out[0][len(ids):]) + "\n")


if __name__ == "__main__":
    main()
