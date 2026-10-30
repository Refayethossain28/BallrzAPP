# LLM from scratch

A small but complete **GPT-style large language model**, built from first
principles in pure Python + NumPy. No PyTorch, no TensorFlow, no JAX — the
autograd engine, the transformer, the optimizer, and the training loop are all
implemented here, by hand.

It actually trains and generates text. On the included ~4 KB basketball corpus
it learns English character statistics and word-like structure in under a
minute on a CPU; on 12 MB of public-domain novels it learns to write period
prose — the model that ships with the **ApexAI** page below.

Two model generations live in the same code base, switched by one flag:

| | **v1** — GPT-2 style (the original) | **v2** — Llama style (`--arch v2`, the shipped model) |
|---|---|---|
| positions | learned embedding table | **rotary** (RoPE), inside attention |
| normalisation | LayerNorm | **RMSNorm** |
| feed-forward | GELU, 4× wide | **SwiGLU**, 8/3× wide (same parameter count) |
| output head | its own V×d matrix | **tied** to the token embedding |
| biases | yes | no |

Everything previously trained (the niche models, old `model.json` files) is a
v1 model and still loads and runs unchanged.

## What's inside

| File | What it is |
|------|------------|
| `autograd.py` | A reverse-mode automatic differentiation engine over NumPy arrays. A `Tensor` records the ops performed on it; `.backward()` walks the graph in reverse topological order and fills in gradients. The primitives (`+ * @ sum exp reshape …`) compose into anything; the hot spots of a transformer (`gelu`, `silu`, `layernorm`, `rmsnorm`, `softmax`, `rope`, `cross_entropy`) are **fused ops** with a hand-derived backward each, and `no_grad()` turns graph-building off for evaluation and sampling. |
| `nn.py` | Neural-net building blocks composed from the autograd primitives: `Linear`, `Embedding`, `LayerNorm`, `RMSNorm`, multi-head `CausalSelfAttention` (optionally rotary), the GELU `MLP` and the `SwiGLU` MLP, and the pre-norm `Block`. |
| `model.py` | The `GPT` model — embeddings, a stack of transformer blocks, a final norm, and a head (or the tied embedding) to vocabulary logits. `GPTConfig` holds the architecture switches. Plus autoregressive `generate()` and checkpointing. |
| `tokenizer.py` | Two tokenizers: a character-level one, and a from-scratch **byte-pair encoding (BPE)** tokenizer whose trainer updates pair counts incrementally (2 s for a 2048-token vocabulary on 6.5 MB; the naive recount took minutes). |
| `fetch_data.py` | Corpus helpers: tiny Shakespeare, Norvig's `big.txt`, the **`classics`** mix the shipped model is trained on, Project Gutenberg boilerplate stripping, folder concatenation. |
| `optim.py` | **AdamW** (decoupled weight decay on the weight matrices only) and gradient-norm clipping, from scratch. |
| `train.py` | The training loop: batch sampling, forward, backprop, optimizer step, warmup + cosine LR, evaluation on a fixed held-out set reported in loss *and* **bits per byte**, best-checkpoint saving, full-state resume. |
| `sample.py` / `chat.py` | Load a checkpoint and generate text from a prompt / interactively. |
| `test_autograd.py` | Every fused op checked against the same function composed from primitives (identical values and gradients), and a finite-difference gradient check through a real GPT forward pass for **both** architectures. |
| `test_tokenizer.py` | Round-trip tests, and the incremental BPE trainer checked against the naive reference. |
| `data/input.txt` | A small sample corpus to train on. |
| `export_web.py` | Exports a trained checkpoint to JSON weights for the browser — float32, float16 or **int8** — and can report what the compression costs in held-out loss. |
| `web/gpt.js` | A JavaScript port of the forward pass + tokenizers with a **KV cache** — runs inference client-side at reading speed. |
| `web/index.html` | A browser UI: type a prompt, watch the model generate, all in JS. |
| `tools/make_parity_fixture.py` | Builds the reference fixture (`web/test/parity-fixture.json`) that `scripts/test-llm-logic.mjs` uses to prove the JavaScript port matches the NumPy forward pass. |
| `tools/eval_model_json.py` | Scores any exported `model.json` on any text in bits per byte — how two models are compared fairly. |

## How it works

A decoder-only transformer is a next-token predictor. Given a sequence of
tokens, it outputs a probability distribution over what comes next, and is
trained to maximise the probability of the actual next token (cross-entropy
loss). Generation is just sampling from that distribution one token at a time
and feeding the result back in.

```
tokens ──► token embedding (+ positional embedding in v1)
       ──► N × { causal self-attention (rotary positions in v2) ; MLP }
                 (each pre-normed, with a residual connection)
       ──► final norm
       ──► linear head ──► logits over the vocabulary
```

The only non-obvious part is **causal self-attention**: each position mixes in
information from earlier positions (never later ones — that's the "causal"
mask), weighted by learned query/key similarity. Stacking several of these
layers lets the model build up increasingly abstract representations of the
context. See `nn.py:CausalSelfAttention`. In v2 the query and key vectors are
*rotated* by an angle proportional to their position (`autograd.rope`), which
makes the attention score depend on the **distance** between two tokens rather
than on a learned table of absolute positions.

Because every operation is expressed through the autograd engine, we never
derive a gradient for the model as a whole — `loss.backward()` does it all.
A handful of hot operations are written as single fused nodes with a
hand-written backward (each one is a few lines of calculus, documented in
`autograd.py`), because composing them from primitives costs ten temporaries
and — for GELU's `x ** 3` — an 18× slower NumPy power. Every fused derivative
is checked against the primitive composition and against finite differences in
`test_autograd.py`, so nothing is taken on faith.

### Why v2 is better, measured

Same corpus (`big.txt`), same tokenizer (BPE-2048), same size (6 layers,
256-dim, 8 heads, 128-token context), same 300 steps and learning rate, on the
same CPU:

| recipe | parameters | held-out loss | bits per byte |
|---|---|---|---|
| v1 (learned pos · LayerNorm · GELU · own head) | 5.82 M | 3.877 | 2.498 |
| **v2 (RoPE · RMSNorm · SwiGLU · tied head)** | **5.34 M** | **3.713** | **2.392** |

4 % lower loss with 8 % fewer parameters, before any of the other changes.

### Engine speed

The from-scratch engine is CPU-bound NumPy, so step time decides how big a
model you can afford. Profiling the original showed only ~20 % of a step in
matrix multiplies; the rest was the autograd overhead around them. One
training step of the previously shipped configuration (6L/256d, batch 16 ×
128 tokens) on this 4-core box:

| change | s/step | tokens/s |
|---|---|---|
| original engine | 2.88 | 712 |
| fused `gelu` (no `x ** 3`), fused norms and softmax, shared-buffer `unbind` | 2.13 | 962 |
| + scale on q instead of the score map, mask folded into softmax, constants skip grads | **0.85** | **2,407** |

3.4× faster, same maths (the new engine's gradients match the old one's to
1e-6). Evaluation forwards also no longer keep their graph alive (`no_grad()`):
before, twelve validation batches of a 10 M-parameter model were enough to
exhaust 15 GB of RAM.

## Quick start

The fastest way — one command that trains a model (if you don't have one yet)
and drops you into an interactive prompt:

```bash
./run.sh
```

Or do it step by step:

```bash
pip install -r requirements.txt

# 1. Verify the autograd engine is correct (fused ops + numeric gradient check, v1 and v2)
python test_autograd.py

# 2. Train on the sample corpus (~1 min on CPU). Writes ckpt.npz.
python train.py --steps 2000 --n_layer 4 --n_embd 128

# 3a. Generate once from the trained checkpoint
python sample.py --prompt "The game" --tokens 400

# 3b. ...or chat interactively (type a prompt, see the model continue it)
python chat.py
```

Add `--arch v2` to train the Llama-style model instead; everything downstream
(`sample.py`, `export_web.py`, the browser) reads the architecture from the
checkpoint.

## Training on more / your own data

The tokenizer builds its vocabulary from whatever text you train on, so "more
data" just means a bigger file — no code changes needed.

```bash
# Any UTF-8 text file
python train.py --data path/to/your.txt --steps 3000 --block_size 128

# Grab a bigger classic corpus (~1 MB)
python fetch_data.py shakespeare
python train.py --data data/shakespeare.txt --arch v2 --tokenizer bpe \
    --steps 5000 --n_layer 6 --n_embd 256 --block_size 128

# Norvig's big.txt (6.5 MB: Sherlock Holmes, War and Peace, ...), Gutenberg licence text stripped
python fetch_data.py big

# The shipped model's recipe (~12 MB): big.txt + eleven public-domain novels
# (Austen, Carroll, Chesterton, Melville, ...) from the NLTK Gutenberg archive
python fetch_data.py classics
python train.py --data data/classics.txt --corpus_name classics --arch v2 \
    --tokenizer bpe --vocab_size 2048 --n_layer 8 --n_head 8 --n_embd 320 \
    --block_size 256 --batch_size 16 --steps 1200 --lr 6e-4 --warmup 100

# Or combine a whole folder of .txt files into one corpus
python fetch_data.py concat /path/to/texts data/corpus.txt
python train.py --data data/corpus.txt --tokenizer bpe --steps 8000

# Or scrape the LIVE INTERNET into a corpus — Magpie (the repo's from-scratch
# scraper) crawls from your seed URLs politely (MagpieBot UA, robots.txt
# respected, SSRF-guarded), extracts each page's readable prose (nav/footer
# chrome and boilerplate dropped) and writes one training file:
node ../scripts/build-web-corpus.mjs https://en.wikipedia.org/wiki/Magpie --pages 40
python train.py --data data/web.txt --tokenizer bpe --steps 8000
```

The "Train browser LLM" workflow accepts a committed corpus path too: build
`data/web.txt` with the scraper, commit it, and dispatch the workflow with
`corpus_url = data/web.txt` — the trained model lands in `web/model.json` and
GitHub Pages serves your internet-fed AI. Its defaults are now the shipped
recipe (`corpus_url = classics`, `arch = v2`, 8L/320d, int8 export).

Training is **resumable**: `train.py` writes `<out>.state.npz` (parameters,
optimizer moments, step, tokenizer) at every evaluation, so a run that gets
killed continues from where it was when you launch the same command again.

### Train on a GPU (the big-model path)

The stack is backend-switchable: `LLM_BACKEND=cupy` swaps NumPy for
[CuPy](https://cupy.dev) and the identical from-scratch code runs on an NVIDIA
GPU — 10–30× faster than CPU, which is what makes a **~15.7M-parameter** model
practical. `train_on_colab.ipynb` is the ready-made path: open it in Google
Colab, pick a T4, and it scrapes a corpus with Magpie, trains a v2 8L/384d/BPE-4096
model, and exports **int8** weights (`export_web.py --dtype q8`, a quarter of
the float32 download; `web/gpt.js` decodes any precision). Sampling stays
host-side, checkpoints stay plain `.npz`, and every existing test runs
unchanged on the default numpy backend.

### Niche generators — where a tiny model is actually useful

A 5M-parameter model can't be a general assistant, but it *is* good at a narrow,
repetitive job where a plausible candidate (not a correct answer) is the value.
The page has three task modes for exactly that, each usable **now via ⚡ Live AI
(real Fable 5)** and as an **on-device demo** once you train a dedicated model:

- **🏷️ Names** — luxury / automotive brand-name ideation. Corpus:
  `npm run corpus:names` → `data/names.txt`. Train with `out_model =
  model-names.json`, `tokenizer = char`, `block_size = 48`.
- **✉️ Microcopy** — on-brand chauffeur/booking messages. Corpus:
  `npm run corpus:microcopy` → `data/microcopy.txt`. Train with `out_model =
  model-microcopy.json`, `tokenizer = bpe`.
- **⌨️ Autocomplete** — finishes a line in the model's voice (uses the default
  model, or any you train).

The workflow's `out_model` input writes each niche model to its own file under
`web/`, and the page loads whichever the task needs — so one page serves several
purpose-built models. The corpus builders ship deterministic seed data you can
expand with your own names/messages, or swap for a Magpie-scraped corpus.

### Char vs. BPE tokenizer

`--tokenizer char` (default) uses one token per character: tiny vocab, but the
model must learn everything from single characters and sequences are long.

`--tokenizer bpe` learns a subword vocabulary by repeatedly merging the most
frequent adjacent pair (set the size with `--vocab_size`). Tokens become whole
common words and word-pieces, so the model sees more meaningful units and fewer
tokens per sentence — this is what real LLMs use, and it noticeably improves
output quality on anything larger than the toy corpus. The trainer keeps an
index from each pair to the chunks that contain it and only re-counts those
chunks after a merge, so a 2048-token vocabulary on the 12 MB classics corpus
takes about 4 seconds (the naive "recount everything after every merge" loop
took minutes, and dominated short training runs).

### Useful flags (`train.py`)

| Flag | Default | Meaning |
|------|---------|---------|
| `--arch` | `v1` | `v1` GPT-2 style, `v2` Llama style (`--pos_emb/--norm/--mlp/--tie_embeddings/--bias` override individually) |
| `--steps` | 2000 | Training iterations |
| `--block_size` | 64 | Context length (tokens) |
| `--n_layer` | 4 | Transformer blocks |
| `--n_head` | 4 | Attention heads |
| `--n_embd` | 128 | Embedding / hidden width |
| `--batch_size` | 16 | Sequences per step |
| `--lr` | 3e-4 | Peak AdamW learning rate (linear warmup, cosine decay to `--min_lr_ratio`) |
| `--weight_decay` | 0.1 | Decoupled decay on weight matrices |
| `--eval_every` / `--val_iters` | 200 / 20 | Evaluate on this many *fixed* held-out batches every N steps |
| `--corpus_name` | file name | Label stored in the model's `meta` (shown on the page) |

Evaluation prints loss and **bits per byte** (loss ÷ ln 2 ÷ bytes-per-token of
the held-out split): unlike per-token loss, bpb is comparable between a
character model and a BPE model, or between two vocab sizes.

## Run it in a browser

Train in Python, then run inference entirely in JavaScript — no server compute,
no API. `export_web.py` serializes the trained weights to JSON, and `web/gpt.js`
is a faithful port of the forward pass.

```bash
python train.py --arch v2 --steps 2000          # produces ckpt.npz
python export_web.py --dtype q8                 # writes web/model.json (int8: a quarter of float32)
python export_web.py --dtype q8 --check_data data/input.txt   # ...and reports what int8 costs in held-out loss
```

Then either:

```bash
# A) Serve the folder and open the page
python -m http.server -d web 8000     # then visit http://localhost:8000

# B) Build a single standalone file you can just double-click (no server)
python export_web.py --inline         # writes web/llm.html
```

The page has a prompt box, sliders (length, temperature, top-k, **top-p /
nucleus**, and a **repetition penalty**), and streams the generated text token by
token. The repetition penalty and nucleus sampling matter a lot at this scale —
without them a small model tends to collapse into `the the the` loops; with them
the output stays varied and keeps its line/speaker structure. The same decoding
(top-k + top-p + repetition penalty) is implemented in Python too — see
`sample.py --top_p --repetition_penalty` and `GPT.generate(...)`.

**It is fast now.** The first port recomputed the whole context for every
token with a cache-hostile weight loop and managed ~1 token/s. `gpt.js` keeps a
**KV cache** (each new token costs one pass over the weights plus attention
over the cached keys) and reads every weight matrix sequentially, so the
previously shipped 5.3 M-parameter model went from 1.1 to **54 tokens/s** in
the same Node.js V8 engine, and the new 10.6 M-parameter model streams at
_(measured at the end of the training run)_ tokens/s. When the context window fills, the cache is rebuilt over
the most recent three quarters of it (positions restart at 0 — a plain forward
pass over tokens the model has seen in training-shaped windows) and generation
continues incrementally; `GPT.generate()` in Python follows the same policy.

**Weights are small now.** `--dtype q8` stores int8 values with one float32
scale per output unit (per column for the linear layers, per row for the
embedding table, so a rare token's small row isn't crushed by the frequent
tokens' maxima); the browser dequantises at load, so the arithmetic is still
float32. `--check_data` shows the cost — for the shipped model it is _(reported with the final model)_
in held-out loss for a 4× smaller download. `f2` (float16) is also available.

**It is proven to match.** `tools/make_parity_fixture.py` builds tiny seeded
v1 and v2 models in every precision and records the NumPy logits for several
token sequences and the Python tokenizers' ids; `node scripts/test-llm-logic.mjs`
(`npm run test:llm`, part of `npm test`) checks that the JavaScript port
reproduces them, that stepping through the KV cache equals a fresh pass, and
that the sampler and tensor decoders behave. CI (`.github/workflows/llm.yml`)
regenerates the fixture fresh and tests against it, so the two implementations
cannot drift apart silently.

### "ApexAI" — the installable PWA

`web/` is a full **installable PWA**: an app manifest, offline service worker,
and app icons ship alongside the page, so once loaded the model runs with no
network at all — the weights are cached on-device. A trained `web/model.json` is
committed to the repo so the deployed page works with **zero setup**, and it is
published to GitHub Pages next to the other prototypes.

- **Live:** https://refayethossain28.github.io/BallrzAPP/llm/

**The committed model** is a v2 (Llama-style) transformer — 8 layers, 320-dim,
8 heads, 256-token context, BPE-2048, **10.6 M parameters** — trained from
scratch with this repo's own autograd on the `classics` corpus (12 MB: Sherlock
Holmes, War and Peace, Austen, Melville, Chesterton, Carroll, …, Gutenberg
licence text stripped) for 1,200 steps (4.9 M tokens) in _(pending)_
minutes on a 4-core CPU, and exported as int8 (_(pending)_ MB). Held-out quality:
**_(pending)_ bits per byte** (loss _(pending)_). The model it replaces (v1,
5.3 M parameters, trained on GitHub documentation) scores 3.67 bpb on the same
held-out classics text, 4.08 on tiny Shakespeare and 4.47 on this repo's README;
the new one scores _(pending)_, _(pending)_ and _(pending)_
(`python tools/eval_model_json.py web/model.json <texts>` — the texts are not
in either model's training data except the classics split, which is held out
from the new model and was never seen by the old one).

To refresh the deployed model after training, re-run `python export_web.py
--dtype q8` and commit the updated `web/model.json` (regenerate the icons with
`node scripts/gen-llm-icons.mjs` from the repo root if you change the motif).
Install it from the browser (Chromium: "Install app"; iOS Safari: Share → Add to
Home Screen) for a full-screen, offline launch. The page loads the engine as
`gpt.js?v=2`, so an installed app whose service worker still holds the old
engine fetches the new one on its next visit instead of trying to run a
format-2 model file with format-1 code (`model.json` and the page itself are
network-first; a newer model reaches returning visitors without a cache bump).

### Train it on Colab (reliable, free)

Training in an ephemeral container gets killed by restarts, and this pure-NumPy
trainer is CPU-only — so the easy, reliable way to train a **bigger** model (or
one on your own corpus, e.g. Wikipedia) is Google Colab, which runs a cell to
completion:

**[▶ Open `train_on_colab.ipynb` in Colab](https://colab.research.google.com/github/Refayethossain28/BallrzAPP/blob/main/llm-from-scratch/train_on_colab.ipynb)**

Runtime → Run all. It clones the repo, builds a corpus, trains a ~15.7M-param v2
model, exports `web/model.json`, and downloads it. Commit that file to
`llm-from-scratch/web/model.json` and the Pages deploy ships it. Training is
resumable (`train.py` checkpoints full state), so a dropped runtime just
continues on re-run.

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
key the toggle stays disabled and the on-device model is used. Override the model
with `LLM_LIVE_MODEL=claude-fable-5` (or any current Claude id).

**On the hosted GitHub Pages page**, Live AI works through a server-side proxy so
the browser never holds a key. The repo ships that proxy as a Firebase function
(`llmLive` in [`../functions-side/index.js`](../functions-side/index.js)) which
auto-deploys with the backend and reuses the project's existing `ANTHROPIC_API_KEY`
— the app points at it by default, so the toggle lights up with no setup once the
backend is deployed. Prefer your own host (Render/Fly/VPS)? Deploy `server.mjs` and
paste its URL via **“connect Fable 5 proxy”** (that overrides the default). Full
steps and an important **cost/abuse note** (a public key-bearing proxy is inherently
abusable — set an Anthropic spend limit) are in [`DEPLOY.md`](./DEPLOY.md).

## What to expect

This is an educational implementation: pure NumPy on CPU, a 12 MB corpus, a
~10 M parameter model. It writes fluent-looking nineteenth-century prose —
sentences that scan, dialogue that opens and closes, names that recur — but it
does not *know* anything, it will contradict itself within a paragraph, and it
is not an assistant. That gap is not a bug to fix here: a frontier model like
Fable 5 has on the order of hundreds of billions of parameters trained on
trillions of tokens — four to five orders of magnitude more data, parameters
and compute. No CPU-trained, browser-shippable model gets close. If you want
that level of quality in this app, that's exactly what the **⚡ Live AI
(Fable 5)** toggle is for. The point of the from-scratch model is that every
mechanism a real LLM uses is here and visible, with nothing hidden behind a
framework — and it's genuinely yours.

To scale the from-scratch model up, the levers are the same ones the big labs
pull: more data, a bigger model (`--n_layer`, `--n_embd`), a longer context
(`--block_size`), more steps — and eventually swapping NumPy for a GPU array
library (`LLM_BACKEND=cupy`).
