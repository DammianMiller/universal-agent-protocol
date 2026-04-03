#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/.worktrees/turboquant-cuda-v2/build-pq/bin/llama-server}"
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
export LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-131072}"
export LLAMA_THREADS="${LLAMA_THREADS:-32}"
export LLAMA_GPU_LAYERS="${LLAMA_GPU_LAYERS:-99}"
export LLAMA_BATCH_SIZE="${LLAMA_BATCH_SIZE:-512}"
export LLAMA_UBATCH_SIZE="${LLAMA_UBATCH_SIZE:-512}"
export LLAMA_ENABLE_SPEC_DECODING="${LLAMA_ENABLE_SPEC_DECODING:-true}"
export LLAMA_SPEC_TYPE="${LLAMA_SPEC_TYPE:-ngram-cache}"
export LLAMA_DRAFT_MAX="${LLAMA_DRAFT_MAX:-8}"
export LLAMA_DRAFT_MIN="${LLAMA_DRAFT_MIN:-3}"
export LLAMA_DRAFT_P_MIN="${LLAMA_DRAFT_P_MIN:-0.75}"
export LLAMA_HYBRID_ROLLBACK_MODE="${LLAMA_HYBRID_ROLLBACK_MODE:-strict}"
export LLAMA_LOG_FILE="${LLAMA_LOG_FILE:-llama-server.log}"
export LLAMA_CHAT_TEMPLATE_FILE="${LLAMA_CHAT_TEMPLATE_FILE:-${ROOT_DIR}/tools/agents/config/chat_template.jinja}"
export LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"

if [[ ! -f "$LLAMA_CHAT_TEMPLATE_FILE" ]]; then
  echo "ERROR: LLAMA_CHAT_TEMPLATE_FILE not found: $LLAMA_CHAT_TEMPLATE_FILE" >&2
  exit 1
fi

args=(
  --model "$LLAMA_MODEL"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
  --threads "$LLAMA_THREADS"
  --ctx-size "$LLAMA_CTX_SIZE"
  --cache-type-k "${LLAMA_CACHE_TYPE_K:-q8_0}"
  --cache-type-v "${LLAMA_CACHE_TYPE_V:-q4_0}"
  --gpu-layers "$LLAMA_GPU_LAYERS"
  --flash-attn on
  --batch-size "$LLAMA_BATCH_SIZE"
  --ubatch-size "$LLAMA_UBATCH_SIZE"
  --parallel "${LLAMA_PARALLEL:-1}"
  --no-context-shift
  --n-predict 81920
  --repeat-penalty 1.05
  --chat-template-file "$LLAMA_CHAT_TEMPLATE_FILE"
  --log-file "$LLAMA_LOG_FILE"
  --temp 0.3
)

if [[ "$LLAMA_ENABLE_SPEC_DECODING" == "true" ]]; then
  args+=(
    --spec-type "$LLAMA_SPEC_TYPE"
    --draft-max "$LLAMA_DRAFT_MAX"
    --draft-min "$LLAMA_DRAFT_MIN"
    --draft-p-min "$LLAMA_DRAFT_P_MIN"
  )
fi

if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  extra=( $LLAMA_EXTRA_ARGS )
  args+=("${extra[@]}")
fi

exec "$LLAMA_BIN" "${args[@]}"
