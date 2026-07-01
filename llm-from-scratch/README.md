# LLM from scratch

A small but complete **GPT-style large language model**, built from first
principles in pure Python + NumPy. No PyTorch, no TensorFlow, no JAX — the
autograd engine, the transformer, the optimizer, and the training loop are all
implemented here, by hand.

It actually trains and generates text. On the included ~4 KB basketball corpus
it learns English character statistics and word-like structure in about two
minutes on a CPU.

## What's inside

| File | What it is |
|------|------------|
| `autograd.py` | A reverse-mode automatic differentiation engine over NumPy arrays. A `Tensor` records the ops performed on it; `.backward()` walks the graph in reverse topological order and fills in gradients. This is the foundation everything else stands on. |
| `nn.py` | Neural-net building blocks composed from the autograd primitives: `Linear`, `Embedding`, `LayerNorm`, `gelu`, and multi-head `CausalSelfAttention`. |
| `model.py` | The `GPT` model — token + positional embeddings, a stack of pre-norm transformer blocks, a final layernorm, and a linear head to vocabulary logits. Plus autoregressive `generate()` and checkpointing. |
| `tokenizer.py` | Two tokenizers: a character-level one, and a from-scratch **byte-pair encoding (BPE)** tokenizer that learns a subword vocabulary. |
| `fetch_data.py` | Helper to download a larger corpus (tiny Shakespeare) or concatenate a folder of `.txt` files into one. |
| `optim.py` | The Adam optimizer and gradient-norm clipping, implemented from scratch. |
| `train.py` | The training loop: batch sampling, forward, backprop, optimizer step, evaluation, checkpointing. |
| `sample.py` | Load a checkpoint and generate text from a prompt. |
| `test_autograd.py` | A gradient check: compares backprop's analytic gradients against finite-difference numeric gradients through a real GPT forward pass. |
| `data/input.txt` | A small sample corpus to train on. |
| `export_web.py` | Exports a trained checkpoint to JSON weights for the browser. |
| `web/gpt.js` | A JavaScript port of the forward pass + tokenizers — runs inference client-side. |
| `web/index.html` | A browser UI: type a prompt, watch the model generate, all in JS. |

## How it works

A decoder-only transformer is a next-token predictor. Given a sequence of
tokens, it outputs a probability distribution over what comes next, and is
trained to maximise the probability of the actual next token (cross-entropy
loss). Generation is just sampling from that distribution one token at a time
and feeding the result back in.

```
tokens ──► token embedding + positional embedding
       ──► N × { causal self-attention ; MLP }   (each with a residual + layernorm)
       ──► final layernorm
       ──► linear head ──► logits over the vocabulary
```

The only non-obvious part is **causal self-attention**: each position mixes in
information from earlier positions (never later ones — that's the "causal"
mask), weighted by learned query/key similarity. Stacking several of these
layers lets the model build up increasingly abstract representations of the
context. See `nn.py:CausalSelfAttention`.

Because every operation is expressed through the autograd engine, we never
derive a single gradient by hand — `loss.backward()` does it all. The one place
we do supply a manual gradient is the fused softmax-cross-entropy in
`autograd.py`, for numerical stability and speed.

## Quick start

The fastest way — one command that trains a model (if you don't have one yet)
and drops you into an interactive prompt:

```bash
./run.sh
```

Or do it step by step:

```bash
pip install -r requirements.txt

# 1. Verify the autograd engine is correct (numeric gradient check)
python test_autograd.py

# 2. Train on the sample corpus (~2 min on CPU). Writes ckpt.npz.
python train.py --steps 2000 --n_layer 4 --n_embd 128

# 3a. Generate once from the trained checkpoint
python sample.py --prompt "The game" --tokens 400

# 3b. ...or chat interactively (type a prompt, see the model continue it)
python chat.py
```

## Training on more / your own data

The tokenizer builds its vocabulary from whatever text you train on, so "more
data" just means a bigger file — no code changes needed.

```bash
# Any UTF-8 text file
python train.py --data path/to/your.txt --steps 3000 --block_size 128

# Grab a bigger classic corpus (~1 MB)
python fetch_data.py shakespeare
python train.py --data data/shakespeare.txt --tokenizer bpe \
    --steps 5000 --n_layer 6 --n_embd 256 --block_size 128

# Or combine a whole folder of .txt files into one corpus
python fetch_data.py concat /path/to/texts data/corpus.txt
python train.py --data data/corpus.txt --tokenizer bpe --steps 8000
```

### Char vs. BPE tokenizer

`--tokenizer char` (default) uses one token per character: tiny vocab, but the
model must learn everything from single characters and sequences are long.

`--tokenizer bpe` learns a subword vocabulary by repeatedly merging the most
frequent adjacent pair (set the size with `--vocab_size`). Tokens become whole
common words and word-pieces, so the model sees more meaningful units and fewer
tokens per sentence — this is what real LLMs use, and it noticeably improves
output quality on anything larger than the toy corpus.

### Useful flags (`train.py`)

| Flag | Default | Meaning |
|------|---------|---------|
| `--steps` | 2000 | Training iterations |
| `--block_size` | 64 | Context length (tokens) |
| `--n_layer` | 4 | Transformer blocks |
| `--n_head` | 4 | Attention heads |
| `--n_embd` | 128 | Embedding / hidden width |
| `--batch_size` | 16 | Sequences per step |
| `--lr` | 3e-4 | Adam learning rate |

## Run it in a browser

Train in Python, then run inference entirely in JavaScript — no server compute,
no API. `export_web.py` serializes the trained weights to JSON, and `web/gpt.js`
is a faithful port of the forward pass (verified to match Python's logits to
float32 precision).

```bash
python train.py --steps 2000          # produces ckpt.npz
python export_web.py                  # writes web/model.json
```

Then either:

```bash
# A) Serve the folder and open the page
python -m http.server -d web 8000     # then visit http://localhost:8000

# B) Build a single standalone file you can just double-click (no server)
python export_web.py --inline         # writes web/llm.html
```

The page has a prompt box, temperature / top-k / length sliders, and streams the
generated text token by token. Because the model is small, it runs at hundreds
of tokens per second on a laptop.

### "My Own AI Model" — the installable PWA

`web/` is a full **installable PWA**: an app manifest, offline service worker,
and app icons ship alongside the page, so once loaded the model runs with no
network at all — the weights are cached on-device. A trained `web/model.json` is
committed to the repo so the deployed page works with **zero setup**, and it is
published to GitHub Pages next to the other prototypes:

- **Live:** https://refayethossain28.github.io/BallrzAPP/llm/

To refresh the deployed model after training, re-run `python export_web.py` and
commit the updated `web/model.json` (regenerate the icons with
`node scripts/gen-llm-icons.mjs` from the repo root if you change the motif).
Install it from the browser (Chromium: "Install app"; iOS Safari: Share → Add to
Home Screen) for a full-screen, offline launch.

The shipped `web/model.json` is a subword (BPE) model trained on the ~1 MB tiny
Shakespeare corpus, which reads noticeably better than a character model on the
toy corpus. Rebuild it with:

```bash
python fetch_data.py shakespeare
python train.py --data data/shakespeare.txt --tokenizer bpe --vocab_size 512 \
    --n_layer 5 --n_head 8 --n_embd 160 --block_size 96 --batch_size 12 \
    --steps 1600 --lr 4e-4 --out ckpt-shakespeare.npz
python export_web.py --ckpt ckpt-shakespeare.npz --out web/model.json
```

### ⚡ Live AI — put your model next to real Fable 5

The from-scratch model is genuinely yours, but it's tiny, so it reads more like a
stylistic echo than a smart assistant. `server.mjs` adds an optional **"Live AI"**
toggle: it serves the same page and routes the prompt box to **real frontier
Claude — Fable 5 by default** — streaming the reply back token by token so you can
compare the two engines side by side. The API key stays server-side (the browser
never sees it); zero dependencies (Node 18+ built-ins only).

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # then open http://localhost:8789
```

Flip on **⚡ Live AI (Fable 5)** in the header and hit **Ask Fable 5**. Without a
key (or on the hosted GitHub Pages build, which has no proxy) the toggle stays
disabled and the on-device model is used. Override the model with
`LLM_LIVE_MODEL=claude-fable-5` (or any current Claude id).

## What to expect

This is an educational implementation: pure NumPy on CPU, a ~1 MB corpus, a ~1.7M
parameter model. With BPE it produces text with real words, Shakespearean cadence
and line structure — but it won't be *coherent*, and it is not an assistant. That
gap is not a bug to fix here: a frontier model like Fable 5 has on the order of
hundreds of billions of parameters trained on trillions of tokens — five to six
orders of magnitude more data, parameters and compute. No CPU-trained,
browser-shippable model gets close. If you want that level of quality in this app,
that's exactly what the **⚡ Live AI (Fable 5)** toggle is for. The point of the
from-scratch model is that every mechanism a real LLM uses is here and visible,
with nothing hidden behind a framework — and it's genuinely yours.

To scale the from-scratch model up, the levers are the same ones the big labs
pull: more data, a bigger model (`--n_layer`, `--n_embd`), a longer context
(`--block_size`), more steps — and eventually swapping NumPy for a GPU array
library.
