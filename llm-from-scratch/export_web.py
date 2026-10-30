"""Export a trained checkpoint to a JSON the browser can run.

    python export_web.py --ckpt ckpt.npz --out web/model.json            # float32
    python export_web.py --ckpt ckpt.npz --out web/model.json --dtype q8  # int8, 4x smaller

Weights are stored per tensor, base64-encoded little-endian, with explicit
names so web/gpt.js can map them onto the architecture:

    f4  float32 — exact.
    f2  float16 — half the bytes; indistinguishable at this scale.
    q8  int8 symmetric quantisation with one float32 scale per output unit:
        for a Linear weight (in, out) that is per COLUMN (s_j = max|w[:, j]| /
        127, axis "col"); for the embedding tables wte / wpe it is per ROW
        (axis "row") — a row is one token, and as the tied head each row is
        one output logit, so a rare token's small row keeps its own scale
        instead of being crushed by the column maxima of frequent tokens.
        Stored value = round(w / s). The browser rebuilds float32 weights as
        q * s at load time, so inference maths is unchanged and only the
        download shrinks (a quarter of f4). 1-D tensors (norm gains, biases)
        stay f4 — they are tiny and they are multiplied into everything.

`--check_data corpus.txt` reports the loss on train.py's held-out slices of
that corpus with the exact weights and with the exported ones, so you can see
what the compression costs.

Pass --inline to additionally bake everything into a single standalone
web/llm.html that opens with a double-click (no web server needed):

    python export_web.py --inline
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os

import numpy as np

from autograd import no_grad
from backend import to_numpy

from model import GPT, GPTConfig
from tokenizer import load_tokenizer

FORMAT = 2   # 1 = the original flat float export; 2 = per-tensor dtypes + meta


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


ROW_QUANTIZED = ("wte.weight", "wpe.weight")   # tables: one scale per row


def encode_tensor(arr, dtype: str = "f4", name: str = "") -> dict:
    """Encode one tensor as {shape, data[, dtype, axis, scale]}."""
    a = np.ascontiguousarray(to_numpy(arr), dtype=np.float32)
    if dtype == "q8" and a.ndim >= 2:
        axis = "row" if name in ROW_QUANTIZED else "col"
        q, scale = quantize_q8(a, axis)
        return {"shape": list(a.shape), "dtype": "q8", "axis": axis,
                "data": _b64(q.tobytes()), "scale": _b64(scale.astype("<f4").tobytes())}
    if dtype == "f2" and a.ndim >= 2:
        return {"shape": list(a.shape), "dtype": "f2", "data": _b64(a.astype("<f2").tobytes())}
    return {"shape": list(a.shape), "dtype": "f4", "data": _b64(a.astype("<f4").tobytes())}


def quantize_q8(a: np.ndarray, axis: str = "col"):
    """Symmetric int8 with one scale per column (last axis) or per row (first
    axis). Returns (int8 array, float32 scales)."""
    if axis == "row":
        amax = np.abs(a).reshape(a.shape[0], -1).max(axis=1)
        scale = (amax / 127.0).astype(np.float32)
        scale[scale == 0] = 1.0
        q = np.clip(np.rint(a / scale.reshape((-1,) + (1,) * (a.ndim - 1))), -127, 127).astype(np.int8)
        return q, scale
    amax = np.abs(a).max(axis=tuple(range(a.ndim - 1)))
    scale = (amax / 127.0).astype(np.float32)
    scale[scale == 0] = 1.0
    q = np.clip(np.rint(a / scale), -127, 127).astype(np.int8)
    return q, scale


def dequantize(entry: dict) -> np.ndarray:
    """Exactly what gpt.js reconstructs — used by --check_data."""
    shape = tuple(entry["shape"])
    raw = base64.b64decode(entry["data"])
    dt = entry.get("dtype", "f4")
    if dt == "q8":
        q = np.frombuffer(raw, dtype=np.int8).reshape(shape).astype(np.float32)
        scale = np.frombuffer(base64.b64decode(entry["scale"]), dtype="<f4")
        if entry.get("axis") == "row":
            return q * scale.reshape((-1,) + (1,) * (len(shape) - 1))
        return q * scale
    if dt == "f2":
        return np.frombuffer(raw, dtype="<f2").reshape(shape).astype(np.float32)
    return np.frombuffer(raw, dtype="<f4").reshape(shape).copy()


def named_params(model: GPT) -> dict:
    """Parameters under the names gpt.js expects (v1 names unchanged)."""
    cfg = model.config
    w = {}
    w["wte.weight"] = model.wte.weight
    if model.wpe is not None:
        w["wpe.weight"] = model.wpe.weight

    def norm(prefix, mod):
        w[prefix + ".gamma"] = mod.gamma
        if cfg.norm == "layernorm":
            w[prefix + ".beta"] = mod.beta

    def lin(prefix, mod):
        w[prefix + ".weight"] = mod.weight
        if mod.bias is not None:
            w[prefix + ".bias"] = mod.bias

    for i, blk in enumerate(model.blocks):
        p = f"blocks.{i}."
        norm(p + "ln1", blk.ln1)
        lin(p + "attn.qkv", blk.attn.qkv)
        lin(p + "attn.proj", blk.attn.proj)
        norm(p + "ln2", blk.ln2)
        if cfg.mlp == "swiglu":
            lin(p + "mlp.gate", blk.mlp.gate)
            lin(p + "mlp.up", blk.mlp.up)
            lin(p + "mlp.down", blk.mlp.down)
        else:
            lin(p + "mlp.fc", blk.mlp.fc)
            lin(p + "mlp.proj", blk.mlp.proj)
    norm("ln_f", model.ln_f)
    if model.head is not None:
        w["head.weight"] = model.head.weight
    return w


def named_weights(model: GPT, dtype: str = "f4") -> dict:
    return {name: encode_tensor(p.data, dtype, name) for name, p in named_params(model).items()}


def model_from_spec(spec: dict):
    """Rebuild a Python GPT (+ tokenizer) from an exported model.json — any
    format, any dtype — with exactly the weights the browser decodes."""
    config = GPTConfig.from_dict(spec["config"])
    model = GPT(config)
    default_dtype = spec.get("dtype", "f4")
    for name, p in named_params(model).items():
        entry = dict(spec["weights"][name])
        entry.setdefault("dtype", default_dtype)
        p.data = dequantize(entry).astype(np.float32)
    tok = load_tokenizer(json.dumps(spec["tokenizer"]))
    return model, tok


def load_checkpoint(ckpt_path: str):
    ck = np.load(ckpt_path, allow_pickle=True)
    config = GPTConfig.from_dict(ck["config"][0])
    tok = load_tokenizer(ck["tokenizer"][0])
    model = GPT(config)
    model.load_state(list(ck["params"]))
    meta = dict(ck["meta"][0]) if "meta" in ck.files else {}
    return model, tok, meta, json.loads(ck["tokenizer"][0])


def build_spec(ckpt_path: str, dtype: str = "f4") -> dict:
    model, tok, meta, tok_json = load_checkpoint(ckpt_path)
    return {
        "format": FORMAT,
        "config": model.config.to_dict(),
        "tokenizer": tok_json,
        "dtype": "f4",                 # default for tensors without their own dtype
        "weights_dtype": dtype,        # what --dtype asked for (informational)
        "meta": meta,
        "weights": named_weights(model, dtype),
    }


def check_quality(ckpt_path: str, spec: dict, data_path: str, batches=20, batch_size=16, seed=1):
    """Held-out loss (last 10% of `data_path`) with exact vs. exported weights."""
    model, tok, meta, _ = load_checkpoint(ckpt_path)
    with open(data_path, encoding="utf-8") as f:
        text = f.read()
    from train import split_train_val
    data = np.array(tok.encode(text), dtype=np.int64)
    # the slices THIS checkpoint held out (checkpoints from before `meta` held out the tail)
    val = split_train_val(data, meta.get("val_split", "contiguous"))[1]
    bytes_per_token = len(tok.decode(val).encode("utf-8")) / max(1, len(val))
    T = model.config.block_size
    rng = np.random.default_rng(seed)
    ix = rng.integers(0, len(val) - T - 1, size=(batches, batch_size))

    def loss_of(m):
        losses = []
        with no_grad():
            for row in ix:
                x = np.stack([val[i:i + T] for i in row]); y = np.stack([val[i + 1:i + 1 + T] for i in row])
                losses.append(float(m.forward(x, y)[1].data))
        return float(np.mean(losses))

    exact = loss_of(model)
    for name, p in named_params(model).items():
        p.data = dequantize(spec["weights"][name]).astype(np.float32)
    exported = loss_of(model)
    bpb = lambda l: l / (math.log(2) * bytes_per_token)
    print(f"held-out loss: exact {exact:.4f} ({bpb(exact):.4f} bpb) | exported {exported:.4f} "
          f"({bpb(exported):.4f} bpb) | delta {100 * (exported - exact) / exact:+.2f}%")
    return exact, exported


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="ckpt.npz")
    ap.add_argument("--out", default="web/model.json")
    ap.add_argument("--dtype", choices=["f4", "f2", "q8"], default="f4",
                    help="weight precision: f4=float32, f2=float16 (half), q8=int8 per-column (quarter)")
    ap.add_argument("--check_data", default="",
                    help="corpus file: report held-out loss with exact vs exported weights")
    ap.add_argument("--inline", action="store_true",
                    help="also write a standalone web/llm.html with the model baked in")
    args = ap.parse_args()

    spec = build_spec(args.ckpt, args.dtype)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(spec, f, separators=(",", ":"))
    size = os.path.getsize(args.out)
    n_params = sum(int(np.prod(v["shape"])) for v in spec["weights"].values())
    print(f"wrote {args.out} ({size / 1024 / 1024:.1f} MB, {n_params:,} params, {args.dtype}, "
          f"arch {spec['config'].get('pos_emb')}/{spec['config'].get('norm')}/{spec['config'].get('mlp')})")
    if args.check_data:
        check_quality(args.ckpt, spec, args.check_data)

    if args.inline:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "web", "gpt.js"), encoding="utf-8") as f:
            gpt_js = f.read()
        with open(os.path.join(here, "web", "index.html"), encoding="utf-8") as f:
            html = f.read()
        spec_json = json.dumps(spec, separators=(",", ":"))
        # Replace the external <script src="gpt.js"> with the inlined source,
        # and drop the model JSON into an embedded element the page reads first.
        html = html.replace('<script src="gpt.js?v=2"></script>',
                            f"<script>{gpt_js}</script>")
        html = html.replace('<!--INLINE_MODEL-->',
                            f'<script type="application/json" id="inline-model">{spec_json}</script>')
        out_html = os.path.join(here, "web", "llm.html")
        with open(out_html, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"wrote web/llm.html ({os.path.getsize(out_html) / 1024:.0f} KB, standalone)")


if __name__ == "__main__":
    main()
