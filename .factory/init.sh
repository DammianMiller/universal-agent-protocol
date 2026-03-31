#!/bin/bash
set -euo pipefail

ROOT_REPO="/home/cogtek/dev/miller-tech/universal-agent-protocol"
WORKTREE="/home/cogtek/dev/miller-tech/universal-agent-protocol/.worktrees/033-proxy-endturn-retry"
PROXY_REQS="$WORKTREE/tools/agents/scripts/requirements-proxy.txt"
LLAMA_BIN="/home/cogtek/llama.cpp/.worktrees/turboquant-cuda-v2/build/bin/llama-server"
MODEL="/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf"

if [ ! -d "$ROOT_REPO/node_modules" ]; then
  cd "$ROOT_REPO"
  npm install
fi

if [ ! -e "$WORKTREE/node_modules" ]; then
  ln -s "$ROOT_REPO/node_modules" "$WORKTREE/node_modules"
fi

python3 -m pip show httpx >/dev/null 2>&1 || python3 -m pip install -r "$PROXY_REQS"

if [ ! -f "$LLAMA_BIN" ]; then
  echo "ERROR: llama-server binary not found at $LLAMA_BIN"
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo "ERROR: model not found at $MODEL"
  exit 1
fi

echo "Mission init complete"
