"""Export a trained checkpoint to a JSON the browser can run.

    python export_web.py --ckpt ckpt.npz --out web/model.json

Weights are stored as little-endian float32, base64-encoded per tensor, with
explicit names so web/gpt.js can map them onto the architecture.

Pass --inline to additionally bake everything into a single standalone
web/llm.html that opens with a double-click (no web server needed):

    python export_web.py --inline
"""

from __future__ import annotations

import argparse
import base64
import json
import os

import numpy as np

from model import GPT, GPTConfig
from tokenizer import load_tokenizer


def _b64(arr: np.ndarray) -> dict:
    data = np.ascontiguousarray(arr, dtype="<f4").tobytes()
    return {"shape": list(arr.shape), "data": base64.b64encode(data).decode("ascii")}


def named_weights(model: GPT) -> dict:
    """Pull parameters out of the model under names gpt.js expects."""
    w = {}
    w["wte.weight"] = _b64(model.wte.weight.data)
    w["wpe.weight"] = _b64(model.wpe.weight.data)
    for i, blk in enumerate(model.blocks):
        p = f"blocks.{i}."
        w[p + "ln1.gamma"] = _b64(blk.ln1.gamma.data)
        w[p + "ln1.beta"] = _b64(blk.ln1.beta.data)
        w[p + "attn.qkv.weight"] = _b64(blk.attn.qkv.weight.data)
        w[p + "attn.qkv.bias"] = _b64(blk.attn.qkv.bias.data)
        w[p + "attn.proj.weight"] = _b64(blk.attn.proj.weight.data)
        w[p + "attn.proj.bias"] = _b64(blk.attn.proj.bias.data)
        w[p + "ln2.gamma"] = _b64(blk.ln2.gamma.data)
        w[p + "ln2.beta"] = _b64(blk.ln2.beta.data)
        w[p + "mlp.fc.weight"] = _b64(blk.mlp.fc.weight.data)
        w[p + "mlp.fc.bias"] = _b64(blk.mlp.fc.bias.data)
        w[p + "mlp.proj.weight"] = _b64(blk.mlp.proj.weight.data)
        w[p + "mlp.proj.bias"] = _b64(blk.mlp.proj.bias.data)
    w["ln_f.gamma"] = _b64(model.ln_f.gamma.data)
    w["ln_f.beta"] = _b64(model.ln_f.beta.data)
    w["head.weight"] = _b64(model.head.weight.data)
    return w


def build_spec(ckpt_path: str) -> dict:
    ck = np.load(ckpt_path, allow_pickle=True)
    config = GPTConfig(**ck["config"][0])
    tok = load_tokenizer(ck["tokenizer"][0])
    model = GPT(config)
    model.load_state(list(ck["params"]))
    return {
        "config": config.to_dict(),
        "tokenizer": json.loads(ck["tokenizer"][0]),
        "weights": named_weights(model),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="ckpt.npz")
    ap.add_argument("--out", default="web/model.json")
    ap.add_argument("--inline", action="store_true",
                    help="also write a standalone web/llm.html with the model baked in")
    args = ap.parse_args()

    spec = build_spec(args.ckpt)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(spec, f)
    size = os.path.getsize(args.out)
    n_params = sum(int(np.prod(v["shape"])) for v in spec["weights"].values())
    print(f"wrote {args.out} ({size/1024:.0f} KB, {n_params:,} params)")

    if args.inline:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "web", "gpt.js"), encoding="utf-8") as f:
            gpt_js = f.read()
        with open(os.path.join(here, "web", "index.html"), encoding="utf-8") as f:
            html = f.read()
        spec_json = json.dumps(spec)
        # Replace the external <script src="gpt.js"> with the inlined source,
        # and drop the model JSON into an embedded element the page reads first.
        html = html.replace('<script src="gpt.js"></script>',
                            f"<script>{gpt_js}</script>")
        html = html.replace('<!--INLINE_MODEL-->',
                            f'<script type="application/json" id="inline-model">{spec_json}</script>')
        out_html = os.path.join(here, "web", "llm.html")
        with open(out_html, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"wrote web/llm.html ({os.path.getsize(out_html)/1024:.0f} KB, standalone)")


if __name__ == "__main__":
    main()
