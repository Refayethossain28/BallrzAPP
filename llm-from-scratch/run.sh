#!/usr/bin/env bash
# One-command launcher: trains a model if no checkpoint exists yet, then drops
# you into the interactive chat loop. Just run:  ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

CKPT="ckpt.npz"
STEPS="${STEPS:-2000}"   # override with: STEPS=500 ./run.sh

# Make sure NumPy is available.
python -c "import numpy" 2>/dev/null || pip install -r requirements.txt

# Train only if we don't already have a checkpoint.
if [ ! -f "$CKPT" ]; then
  echo "No checkpoint found — training a model ($STEPS steps)..."
  python train.py --steps "$STEPS"
else
  echo "Found existing $CKPT — skipping training."
  echo "(Delete it or run 'python train.py' to retrain.)"
fi

echo
echo "Launching interactive mode..."
python chat.py --ckpt "$CKPT"
