"""Array backend for the from-scratch stack — numpy by default, CuPy on GPU.

Every module in the training stack imports `np` from here instead of importing
numpy directly. That single indirection is the whole GPU story:

    LLM_BACKEND=cupy python train.py ...     # every tensor op runs on CUDA

CuPy is a drop-in implementation of the NumPy API on NVIDIA GPUs, so the
hand-written autograd, transformer, and Adam optimizer run unchanged — the
arrays just live in GPU memory. On a free Colab T4 this makes training a
17M-parameter model practical (~10-30x faster than the CPU runners).

`to_numpy()` brings an array back to host memory — needed at the boundaries
(checkpoint files, JSON export, sampling probabilities) — and is a cheap
identity under the numpy backend. Host-side concerns (batch-index RNG, .npz
files) stay on plain numpy in the callers.
"""
from __future__ import annotations

import os

BACKEND = os.environ.get("LLM_BACKEND", "numpy").lower()

if BACKEND == "cupy":
    import cupy as np  # noqa: F401  (the whole point: np *is* cupy)
    import cupyx
    GPU = True

    def to_numpy(a):
        return np.asnumpy(a) if isinstance(a, np.ndarray) else a

    def index_add(target, idx, values):
        """target[idx] += values with repeated-index accumulation (GPU)."""
        cupyx.scatter_add(target, idx, values)
else:
    import numpy as np  # noqa: F401
    GPU = False

    def to_numpy(a):
        return a

    def index_add(target, idx, values):
        """target[idx] += values with repeated-index accumulation."""
        np.add.at(target, idx, values)
