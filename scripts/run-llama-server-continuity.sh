#!/usr/bin/env bash
set -euo pipefail

LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/build-cuda/bin/llama-server}"
LLAMA_MODEL="${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf}"

if [[ ! -x "$LLAMA_BIN" ]]; then
  echo "ERROR: LLAMA_BIN is not executable: $LLAMA_BIN" >&2
  exit 1
fi

if [[ ! -f "$LLAMA_MODEL" ]]; then
  echo "ERROR: LLAMA_MODEL not found: $LLAMA_MODEL" >&2
  exit 1
fi

export LLAMA_HOST="${LLAMA_HOST:-0.0.0.0}"
export LLAMA_PORT="${LLAMA_PORT:-8080}"
export LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-262144}"
export LLAMA_THREADS="${LLAMA_THREADS:-32}"
export LLAMA_GPU_LAYERS="${LLAMA_GPU_LAYERS:-99}"
export LLAMA_BATCH_SIZE="${LLAMA_BATCH_SIZE:-512}"
export LLAMA_UBATCH_SIZE="${LLAMA_UBATCH_SIZE:-512}"
export LLAMA_SPEC_TYPE="${LLAMA_SPEC_TYPE:-ngram-cache}"
export LLAMA_HYBRID_ROLLBACK_MODE="${LLAMA_HYBRID_ROLLBACK_MODE:-strict}"
export LLAMA_LOG_FILE="${LLAMA_LOG_FILE:-llama-server.log}"

exec "$LLAMA_BIN" \
  --model "$LLAMA_MODEL" \
  --host "$LLAMA_HOST" \
  --port "$LLAMA_PORT" \
  --threads "$LLAMA_THREADS" \
  --ctx-size "$LLAMA_CTX_SIZE" \
  --cache-type-k q4_0 \
  --cache-type-v q4_0 \
  --gpu-layers "$LLAMA_GPU_LAYERS" \
  --flash-attn on \
  --batch-size "$LLAMA_BATCH_SIZE" \
  --ubatch-size "$LLAMA_UBATCH_SIZE" \
  --parallel 1 \
  --no-context-shift \
  --n-predict 32768 \
  --repeat-penalty 1.0 \
  --defrag-thold 0.1 \
  --spec-type "$LLAMA_SPEC_TYPE" \
  --log-file "$LLAMA_LOG_FILE"
