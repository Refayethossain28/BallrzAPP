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
| `tokenizer.py` | A character-level tokenizer (one token per distinct character). |
| `optim.py` | The Adam optimizer and gradient-norm clipping, implemented from scratch. |
| `train.py` | The training loop: batch sampling, forward, backprop, optimizer step, evaluation, checkpointing. |
| `sample.py` | Load a checkpoint and generate text from a prompt. |
| `test_autograd.py` | A gradient check: compares backprop's analytic gradients against finite-difference numeric gradients through a real GPT forward pass. |
| `data/input.txt` | A small sample corpus to train on. |

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

```bash
pip install -r requirements.txt

# 1. Verify the autograd engine is correct (numeric gradient check)
python test_autograd.py

# 2. Train on the sample corpus (~2 min on CPU)
python train.py --steps 2000 --n_layer 4 --n_embd 128

# 3. Generate from the trained checkpoint
python sample.py --prompt "The game" --tokens 400
```

Train on your own text by pointing `--data` at any UTF-8 file:

```bash
python train.py --data path/to/your.txt --steps 3000 --block_size 128
```

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
