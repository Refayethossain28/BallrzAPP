"""Train the from-scratch GPT on a text file.

Example:
    python train.py --data data/input.txt --steps 2000 --n_layer 4 --n_embd 128

Saves a checkpoint to `ckpt.npz` that `sample.py` loads to generate text.
"""

from __future__ import annotations

import argparse
import math
import os
import time

from backend import np, to_numpy, GPU, BACKEND  # numpy, or CuPy when LLM_BACKEND=cupy
import numpy as hnp  # host-side numpy: batch RNG and .npz checkpoint files

from model import GPT, GPTConfig
from optim import Adam, clip_grad_norm
from tokenizer import BPETokenizer, CharTokenizer, load_tokenizer


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
    p.add_argument("--warmup", type=int, default=-1,
                   help="linear warmup steps (-1 = auto: max(50, steps//20))")
    p.add_argument("--min_lr_ratio", type=float, default=0.1,
                   help="cosine-decay the LR down to this fraction of --lr")
    p.add_argument("--weight_decay", type=float, default=0.01)
    p.add_argument("--grad_clip", type=float, default=1.0)
    p.add_argument("--eval_every", type=int, default=200)
    p.add_argument("--seed", type=int, default=1337)
    return p.parse_args()


def main():
    args = parse_args()
    rng = hnp.random.default_rng(args.seed)   # host RNG: batch indices, eval
    np.random.seed(args.seed)                  # backend RNG: weight init
    if GPU:
        print(f"backend: {BACKEND} (GPU)")

    with open(args.data, "r", encoding="utf-8") as f:
        text = f.read()

    # Resumable training: a full-state file next to --out lets a run that gets
    # killed (e.g. an ephemeral container restart) pick up exactly where it left
    # off — just launch the same command again. It stores params + optimizer
    # moments + step + best-val + tokenizer, so BPE isn't even rebuilt on resume.
    state_path = args.out + ".state.npz"
    resuming = os.path.exists(state_path)

    if resuming:
        st = hnp.load(state_path, allow_pickle=True)
        tok = load_tokenizer(st["tokenizer"][0])
        config = GPTConfig(**dict(st["config"][0]))
        print(f"resuming from {state_path}")
    else:
        if args.tokenizer == "bpe":
            print(f"training bpe tokenizer (target vocab {args.vocab_size})...")
            # BPE merge-learning is O(unique chunks x merges) in pure Python; on
            # a multi-MB corpus that dominates the whole training budget. A few
            # MB is plenty of evidence for learning ~1k merges, so learn them on
            # evenly spread slices of a big corpus and ENCODE the whole thing.
            BPE_TRAIN_CAP = 3_000_000
            if len(text) > BPE_TRAIN_CAP:
                k = 10
                span = BPE_TRAIN_CAP // k
                stride = len(text) // k
                sample = "".join(text[i * stride : i * stride + span] for i in range(k))
                print(f"  (corpus is {len(text):,} chars; learning merges on a {len(sample):,}-char sample)")
                tok = BPETokenizer.train(sample, vocab_size=args.vocab_size)
            else:
                tok = BPETokenizer.train(text, vocab_size=args.vocab_size)
        else:
            tok = CharTokenizer.from_text(text)
        config = GPTConfig(
            vocab_size=tok.vocab_size,
            block_size=args.block_size,
            n_layer=args.n_layer,
            n_head=args.n_head,
            n_embd=args.n_embd,
        )

    data = np.array(tok.encode(text), dtype=np.int64)
    n = int(0.9 * len(data))
    train_data, val_data = data[:n], data[n:]
    print(f"corpus: {len(text)} chars, vocab: {tok.vocab_size}, "
          f"train tokens: {len(train_data)}, val tokens: {len(val_data)}")

    model = GPT(config)
    n_params = sum(int(np.prod(p.data.shape)) for p in model.parameters())
    print(f"model parameters: {n_params:,}")

    opt = Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    start_step = 0
    best_val_resumed = float("inf")
    if resuming:
        model.load_state(list(st["params"]))  # load_state moves host → backend
        opt.m = [np.asarray(a) for a in st["opt_m"]]
        opt.v = [np.asarray(a) for a in st["opt_v"]]
        opt.t = int(st["opt_t"][0])
        start_step = int(st["step"][0])
        best_val_resumed = float(st["best_val"][0])
        print(f"resumed at step {start_step}, best val {best_val_resumed:.4f}")

    # LR schedule: linear warmup then cosine decay to min_lr_ratio * lr. A fixed
    # LR tends to overshoot and drift back up late in training; warmup+cosine
    # keeps it descending and reaching a better final loss.
    warmup = args.warmup if args.warmup >= 0 else max(50, args.steps // 20)
    min_lr = args.lr * args.min_lr_ratio

    def lr_at(step):
        if step < warmup:
            return args.lr * (step + 1) / max(1, warmup)
        prog = (step - warmup) / max(1, args.steps - warmup)
        return min_lr + 0.5 * (args.lr - min_lr) * (1 + math.cos(math.pi * min(1.0, prog)))

    def save():
        hnp.savez(
            args.out,
            params=hnp.array([to_numpy(a) for a in model.state()], dtype=object),
            config=hnp.array([config.to_dict()], dtype=object),
            tokenizer=hnp.array([tok.to_json()], dtype=object),
        )

    def save_state(step, best):
        # Full training state for resume: params + Adam moments + counters.
        hnp.savez(
            state_path,
            params=hnp.array([to_numpy(a) for a in model.state()], dtype=object),
            opt_m=hnp.array([to_numpy(a) for a in opt.m], dtype=object),
            opt_v=hnp.array([to_numpy(a) for a in opt.v], dtype=object),
            opt_t=hnp.array([opt.t]),
            step=hnp.array([step]),
            best_val=hnp.array([best]),
            config=hnp.array([config.to_dict()], dtype=object),
            tokenizer=hnp.array([tok.to_json()], dtype=object),
        )

    # Keep the BEST-val checkpoint, not merely the last one, so a late-training
    # wobble can never ship a worse model than we already had.
    best_val = best_val_resumed
    t0 = time.time()
    if start_step >= args.steps:
        print(f"already at step {start_step} >= {args.steps}; nothing to do")
    for step in range(start_step + 1, args.steps + 1):
        opt.lr = lr_at(step)
        x, y = get_batch(train_data, args.block_size, args.batch_size, rng)
        _, loss = model.forward(x, y)

        opt.zero_grad()
        loss.backward()
        clip_grad_norm(model.parameters(), args.grad_clip)
        opt.step()

        if step % args.eval_every == 0 or step == 1 or step == args.steps:
            val = estimate_loss(model, val_data, args.block_size, args.batch_size, rng)
            dt = time.time() - t0
            star = ""
            if val < best_val:
                best_val = val
                save()
                star = "  <- best, saved"
            save_state(step, best_val)   # checkpoint for resume (survives restarts)
            print(f"step {step:5d} | train loss {float(loss.data):.4f} | "
                  f"val loss {val:.4f} | lr {opt.lr:.2e} | {dt:.1f}s{star}")

    print(f"saved best checkpoint (val {best_val:.4f}) to {args.out}")

    # Show a quick sample so you can eyeball that it learned something.
    start = hnp.array([[tok.stoi.get("\n", 0)]])
    out = model.generate(start, max_new_tokens=300, temperature=0.8, top_k=20, rng=rng)
    print("\n--- sample ---")
    print(tok.decode(out[0]))


if __name__ == "__main__":
    main()
