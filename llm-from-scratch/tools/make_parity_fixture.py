"""Build the Python-side reference fixture for the web/gpt.js parity test.

    python tools/make_parity_fixture.py                 # -> web/test/parity-fixture.json
    python tools/make_parity_fixture.py --out /tmp/f.json

The fixture holds a handful of TINY, seeded, randomly-initialised models — the
v1 (GPT-2 style) and v2 (Llama style) architectures, exported as f4 / f2 / q8
and in the original format-1 layout — plus, for each, the exact logits the
NumPy forward pass produces for several token sequences (including ones longer
than the context window) and the token ids the Python tokenizers emit for a
sample text. scripts/test-llm-logic.mjs then checks that the JavaScript port
reproduces all of it. Random weights are enough: parity is about the maths,
not the training. The fixture is deterministic, so CI can regenerate it and
test against a fresh copy.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np  # noqa: E402

from autograd import no_grad  # noqa: E402
from export_web import FORMAT, dequantize, named_params, named_weights  # noqa: E402
from model import GPT, GPTConfig  # noqa: E402
from tokenizer import BPETokenizer, CharTokenizer  # noqa: E402

SAMPLE_TEXT = (
    "It was a bright cold day in April, and the clocks were striking thirteen.\n"
    "The game gives back exactly what you put in, and it keeps perfect books.\n\n"
    "a  b\n\n  c\t\td    e  f   g\n"
    "She said: \"Who's there?\" -- nobody answered; the old house kept its secret.\n"
    "café naïve — ünïcode 😀 and numbers 1234567890.\n"
)
PROMPTS = [
    "It was a",
    "a  b\n\n  c\t\td",
    "The old house kept its secret, and the clocks were striking thirteen in April",
    " ",
    "😀 café",
    "\n",
]
BLOCK = 12


def seeded_model(arch, seed):
    np.random.seed(seed)
    if arch == "v1":
        tok = CharTokenizer.from_text(SAMPLE_TEXT)
        cfg = GPTConfig(vocab_size=tok.vocab_size, block_size=BLOCK, n_layer=2, n_head=2, n_embd=16)
    else:
        tok = BPETokenizer.train(SAMPLE_TEXT, vocab_size=160)
        cfg = GPTConfig(vocab_size=tok.vocab_size, block_size=BLOCK, n_layer=2, n_head=2, n_embd=16,
                        **GPTConfig.V2)
    model = GPT(cfg)
    # The 0.02 init makes a toy model nearly linear; scale the matrices up so
    # the non-linearities (softmax, gelu/silu, norms) actually bite.
    for p in model.parameters():
        if p.data.ndim >= 2:
            p.data = (p.data / (np.abs(p.data).std() + 1e-9) * 0.3).astype(np.float32)
        else:
            p.data = (p.data + 0.1 * np.random.randn(*p.data.shape)).astype(np.float32)
    return model, tok


def legacy_f2_weights(model):
    """The format-1 layout: no per-tensor dtype, one file-level dtype for all."""
    out = {}
    for name, p in named_params(model).items():
        a = np.ascontiguousarray(p.data, dtype="<f2")
        out[name] = {"shape": list(p.data.shape), "data": base64.b64encode(a.tobytes()).decode("ascii")}
    return out


def build_variant(arch, dtype, seed, legacy=False):
    model, tok = seeded_model(arch, seed)
    cfg = model.config
    if legacy:
        weights = legacy_f2_weights(model)
        spec = {"config": {k: cfg.to_dict()[k] for k in ("vocab_size", "block_size", "n_layer", "n_head", "n_embd")},
                "tokenizer": json.loads(tok.to_json()), "dtype": "f2", "weights": weights}
        # expectations from the same half-precision weights the browser will see
        for name, p in named_params(model).items():
            p.data = np.frombuffer(base64.b64decode(weights[name]["data"]), dtype="<f2").reshape(p.data.shape).astype(np.float32)
    else:
        weights = named_weights(model, dtype)
        spec = {"format": FORMAT, "config": cfg.to_dict(), "tokenizer": json.loads(tok.to_json()),
                "dtype": "f4", "weights_dtype": dtype, "meta": {"fixture": True, "arch": cfg.arch},
                "weights": weights}
        for name, p in named_params(model).items():
            p.data = dequantize(weights[name]).astype(np.float32)

    cases = []
    for ptxt in PROMPTS:
        ids = tok.encode(ptxt) or [tok.stoi.get("\n", 0)]
        lens = sorted({1, min(2, len(ids)), len(ids)})
        for L in lens:
            sub = ids[:L]
            ctx = sub[-cfg.block_size:]                         # model.py's generate() crop
            logits = model.forward(np.array([ctx]))[0].data[0, -1]
            cases.append({"prompt": ptxt, "ids": ids, "len": L,
                          "beyond_block": L > cfg.block_size,
                          "logits": [float("%.7g" % x) for x in logits]})   # float32 has ~7 digits
    # Teacher-forced sequence through TWO window overflows: the logits Python
    # produces at every step under GPT.crop_window — the browser's KV cache
    # must reproduce each one (this is what pins the overflow policy).
    stepwise = None
    if dtype == "f4" and not legacy:
        ids = tok.encode(SAMPLE_TEXT)[: 2 * cfg.block_size + 3]
        window, step_logits = [], []
        with no_grad():
            for t in ids:
                window.append(int(t))
                window = GPT.crop_window(window, cfg.block_size)
                lg = model.forward(np.array([window]))[0].data[0, -1]
                step_logits.append([float("%.7g" % x) for x in lg])
        stepwise = {"ids": ids, "logits": step_logits}

    return {
        "arch": arch, "dtype": "f2-legacy" if legacy else dtype, "spec": spec, "cases": cases,
        "stepwise": stepwise,
        "sample_text": SAMPLE_TEXT, "sample_ids": tok.encode(SAMPLE_TEXT),
        "prompt_ids": {p: tok.encode(p) for p in PROMPTS},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "web", "test", "parity-fixture.json"))
    args = ap.parse_args()
    variants = [
        build_variant("v1", "f4", 1),
        build_variant("v1", "q8", 2),
        build_variant("v1", "f2", 3, legacy=True),
        build_variant("v2", "f4", 4),
        build_variant("v2", "f2", 5),
        build_variant("v2", "q8", 6),
    ]
    fixture = {"generator": "tools/make_parity_fixture.py", "sample_text": SAMPLE_TEXT, "variants": variants}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, separators=(",", ":"))
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB, {len(variants)} variants, "
          f"{sum(len(v['cases']) for v in variants)} logit cases)")


if __name__ == "__main__":
    main()
