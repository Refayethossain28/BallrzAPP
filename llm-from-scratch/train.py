"""Train the from-scratch GPT on a text file.

Examples:
    python train.py --data data/input.txt --steps 2000 --n_layer 4 --n_embd 128
    python train.py --data data/big.txt --arch v2 --tokenizer bpe --vocab_size 2048 \
        --n_layer 6 --n_embd 256 --block_size 256 --steps 3000

Saves the best-validation checkpoint to `ckpt.npz` (which `sample.py`,
`chat.py` and `export_web.py` load) and a full resumable state next to it.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import math
import os
import time

from backend import np, to_numpy, GPU, BACKEND  # numpy, or CuPy when LLM_BACKEND=cupy
import numpy as hnp  # host-side numpy: batch RNG and .npz checkpoint files

from autograd import no_grad
from model import GPT, GPTConfig
from optim import AdamW, clip_grad_norm
from tokenizer import BPETokenizer, CharTokenizer, load_tokenizer

LN2 = math.log(2.0)


def get_batch(data, block_size, batch_size, rng):
    """Sample a batch of (context, next-token) pairs from the token stream."""
    ix = rng.integers(0, len(data) - block_size - 1, size=batch_size)
    x = np.stack([data[i : i + block_size] for i in ix])
    y = np.stack([data[i + 1 : i + 1 + block_size] for i in ix])
    return x, y


def split_train_val(data, mode="chunked", frac=0.1, block=4096):
    """Hold out `frac` of the token stream for validation.

    "contiguous" holds out the tail — which for a concatenated corpus is
    simply the last book, so the number only says how well the model does on
    THAT book. "chunked" (default) holds out every k-th `block`-token slice,
    so the held-out set samples every source and training sees most of each.
    Windows that straddle a slice boundary leak a little context; that is a
    fraction of a percent of windows and consistent across runs.
    """
    n = len(data)
    if mode == "contiguous":
        cut = int((1 - frac) * n)
        return data[:cut], data[cut:]
    every = max(2, int(round(1 / frac)))
    block = min(block, max(16, n // (4 * every)))   # tiny corpora: smaller slices, >= 4 of them
    nblocks = (n + block - 1) // block
    val_blocks = [b for b in range(nblocks) if b % every == every - 1]
    val_mask = np.zeros(n, dtype=bool)
    for b in val_blocks:
        val_mask[b * block:(b + 1) * block] = True
    # keep the held-out slices contiguous: the model is scored on real text,
    # the training stream is the concatenation of what is left
    train = data[~val_mask]
    val = np.concatenate([data[b * block:(b + 1) * block] for b in val_blocks])
    return train, val


def make_val_batches(data, block_size, batch_size, iters, seed):
    """A FIXED set of validation batches. Re-sampling them every eval (the old
    behaviour) adds noise that can exceed the improvement between two evals,
    so 'best val' could be won by a lucky draw rather than a better model."""
    rng = hnp.random.default_rng(seed)
    return [get_batch(data, block_size, batch_size, rng) for _ in range(iters)]


def estimate_loss(model, batches):
    losses = []
    with no_grad():                       # no graph: each batch's activations die immediately
        for x, y in batches:
            _, loss = model.forward(x, y)
            losses.append(float(loss.data))
    return float(hnp.mean(losses))


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
    # --- architecture: v1 = the original GPT-2 style, v2 = Llama style
    #     (RoPE + RMSNorm + SwiGLU + tied embeddings, no biases). The
    #     individual switches override whichever recipe --arch picked.
    p.add_argument("--arch", choices=["v1", "v2"], default="v1")
    p.add_argument("--pos_emb", choices=["learned", "rope"])
    p.add_argument("--norm", choices=["layernorm", "rmsnorm"])
    p.add_argument("--mlp", choices=["gelu", "swiglu"])
    p.add_argument("--tie_embeddings", type=int, choices=[0, 1])
    p.add_argument("--bias", type=int, choices=[0, 1])
    p.add_argument("--mlp_hidden", type=int, default=0, help="0 = default width for the mlp kind")
    # --- optimisation
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--warmup", type=int, default=-1,
                   help="linear warmup steps (-1 = auto: max(50, steps//20))")
    p.add_argument("--min_lr_ratio", type=float, default=0.1,
                   help="cosine-decay the LR down to this fraction of --lr")
    p.add_argument("--beta2", type=float, default=0.95)
    p.add_argument("--weight_decay", type=float, default=0.1,
                   help="AdamW decoupled decay, applied to weight matrices only")
    p.add_argument("--grad_clip", type=float, default=1.0)
    p.add_argument("--eval_every", type=int, default=200)
    p.add_argument("--val_iters", type=int, default=20, help="fixed validation batches per eval")
    p.add_argument("--val_split", choices=["chunked", "contiguous"], default="chunked",
                   help="hold out every 10th 4096-token slice (chunked) or the last 10%% (contiguous)")
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--corpus_name", default="", help="label stored in the model's meta (default: data file name)")
    return p.parse_args()


def build_config(args, vocab_size):
    kw = dict(GPTConfig.V2) if args.arch == "v2" else {}
    for k in ("pos_emb", "norm", "mlp"):
        if getattr(args, k) is not None:
            kw[k] = getattr(args, k)
    if args.tie_embeddings is not None:
        kw["tie_embeddings"] = bool(args.tie_embeddings)
    if args.bias is not None:
        kw["bias"] = bool(args.bias)
    return GPTConfig(vocab_size=vocab_size, block_size=args.block_size, n_layer=args.n_layer,
                     n_head=args.n_head, n_embd=args.n_embd, mlp_hidden=args.mlp_hidden, **kw)


def main():
    args = parse_args()
    rng = hnp.random.default_rng(args.seed)   # host RNG: batch indices
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
        config = GPTConfig.from_dict(st["config"][0])
        print(f"resuming from {state_path}")
    else:
        if args.tokenizer == "bpe":
            print(f"training bpe tokenizer (target vocab {args.vocab_size})...")
            t_tok = time.time()
            tok = BPETokenizer.train(text, vocab_size=args.vocab_size)
            print(f"  learned {len(tok.merges)} merges in {time.time() - t_tok:.1f}s")
        else:
            tok = CharTokenizer.from_text(text)
        config = build_config(args, tok.vocab_size)

    data = np.array(tok.encode(text), dtype=np.int64)
    train_data, val_data = split_train_val(data, args.val_split)
    # bytes per token of the held-out split: converts val loss (nats/token) to
    # bits per byte, a number that is comparable across char and BPE models
    # (and across vocab sizes), unlike raw per-token loss.
    val_bytes = len(tok.decode(to_numpy(val_data)).encode("utf-8"))
    bytes_per_token = val_bytes / max(1, len(val_data))
    to_bpb = lambda loss: loss / (LN2 * bytes_per_token)
    print(f"corpus: {len(text):,} chars, vocab: {tok.vocab_size}, "
          f"train tokens: {len(train_data):,}, val tokens: {len(val_data):,} "
          f"({bytes_per_token:.2f} bytes/token, {args.val_split} split)")

    if resuming:
        wanted = build_config(args, tok.vocab_size)
        if wanted != config:
            print(f"NOTE: resuming with the SAVED architecture {config.to_dict()}; "
                  f"the command line asked for {wanted.to_dict()} and is ignored")
    block_size = config.block_size            # the model's, not the flag's, on resume

    model = GPT(config)
    n_params = model.num_params()
    print(f"model: arch {config.arch}, {config.n_layer}L/{config.n_embd}d/{config.n_head}h, "
          f"ctx {config.block_size}, {n_params:,} parameters")

    opt = AdamW(model.parameters(), lr=args.lr, betas=(0.9, args.beta2),
                weight_decay=args.weight_decay, decay_params=model.decay_parameters())

    start_step = 0
    best_val_resumed = float("inf")
    elapsed_resumed = 0.0
    if resuming:
        model.load_state(list(st["params"]))  # load_state moves host → backend
        opt.m = [np.asarray(a) for a in st["opt_m"]]
        opt.v = [np.asarray(a) for a in st["opt_v"]]
        opt.t = int(st["opt_t"][0])
        start_step = int(st["step"][0])
        best_val_resumed = float(st["best_val"][0])
        if "elapsed" in st.files:
            elapsed_resumed = float(st["elapsed"][0])
        if "rng_state" in st.files:
            rng.bit_generator.state = st["rng_state"][0]   # continue the batch sequence, not replay it
        print(f"resumed at step {start_step}, best val {best_val_resumed:.4f}")

    val_batches = make_val_batches(val_data, block_size, args.batch_size, args.val_iters, args.seed + 1)

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

    def meta(step, val, elapsed):
        return {
            "corpus": args.corpus_name or os.path.basename(args.data),
            "corpus_chars": len(text), "train_tokens": int(len(train_data)), "val_tokens": int(len(val_data)),
            "tokenizer": args.tokenizer, "vocab_size": int(tok.vocab_size),
            "arch": config.arch, "n_params": int(n_params),
            "steps": int(step), "batch_size": args.batch_size, "block_size": block_size,
            "tokens_seen": int(step * args.batch_size * block_size),
            "epochs": round(step * args.batch_size * block_size / max(1, len(train_data)), 2),
            "val_split": args.val_split,
            "lr": args.lr, "weight_decay": args.weight_decay,
            "val_loss": round(float(val), 4), "val_bpb": round(float(to_bpb(val)), 4),
            "train_seconds": int(elapsed),
            "trained_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "engine": "numpy" if not GPU else BACKEND,
        }

    def save(step, val, elapsed):
        hnp.savez(
            args.out,
            params=hnp.array([to_numpy(a) for a in model.state()], dtype=object),
            config=hnp.array([config.to_dict()], dtype=object),
            tokenizer=hnp.array([tok.to_json()], dtype=object),
            meta=hnp.array([meta(step, val, elapsed)], dtype=object),
        )

    def save_state(step, best, elapsed):
        # Full training state for resume: params + Adam moments + counters.
        hnp.savez(
            state_path,
            params=hnp.array([to_numpy(a) for a in model.state()], dtype=object),
            opt_m=hnp.array([to_numpy(a) for a in opt.m], dtype=object),
            opt_v=hnp.array([to_numpy(a) for a in opt.v], dtype=object),
            opt_t=hnp.array([opt.t]),
            step=hnp.array([step]),
            best_val=hnp.array([best]),
            elapsed=hnp.array([elapsed]),
            rng_state=hnp.array([rng.bit_generator.state], dtype=object),
            config=hnp.array([config.to_dict()], dtype=object),
            tokenizer=hnp.array([tok.to_json()], dtype=object),
        )

    # Keep the BEST-val checkpoint, not merely the last one, so a late-training
    # wobble can never ship a worse model than we already had.
    best_val = best_val_resumed
    t0 = time.time()
    t_last, step_last = t0, start_step
    if start_step >= args.steps:
        print(f"already at step {start_step} >= {args.steps}; nothing to do")
    for step in range(start_step + 1, args.steps + 1):
        opt.lr = lr_at(step)
        x, y = get_batch(train_data, block_size, args.batch_size, rng)
        _, loss = model.forward(x, y)

        opt.zero_grad()
        loss.backward()
        clip_grad_norm(model.parameters(), args.grad_clip)
        opt.step()

        if step % args.eval_every == 0 or step == 1 or step == args.steps:
            val = estimate_loss(model, val_batches)
            now = time.time()
            elapsed = elapsed_resumed + (now - t0)
            tps = (step - step_last) * args.batch_size * block_size / max(1e-9, now - t_last)
            t_last, step_last = now, step
            star = ""
            if val < best_val:
                best_val = val
                save(step, val, elapsed)
                star = "  <- best, saved"
            save_state(step, best_val, elapsed)   # checkpoint for resume (survives restarts)
            print(f"step {step:5d} | train loss {float(loss.data):.4f} | val loss {val:.4f} "
                  f"({to_bpb(val):.3f} bpb) | lr {opt.lr:.2e} | {tps:,.0f} tok/s | {elapsed/60:.1f} min{star}",
                  flush=True)

    print(f"saved best checkpoint (val {best_val:.4f}, {to_bpb(best_val):.3f} bpb) to {args.out}")

    # Show a quick sample so you can eyeball that it learned something.
    start = hnp.array([[tok.stoi.get("\n", 0)]])
    out = model.generate(start, max_new_tokens=300, temperature=0.8, top_k=20, rng=rng)
    print("\n--- sample ---")
    print(tok.decode(out[0]))


if __name__ == "__main__":
    main()
