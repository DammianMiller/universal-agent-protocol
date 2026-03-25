#!/bin/bash
# Mission init script - idempotent environment setup
set -e

UAP_DIR="/home/cogtek/dev/miller-tech/universal-agent-protocol"
LLAMA_DIR="/home/cogtek/llama.cpp"

# Install UAP dependencies if needed
if [ ! -d "$UAP_DIR/node_modules" ]; then
  cd "$UAP_DIR" && npm install
fi

# Verify llama.cpp worktrees exist
for wt in 002-baseline-origin-master 003-faststate-029; do
  if [ ! -d "$LLAMA_DIR/.worktrees/$wt" ]; then
    echo "ERROR: llama.cpp worktree $wt not found"
    exit 1
  fi
done

# Verify model files exist
for model in "Qwen3.5-35B-A3B-UD-IQ4_XS.gguf" "Qwen3.5-0.8B-Q8_0.gguf"; do
  if [ ! -f "/home/cogtek/Downloads/$model" ]; then
    echo "WARNING: Model $model not found in ~/Downloads"
  fi
done

# Verify CUDA build exists for worktree 003
if [ ! -f "$LLAMA_DIR/.worktrees/003-faststate-029/build-cuda/bin/llama-server" ]; then
  echo "NOTE: CUDA build not found for worktree 003, will need to build"
fi

echo "Init complete"
