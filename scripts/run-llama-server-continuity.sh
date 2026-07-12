#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/.worktrees/mtp-port/build/bin/llama-server}"
LLAMA_MODEL="${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.6-35B-A3B-UD-IQ4_XS-MTP.gguf}"

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
export LLAMA_SPEC_TYPE="${LLAMA_SPEC_TYPE:-draft-mtp}"
export LLAMA_DRAFT_MAX="${LLAMA_DRAFT_MAX:-3}"
export LLAMA_DRAFT_MIN="${LLAMA_DRAFT_MIN:-1}"
export LLAMA_DRAFT_P_MIN="${LLAMA_DRAFT_P_MIN:-0.75}"
export LLAMA_HYBRID_ROLLBACK_MODE="${LLAMA_HYBRID_ROLLBACK_MODE:-strict}"
export LLAMA_REPEAT_PENALTY="${LLAMA_REPEAT_PENALTY:-1.05}"
export LLAMA_CACHE_REUSE="${LLAMA_CACHE_REUSE:-}"
export LLAMA_LOG_FILE="${LLAMA_LOG_FILE:-llama-server.log}"
export LLAMA_CHAT_TEMPLATE_FILE="${LLAMA_CHAT_TEMPLATE_FILE:-${ROOT_DIR}/tools/agents/config/chat_template.jinja}"
export LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"
# Slot KV-state save directory. Default ON: the anthropic-proxy's
# cross-session slot save/restore (UAP PR #179) requires the server to be
# launched with --slot-save-path, otherwise /slots/{id}?action=save|restore
# is rejected and the proxy falls back to 60-96s full prompt reprocessing on
# every session switch. Set LLAMA_SLOT_SAVE_PATH= (explicitly empty) to
# disable. Single-dash default expansion: unset -> default path;
# set-but-empty -> stays empty (disabled); set -> that path. ${HOME:-}
# guards against an unset HOME under `set -u` (mkdir then fails gracefully).
export LLAMA_SLOT_SAVE_PATH="${LLAMA_SLOT_SAVE_PATH-${HOME:-}/.cache/uap/llama-slots}"

# Set LLAMA_CHAT_TEMPLATE_FILE=embedded to use the model's own template
# (skip the --chat-template-file flag). Required for models with custom formats
# that aren't ChatML (e.g. Gemma-4 with <|turn>/<|tool_call> DSL).
if [[ "$LLAMA_CHAT_TEMPLATE_FILE" != "embedded" && ! -f "$LLAMA_CHAT_TEMPLATE_FILE" ]]; then
  echo "ERROR: LLAMA_CHAT_TEMPLATE_FILE not found: $LLAMA_CHAT_TEMPLATE_FILE" >&2
  exit 1
fi

args=(
  --model "$LLAMA_MODEL"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
  --threads "$LLAMA_THREADS"
  --ctx-size "$LLAMA_CTX_SIZE"
  --cache-type-k "${LLAMA_CACHE_TYPE_K:-q4_0}"
  --cache-type-v "${LLAMA_CACHE_TYPE_V:-q4_0}"
  --gpu-layers "$LLAMA_GPU_LAYERS"
  --flash-attn on
  --batch-size "$LLAMA_BATCH_SIZE"
  --ubatch-size "$LLAMA_UBATCH_SIZE"
  --parallel "${LLAMA_PARALLEL:-1}"
  --no-context-shift
  --n-predict "${LLAMA_N_PREDICT:-81920}"
  --repeat-penalty "$LLAMA_REPEAT_PENALTY"
  --log-file "$LLAMA_LOG_FILE"
  --temp 0.3
)

if [[ -n "$LLAMA_CACHE_REUSE" ]]; then
  args+=(--cache-reuse "$LLAMA_CACHE_REUSE")
fi

if [[ "$LLAMA_CHAT_TEMPLATE_FILE" != "embedded" ]]; then
  args+=(--chat-template-file "$LLAMA_CHAT_TEMPLATE_FILE")
fi

if [[ "$LLAMA_ENABLE_SPEC_DECODING" == "true" ]]; then
  if [[ -n "${LLAMA_DRAFT_MODEL:-}" && -f "${LLAMA_DRAFT_MODEL}" ]]; then
    # Draft model speculation (separate small model for drafting)
    args+=(
      --model-draft "$LLAMA_DRAFT_MODEL"
      --gpu-layers-draft "${LLAMA_DRAFT_GPU_LAYERS:-99}"
      --spec-draft-n-max "$LLAMA_DRAFT_MAX"
      --spec-draft-n-min "$LLAMA_DRAFT_MIN"
      --spec-draft-p-min "$LLAMA_DRAFT_P_MIN"
    )
    [[ -n "${LLAMA_DRAFT_CTX_SIZE:-}" ]] && args+=(--ctx-size-draft "$LLAMA_DRAFT_CTX_SIZE")
    [[ -n "${LLAMA_DRAFT_CACHE_TYPE_K:-}" ]] && args+=(--cache-type-k-draft "$LLAMA_DRAFT_CACHE_TYPE_K")
    [[ -n "${LLAMA_DRAFT_CACHE_TYPE_V:-}" ]] && args+=(--cache-type-v-draft "$LLAMA_DRAFT_CACHE_TYPE_V")
  else
    # Self-speculation via ngram-cache (no draft model)
    args+=(
      --spec-type "$LLAMA_SPEC_TYPE"
      --spec-draft-n-max "$LLAMA_DRAFT_MAX"
      --spec-draft-n-min "$LLAMA_DRAFT_MIN"
      --spec-draft-p-min "$LLAMA_DRAFT_P_MIN"
    )
  fi
fi

if [[ -n "$LLAMA_SLOT_SAVE_PATH" ]]; then
  # Create the dir if possible; if creation fails (e.g. unwritable parent),
  # warn and skip the flag rather than aborting the whole server launch —
  # the proxy's slot save/restore degrades gracefully to reprocessing.
  if mkdir -p "$LLAMA_SLOT_SAVE_PATH" 2>/dev/null; then
    args+=(--slot-save-path "$LLAMA_SLOT_SAVE_PATH")
  else
    echo "WARNING: cannot create LLAMA_SLOT_SAVE_PATH=$LLAMA_SLOT_SAVE_PATH; --slot-save-path omitted" >&2
  fi
fi

if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  extra=( $LLAMA_EXTRA_ARGS )
  args+=("${extra[@]}")
fi

# ── Vision projector: default to the ACTIVE model ────────────────────────────
# The mmproj (multimodal vision projector) should track whichever model is
# actually serving, not a pinned path. Precedence:
#   1. explicit --mmproj already in LLAMA_EXTRA_ARGS  -> respected (override)
#   2. LLAMA_MMPROJ set                               -> used verbatim
#   3. auto-discover a projector alongside LLAMA_MODEL -> vision follows the model
# Swap LLAMA_MODEL and vision re-homes automatically; a model with no companion
# projector simply serves text-only (no error).
if [[ " ${args[*]} " != *" --mmproj "* ]]; then
  mmproj=""
  if [[ -n "${LLAMA_MMPROJ:-}" ]]; then
    mmproj="$LLAMA_MMPROJ"
  else
    model_dir="$(dirname "$LLAMA_MODEL")"
    model_base="$(basename "$LLAMA_MODEL")"; model_base="${model_base%.gguf}"
    # Prefer a projector whose name shares the model's leading token (e.g.
    # "Qwen3.6-…" → "Qwen3.6-…-mmproj*"), then any generic mmproj in the dir.
    model_stem="${model_base%%-*}"
    for cand in \
      "$model_dir/${model_base}"*mmproj*.gguf \
      "$model_dir/"*"${model_stem}"*mmproj*.gguf \
      "$model_dir/"mmproj*F16.gguf \
      "$model_dir/"mmproj*.gguf \
      "$model_dir/"*mmproj*.gguf; do
      if [[ -f "$cand" ]]; then mmproj="$cand"; break; fi
    done
  fi
  if [[ -n "$mmproj" && -f "$mmproj" ]]; then
    args+=(--mmproj "$mmproj")
    echo "vision: mmproj auto-selected for active model → $mmproj" >&2
  else
    echo "vision: no mmproj projector found for $(basename "$LLAMA_MODEL") — serving text-only" >&2
  fi
fi

exec "$LLAMA_BIN" "${args[@]}"
