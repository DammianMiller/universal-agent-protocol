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
export LLAMA_CHAT_TEMPLATE_FILE="${LLAMA_CHAT_TEMPLATE_FILE:-${ROOT_DIR}/tools/agents/config/qwen-sharp.jinja}"
export LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"
# Model id advertised to API clients (llama-server --alias, comma-separated).
#
# Without it the server advertises the GGUF PATH as its only model id, so every
# client config that names the model in a human way misses, and the proxy has to
# rewrite the model on every single request (MODEL REWRITE, 6 in a 3h window on
# 2026-08-25) while `/v1/models` returns something no config would ever contain.
# Defaulting to the GGUF basename makes the served id a name rather than a path
# even when nothing is configured; list extra comma-separated aliases to keep
# older client configs resolving through a model change.
# Single-dash expansion, matching LLAMA_SLOT_SAVE_PATH below: unset -> derived
# default; set-but-empty -> stays empty and the flag is omitted; set -> that
# value. The opt-out matters because a second --alias does NOT override the
# first -- llama.cpp UNIONS them -- so LLAMA_EXTRA_ARGS is not an escape hatch
# for this flag the way it is for --mmproj.
_llama_model_base="${LLAMA_MODEL##*/}"
export LLAMA_ALIAS="${LLAMA_ALIAS-${_llama_model_base%.gguf}}"
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
  --temp "${LLAMA_TEMP:-0.3}"
)

# top-p/top-k are optional; llama-server has its own defaults (top-p 0.95,
# top-k 40) when omitted, so only add the flags when a profile sets them.
[[ -n "${LLAMA_TOP_P:-}" ]] && args+=(--top-p "$LLAMA_TOP_P")
[[ -n "${LLAMA_TOP_K:-}" ]] && args+=(--top-k "$LLAMA_TOP_K")

if [[ -n "$LLAMA_CACHE_REUSE" ]]; then
  args+=(--cache-reuse "$LLAMA_CACHE_REUSE")
fi

if [[ "$LLAMA_CHAT_TEMPLATE_FILE" != "embedded" ]]; then
  args+=(--chat-template-file "$LLAMA_CHAT_TEMPLATE_FILE")
fi

if [[ "$LLAMA_ENABLE_SPEC_DECODING" == "true" ]]; then
  # A draft-* spec type that needs a drafter FILE must fail loudly when that file
  # is missing, not fall through. Without this the else-branch below silently
  # launches with self-speculation flags the engine then ignores for a dflash
  # config (common/speculative.cpp only registers DRAFT_DFLASH when a draft
  # context exists), so the server starts, answers correctly, and runs with
  # speculation entirely OFF -- measured ~41 tok/s against ~92 with the drafter.
  # No error, nothing in the log an operator would notice. The drafter lives
  # outside the repo, so "the file moved" is the likely failure, not a rare one.
  # draft-mtp is exempt: it reads its head from --model and needs no file.
  if [[ "${LLAMA_SPEC_TYPE:-}" == draft-* && "${LLAMA_SPEC_TYPE:-}" != "draft-mtp" \
        && -n "${LLAMA_DRAFT_MODEL:-}" && ! -f "${LLAMA_DRAFT_MODEL}" ]]; then
    echo "ERROR: LLAMA_SPEC_TYPE=$LLAMA_SPEC_TYPE needs a draft model, but" >&2
    echo "       LLAMA_DRAFT_MODEL does not exist: $LLAMA_DRAFT_MODEL" >&2
    echo "       Refusing to start with speculation silently disabled." >&2
    exit 1
  fi
  if [[ -n "${LLAMA_DRAFT_MODEL:-}" && -f "${LLAMA_DRAFT_MODEL}" ]]; then
    # Draft model speculation (separate small model for drafting).
    #
    # --spec-type selects HOW the draft model is consumed and is NOT implied by
    # --model-draft. A trained MTP head (gemma4-assistant arch) is only valid
    # under `draft-mtp`; passing it without the flag leaves the server on its
    # default draft strategy and the head is either ignored or misread. Emit
    # any explicit draft-* type here so the profile's LLAMA_SPEC_TYPE is
    # honoured. `none`/empty keeps the previous behaviour (flag omitted), and
    # ngram-* types are meaningless in the draft-model branch, so they are
    # left to the self-speculation branch below.
    if [[ "${LLAMA_SPEC_TYPE:-}" == draft-* ]]; then
      args+=(--spec-type "$LLAMA_SPEC_TYPE")
    fi
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

if [[ -n "$LLAMA_ALIAS" ]]; then
  args+=( --alias "$LLAMA_ALIAS" )
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
#   2. LLAMA_MMPROJ=none/disabled                     -> vision off, no auto-detect
#   3. LLAMA_MMPROJ set to a path                      -> used verbatim
#   4. auto-discover a projector alongside LLAMA_MODEL -> vision follows the model
# Swap LLAMA_MODEL and vision re-homes automatically; a model with no companion
# projector simply serves text-only (no error). LLAMA_MMPROJ=none/disabled is
# distinct from LLAMA_MMPROJ being unset/empty: unset still auto-detects, since
# an empty string is not a reliable "turn it off" signal across profiles.
if [[ " ${args[*]} " != *" --mmproj "* && "${LLAMA_MMPROJ:-}" != "none" && "${LLAMA_MMPROJ:-}" != "disabled" ]]; then
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
