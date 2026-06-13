"""Train the from-scratch GPT on a text file.

Example:
    python train.py --data data/input.txt --steps 2000 --n_layer 4 --n_embd 128

Saves a checkpoint to `ckpt.npz` that `sample.py` loads to generate text.
"""

from __future__ import annotations

import argparse
import time

import numpy as np

from model import GPT, GPTConfig
from optim import Adam, clip_grad_norm
from tokenizer import BPETokenizer, CharTokenizer


def get_batch(data, block_size, batch_size, rng):
    """Sample a batch of (context, next-token) pairs from the token stream."""
    ix = rng.integers(0, len(data) - block_size - 1, size=batch_size)
    x = np.stack([data[i : i + block_size] for i in ix])
    y = np.stack([data[i + 1 : i + 1 + block_size] for i in ix])
    return x, y


def estimate_loss(model, data, block_size, batch_size, rng, iters=10):
    losses = []
    for _ in range(iters):
        x, y = get_batch(data, block_size, batch_size, rng)
        _, loss = model.forward(x, y)
        losses.append(float(loss.data))
    return float(np.mean(losses))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", default="data/input.txt")
    p.add_argument("--out", default="ckpt.npz")
    p.add_argument("--tokenizer", choices=["char", "bpe"], default="char",
                   help="char = one token per character; bpe = learned subwords")
    p.add_argument("--vocab_size", type=int, default=512,
                   help="target vocabulary size for the bpe tokenizer")
    p.add_argument("--steps", type=int, default=2000)
    p.add_argument("--batch_size", type=int, default=16)
    p.add_argument("--block_size", type=int, default=64)
    p.add_argument("--n_layer", type=int, default=4)
    p.add_argument("--n_head", type=int, default=4)
    p.add_argument("--n_embd", type=int, default=128)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--weight_decay", type=float, default=0.01)
    p.add_argument("--grad_clip", type=float, default=1.0)
    p.add_argument("--eval_every", type=int, default=200)
    p.add_argument("--seed", type=int, default=1337)
    return p.parse_args()


def main():
    args = parse_args()
    rng = np.random.default_rng(args.seed)
    np.random.seed(args.seed)

    with open(args.data, "r", encoding="utf-8") as f:
        text = f.read()

    if args.tokenizer == "bpe":
        print(f"training bpe tokenizer (target vocab {args.vocab_size})...")
        tok = BPETokenizer.train(text, vocab_size=args.vocab_size)
    else:
        tok = CharTokenizer.from_text(text)
    data = np.array(tok.encode(text), dtype=np.int64)
    n = int(0.9 * len(data))
    train_data, val_data = data[:n], data[n:]
    print(f"corpus: {len(text)} chars, vocab: {tok.vocab_size}, "
          f"train tokens: {len(train_data)}, val tokens: {len(val_data)}")

    config = GPTConfig(
        vocab_size=tok.vocab_size,
        block_size=args.block_size,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
    )
    model = GPT(config)
    n_params = sum(int(np.prod(p.data.shape)) for p in model.parameters())
    print(f"model parameters: {n_params:,}")

    opt = Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    t0 = time.time()
    for step in range(1, args.steps + 1):
        x, y = get_batch(train_data, args.block_size, args.batch_size, rng)
        _, loss = model.forward(x, y)

        opt.zero_grad()
        loss.backward()
        clip_grad_norm(model.parameters(), args.grad_clip)
        opt.step()

        if step % args.eval_every == 0 or step == 1:
            val = estimate_loss(model, val_data, args.block_size, args.batch_size, rng)
            dt = time.time() - t0
            print(f"step {step:5d} | train loss {float(loss.data):.4f} | "
                  f"val loss {val:.4f} | {dt:.1f}s")

    # Save checkpoint: parameters + config + tokenizer.
    np.savez(
        args.out,
        params=np.array(model.state(), dtype=object),
        config=np.array([config.to_dict()], dtype=object),
        tokenizer=np.array([tok.to_json()], dtype=object),
    )
    print(f"saved checkpoint to {args.out}")

    # Show a quick sample so you can eyeball that it learned something.
    start = np.array([[tok.stoi.get("\n", 0)]])
    out = model.generate(start, max_new_tokens=300, temperature=0.8, top_k=20, rng=rng)
    print("\n--- sample ---")
    print(tok.decode(out[0]))


if __name__ == "__main__":
    main()
