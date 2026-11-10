"""Print the provenance block of an exported web/model.json from its `meta`.

    python tools/model_card.py web/model.json

Everything the README and the page say about the shipped model should come
from here, so the numbers cannot drift from the file that is actually served.
"""
from __future__ import annotations

import json
import os
import sys


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "model.json")
    with open(path, encoding="utf-8") as f:
        spec = json.load(f)
    c, m = spec["config"], spec.get("meta") or {}
    n_params = sum(int(__import__("math").prod(v["shape"])) for v in spec["weights"].values())
    size_mb = os.path.getsize(path) / 1e6
    arch = "v2 (rotary positions, RMSNorm, SwiGLU, tied embeddings)" if c.get("pos_emb") == "rope" else "v1 (GPT-2 style)"
    print(f"**Model file:** `{os.path.basename(path)}` — {size_mb:.1f} MB, format {spec.get('format', 1)}, "
          f"{spec.get('weights_dtype', spec.get('dtype', 'f4'))} weights")
    print(f"**Architecture:** {arch}; {c['n_layer']} layers, {c['n_embd']}-dim, {c['n_head']} heads, "
          f"{c['block_size']}-token context, {spec['tokenizer']['type']} vocab {c['vocab_size']}, {n_params:,} parameters")
    if not m:
        print("**Provenance:** not recorded (exported before `meta` existed)")
        return
    print(f"**Trained on:** {m.get('corpus')} ({m.get('corpus_chars', 0):,} chars; {m.get('train_tokens', 0):,} train / "
          f"{m.get('val_tokens', 0):,} held-out tokens, {m.get('val_split', 'contiguous')} split)")
    print(f"**Run:** {m.get('steps'):,} steps x {m.get('batch_size')} x {m.get('block_size')} tokens = "
          f"{m.get('tokens_seen', 0) / 1e6:.1f} M tokens ({m.get('epochs', '?')} epochs), lr {m.get('lr')}, "
          f"weight decay {m.get('weight_decay')}, {m.get('train_seconds', 0) / 60:.0f} min on {m.get('engine')}, {m.get('trained_at')}")
    print(f"**Held-out quality:** loss {m.get('val_loss')} nats/token = {m.get('val_bpb')} bits per byte"
          + (f" (full pass: {m['val_bpb_full']})" if "val_bpb_full" in m else ""))


if __name__ == "__main__":
    main()
