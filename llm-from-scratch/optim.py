"""The AdamW optimizer, implemented from scratch.

Adam keeps a running estimate of the first moment (mean) and second moment
(uncentered variance) of each parameter's gradient, and uses them to adapt the
per-parameter step size. This is what nearly every transformer is trained with.

The "W" is *decoupled* weight decay (Loshchilov & Hutter): the decay is applied
directly to the weights, `p -= lr * wd * p`, NOT folded into the gradient that
Adam normalises — folding it in (plain L2) lets Adam's second moment cancel most
of it, so the decay you asked for is not the decay you get. Decay is applied
only to the parameters you pass as `decay_params` (the weight matrices); norm
gains and biases are left alone, as in GPT-2/Llama training.
"""

from __future__ import annotations

from backend import np  # numpy, or CuPy when LLM_BACKEND=cupy


class AdamW:
    def __init__(self, params, lr=3e-4, betas=(0.9, 0.95), eps=1e-8, weight_decay=0.0,
                 decay_params=None):
        self.params = list(params)
        self.lr = lr
        self.b1, self.b2 = betas
        self.eps = eps
        self.wd = weight_decay
        decay_ids = {id(p) for p in (self.params if decay_params is None else decay_params)}
        self.decay = [id(p) in decay_ids for p in self.params]
        self.m = [np.zeros_like(p.data) for p in self.params]
        self.v = [np.zeros_like(p.data) for p in self.params]
        self.t = 0

    def zero_grad(self):
        for p in self.params:
            p.grad = None

    def step(self):
        self.t += 1
        bc1 = 1 - self.b1 ** self.t
        bc2 = 1 - self.b2 ** self.t
        for i, p in enumerate(self.params):
            if p.grad is None:
                continue
            g = p.grad
            if self.wd and self.decay[i]:
                p.data -= self.lr * self.wd * p.data      # decoupled weight decay
            self.m[i] = self.b1 * self.m[i] + (1 - self.b1) * g
            self.v[i] = self.b2 * self.v[i] + (1 - self.b2) * (g * g)
            mhat = self.m[i] / bc1
            vhat = self.v[i] / bc2
            p.data -= self.lr * mhat / (np.sqrt(vhat) + self.eps)


Adam = AdamW  # the old name still works (with weight_decay=0 it IS plain Adam)


def clip_grad_norm(params, max_norm):
    """Rescale all gradients so their global L2 norm is at most `max_norm`."""
    total = 0.0
    for p in params:
        if p.grad is not None:
            total += float(np.sum(p.grad * p.grad))
    norm = total ** 0.5
    if norm > max_norm and norm > 0:
        scale = max_norm / (norm + 1e-6)
        for p in params:
            if p.grad is not None:
                p.grad = p.grad * scale
    return norm
