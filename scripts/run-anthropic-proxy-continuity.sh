#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PROXY_PORT="${PROXY_PORT:-4000}"
export LLAMA_CPP_BASE="${LLAMA_CPP_BASE:-http://127.0.0.1:8080/v1}"
export PROXY_LOG_LEVEL="${PROXY_LOG_LEVEL:-INFO}"

export PROXY_LOOP_BREAKER="${PROXY_LOOP_BREAKER:-on}"
export PROXY_LOOP_WINDOW="${PROXY_LOOP_WINDOW:-6}"
export PROXY_LOOP_REPEAT_THRESHOLD="${PROXY_LOOP_REPEAT_THRESHOLD:-8}"
export PROXY_FORCED_THRESHOLD="${PROXY_FORCED_THRESHOLD:-15}"
export PROXY_NO_PROGRESS_THRESHOLD="${PROXY_NO_PROGRESS_THRESHOLD:-4}"
export PROXY_CONTEXT_RELEASE_THRESHOLD="${PROXY_CONTEXT_RELEASE_THRESHOLD:-0.90}"
export PROXY_GUARDRAIL_RETRY="${PROXY_GUARDRAIL_RETRY:-on}"
export PROXY_SESSION_TTL_SECS="${PROXY_SESSION_TTL_SECS:-7200}"
export PROXY_TOOL_CALL_GRAMMAR="${PROXY_TOOL_CALL_GRAMMAR:-on}"
export PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY="${PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY:-on}"
export PROXY_TOOL_CALL_GRAMMAR_PATH="${PROXY_TOOL_CALL_GRAMMAR_PATH:-${ROOT_DIR}/tools/agents/config/tool-call.gbnf}"

# ---------------------------------------------------------------------------
# Auto-detect context window from upstream llama-server /slots endpoint.
# Waits up to 60s for the server to be ready. Falls back to env var or 131072.
# This ensures the proxy always matches the server's actual per-slot context,
# even after server restarts with different --ctx-size / --parallel settings.
# ---------------------------------------------------------------------------
if [ "${PROXY_CONTEXT_WINDOW:-0}" = "0" ]; then
    SLOTS_URL="${LLAMA_CPP_BASE/\/v1/}/slots"
    echo "[proxy-startup] Detecting context window from ${SLOTS_URL}..."
    for i in $(seq 1 30); do
        CTX=$(curl -sf --max-time 2 "$SLOTS_URL" 2>/dev/null \
            | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['n_ctx'])" 2>/dev/null)
        if [ -n "$CTX" ] && [ "$CTX" -gt 0 ]; then
            export PROXY_CONTEXT_WINDOW="$CTX"
            echo "[proxy-startup] Auto-detected context window: ${CTX} tokens"
            break
        fi
        sleep 2
    done
    if [ "${PROXY_CONTEXT_WINDOW:-0}" = "0" ]; then
        export PROXY_CONTEXT_WINDOW=131072
        echo "[proxy-startup] WARNING: Could not detect context, using default: 131072"
    fi
fi

cd "$ROOT_DIR"
exec python3 tools/agents/scripts/anthropic_proxy.py
