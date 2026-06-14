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
| `notebooks/train_gpt_colab.ipynb` | Train a bigger version on a free GPU (Colab) and export a `model.json` for the browser. |

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
of tokens per second on a laptop. The same `web/index.html` can be deployed to
GitHub Pages (like the trading app already in this repo).

## Train a bigger model on a GPU (Colab)

Pure-NumPy CPU training caps out fast. To train a much larger model that
produces genuinely readable text, use `notebooks/train_gpt_colab.ipynb`: a
PyTorch port of this same architecture that runs on a free Colab GPU and exports
a `model.json` byte-compatible with `web/gpt.js` (it includes a self-check that
verifies the export matches the browser code). Open it in Google Colab, set the
runtime to GPU, Run all, and commit the resulting `model.json` to `web/` — the
Pages workflow serves a committed model directly instead of training one.

## What to expect

This is an educational implementation: pure NumPy on CPU, a tiny corpus, a tiny
model. It will produce text that *looks* like the training data's language
(spacing, common words, letter statistics) but won't be coherent — that takes
orders of magnitude more data, parameters, and compute. The point is that every
mechanism a real LLM uses is here and visible, with nothing hidden behind a
framework.

To scale it up the levers are the same ones the big labs pull: more data, a
bigger model (`--n_layer`, `--n_embd`), a longer context (`--block_size`), and
more steps — eventually swapping the char tokenizer for byte-pair encoding and
NumPy for a GPU array library.
