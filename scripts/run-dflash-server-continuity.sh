#!/usr/bin/env bash
# Launches the lucebox-hub DFlash server (OpenAI + Anthropic compatible) as a
# drop-in replacement for the vanilla llama-server. The Anthropic proxy at
# 127.0.0.1:8080 sits unchanged in front of it.
#
# Repo: https://github.com/Luce-Org/lucebox-hub  (dflash/scripts/server.py)
#
# Important tradeoff: lucebox-hub issue #10 — attention compute scales with
# DFLASH_MAX_CTX, not the actual prompt size. Setting it to 131072 slows
# short requests ~20×. Default 32768 is a balance for agentic workloads;
# tune via DFLASH_MAX_CTX. PROXY_CONTEXT_WINDOW in anthropic-proxy.env must
# match (DFlash has no /slots endpoint, so the proxy can't autodetect).
set -euo pipefail

# Profiles carry `~`-relative paths (a committed template must not ship a
# username, and systemd's EnvironmentFile does not expand `~`) — normalize
# every path-bearing variable onto $HOME before anything reads it.
for _uap_v in DFLASH_ROOT DFLASH_VENV DFLASH_BIN DFLASH_TARGET DFLASH_DRAFT \
              DFLASH_TOKENIZER DFLASH_LOG_FILE; do
  _uap_p="${!_uap_v:-}"
  if [[ "$_uap_p" == '~' ]]; then
    printf -v "$_uap_v" '%s' "${HOME:-}"
  elif [[ "$_uap_p" == '~/'* ]]; then
    printf -v "$_uap_v" '%s' "${HOME:-}${_uap_p#\~}"
  fi
done
unset -v _uap_v _uap_p

DFLASH_ROOT="${DFLASH_ROOT:-$HOME/lucebox/lucebox-hub/dflash}"
DFLASH_VENV="${DFLASH_VENV:-${DFLASH_ROOT}/.venv}"
DFLASH_BIN="${DFLASH_BIN:-${DFLASH_ROOT}/build/test_dflash}"
DFLASH_TARGET="${DFLASH_TARGET:-$HOME/Downloads/Qwen3.6-27B-Q3_K_M.gguf}"
DFLASH_DRAFT="${DFLASH_DRAFT:-${DFLASH_ROOT}/models/draft}"
DFLASH_HOST="${DFLASH_HOST:-0.0.0.0}"
DFLASH_PORT="${DFLASH_PORT:-8080}"
DFLASH_BUDGET="${DFLASH_BUDGET:-16}"
DFLASH_MAX_CTX="${DFLASH_MAX_CTX:-16384}"
DFLASH_FA_WINDOW="${DFLASH_FA_WINDOW:-2048}"
DFLASH_TOKENIZER="${DFLASH_TOKENIZER:-}"
DFLASH_KV_TQ3="${DFLASH_KV_TQ3:-1}"
DFLASH_LOG_FILE="${DFLASH_LOG_FILE:-$HOME/lucebox/lucebox-hub/dflash-server.log}"
DFLASH_EXTRA_ARGS="${DFLASH_EXTRA_ARGS:-}"

if [[ ! -x "$DFLASH_BIN" ]]; then
  echo "ERROR: DFLASH_BIN is not executable: $DFLASH_BIN (build with: cmake --build ${DFLASH_ROOT}/build --target test_dflash)" >&2
  exit 1
fi
if [[ ! -f "$DFLASH_TARGET" ]]; then
  echo "ERROR: DFLASH_TARGET GGUF not found: $DFLASH_TARGET" >&2
  exit 1
fi
if [[ ! -e "$DFLASH_DRAFT" ]]; then
  echo "ERROR: DFLASH_DRAFT not found: $DFLASH_DRAFT" >&2
  exit 1
fi
if [[ ! -x "${DFLASH_VENV}/bin/python" ]]; then
  echo "ERROR: DFlash venv not found at ${DFLASH_VENV}; create with: python3 -m venv ${DFLASH_VENV} && ${DFLASH_VENV}/bin/pip install fastapi uvicorn transformers jinja2 gguf torch" >&2
  exit 1
fi

# TQ3_0 KV cache is required to fit ctx > ~6144 on 24 GB. Server.py also
# auto-enables it via setdefault, but exporting here makes it explicit.
export DFLASH27B_KV_TQ3="${DFLASH_KV_TQ3}"
export DFLASH27B_FA_WINDOW="${DFLASH_FA_WINDOW}"

args=(
  --host "$DFLASH_HOST"
  --port "$DFLASH_PORT"
  --target "$DFLASH_TARGET"
  --draft "$DFLASH_DRAFT"
  --bin "$DFLASH_BIN"
  --budget "$DFLASH_BUDGET"
  --max-ctx "$DFLASH_MAX_CTX"
  --fa-window "$DFLASH_FA_WINDOW"
  --daemon
)
if [[ -n "$DFLASH_TOKENIZER" ]]; then
  args+=(--tokenizer "$DFLASH_TOKENIZER")
fi
if [[ -n "$DFLASH_EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  extra=( $DFLASH_EXTRA_ARGS )
  args+=("${extra[@]}")
fi

cd "$DFLASH_ROOT"
exec "${DFLASH_VENV}/bin/python" scripts/server.py "${args[@]}"
