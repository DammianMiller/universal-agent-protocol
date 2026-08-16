#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Fail-safe passthrough default: when ANTHROPIC_PASSTHROUGH_MODELS is unset OR
# EMPTY, default it to __local_only__ (no api.anthropic.com forwarding) rather
# than the code's empty=forward-cloud default. Set here in the ExecStart script
# so it wins over systemd's EnvironmentFile (which overrides Environment=, so a
# systemd Environment= pin cannot hold) and over the env file drifting back to
# empty via `uap model routing use`/setup. An operator who genuinely wants cloud
# passthrough sets an explicit non-empty value (a comma list of claude- ids),
# which is preserved. This is the durable enforcement of the local-only policy.
export ANTHROPIC_PASSTHROUGH_MODELS="${ANTHROPIC_PASSTHROUGH_MODELS:-__local_only__}"

export PROXY_PORT="${PROXY_PORT:-4000}"
export LLAMA_CPP_BASE="${LLAMA_CPP_BASE:-http://127.0.0.1:8080/v1}"
export PROXY_LOG_LEVEL="${PROXY_LOG_LEVEL:-INFO}"

# ---------------------------------------------------------------------------
# Upstream resolution. LLAMA_CPP_BASE above is a PIN, and a pin goes stale:
# Unsloth Studio restarts its bundled llama-server on a new random port each
# launch (:50047 -> :34407 -> :59879 observed), after which every local request
# 529s until the env file is hand-edited — and that file is self-protect'd, so
# the agent cannot repair it. Resolve against reality instead: the pin is kept
# whenever it answers /health, and only a proven-dead pin falls through to
# discovering the live llama-server. Set UAP_LLAMA_UPSTREAM_AUTODISCOVER=off to
# pin hard. Must run BEFORE the context-window probe below, which reads
# LLAMA_CPP_BASE.
# ---------------------------------------------------------------------------
# Sourced defensively. Under `set -e` an unreadable lib would abort the script
# BEFORE exec, and the unit's Restart=always/RestartSec=3 would then respawn it
# every three seconds with no proxy at all — strictly worse than the stale pin
# this resolves. scripts/lib is not in package.json `files`, so an installed
# deployment can legitimately lack it. Degrade to the pin instead.
_upstream_lib="${ROOT_DIR}/scripts/lib/llama-upstream.sh"
if [ -r "$_upstream_lib" ]; then
    # shellcheck source=lib/llama-upstream.sh
    . "$_upstream_lib"
else
    echo "[proxy-startup] WARNING: ${_upstream_lib} missing; using pinned upstream without discovery" >&2
    llama_upstream_resolve() { printf '%s' "${1:-}"; }
    llama_upstream_root() { local b="${1:-}"; b="${b%/}"; printf '%s' "${b%/v1}"; }
fi
_resolved_base="$(llama_upstream_resolve "$LLAMA_CPP_BASE")"
# An empty result would export LLAMA_CPP_BASE="" and degrade every upstream URL
# to a bare "/chat/completions"; keep the pin instead.
[ -n "$_resolved_base" ] || _resolved_base="$LLAMA_CPP_BASE"
if [ "$_resolved_base" != "$LLAMA_CPP_BASE" ]; then
    echo "[proxy-startup] pinned upstream ${LLAMA_CPP_BASE} is unreachable; using discovered ${_resolved_base}"
    export LLAMA_CPP_BASE="$_resolved_base"
else
    echo "[proxy-startup] upstream: ${LLAMA_CPP_BASE}"
fi

export PROXY_LOOP_BREAKER="${PROXY_LOOP_BREAKER:-on}"
export PROXY_LOOP_WINDOW="${PROXY_LOOP_WINDOW:-6}"
export PROXY_LOOP_REPEAT_THRESHOLD="${PROXY_LOOP_REPEAT_THRESHOLD:-8}"
export PROXY_FORCED_THRESHOLD="${PROXY_FORCED_THRESHOLD:-15}"
export PROXY_NO_PROGRESS_THRESHOLD="${PROXY_NO_PROGRESS_THRESHOLD:-4}"
export PROXY_CONTEXT_RELEASE_THRESHOLD="${PROXY_CONTEXT_RELEASE_THRESHOLD:-0.90}"
export PROXY_GUARDRAIL_RETRY="${PROXY_GUARDRAIL_RETRY:-on}"
export PROXY_SESSION_TTL_SECS="${PROXY_SESSION_TTL_SECS:-7200}"

# Cross-session slot save/restore (UAP PR #179). Default ON: with
# llama-server on --parallel 1 (a single slot), N agentic sessions
# multiplexing the slot each evict the prior session's KV cache, forcing
# 60-96s full prompt reprocesses (~17% of requests). The proxy saves the
# outgoing session's slot state and restores the incoming session's on a
# switch. PROXY_SLOT_SAVE_DIR must match llama-server's --slot-save-path
# (run-llama-server-continuity.sh LLAMA_SLOT_SAVE_PATH). Set
# PROXY_SLOT_SAVE_RESTORE=off to disable.
export PROXY_SLOT_SAVE_RESTORE="${PROXY_SLOT_SAVE_RESTORE:-on}"
export PROXY_SLOT_SAVE_DIR="${PROXY_SLOT_SAVE_DIR:-${HOME}/.cache/uap/llama-slots}"
export PROXY_SLOT_CACHE_MAX_FILES="${PROXY_SLOT_CACHE_MAX_FILES:-12}"

export PROXY_TOOL_CALL_GRAMMAR="${PROXY_TOOL_CALL_GRAMMAR:-on}"
export PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY="${PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY:-on}"
export PROXY_TOOL_CALL_GRAMMAR_PATH="${PROXY_TOOL_CALL_GRAMMAR_PATH:-${ROOT_DIR}/tools/agents/config/tool-call.gbnf}"

# Structured thinking grammar (opt-in). When on, non-tool reasoning turns
# are constrained to emit a compact <think> Q/M/K/R/V header before output.
export PROXY_THINKING_GRAMMAR="${PROXY_THINKING_GRAMMAR:-off}"
export PROXY_THINKING_GRAMMAR_PATH="${PROXY_THINKING_GRAMMAR_PATH:-${ROOT_DIR}/tools/agents/config/thinking.gbnf}"

# ---------------------------------------------------------------------------
# Auto-detect context window from upstream llama-server /slots endpoint.
# Waits up to 60s for the server to be ready. Falls back to env var or 131072.
# This ensures the proxy always matches the server's actual per-slot context,
# even after server restarts with different --ctx-size / --parallel settings.
# ---------------------------------------------------------------------------
if [ "${PROXY_CONTEXT_WINDOW:-0}" = "0" ]; then
    # Was an inline ${LLAMA_CPP_BASE/\/v1/} substitution, which strips the FIRST
    # "/v1" anywhere in the string; llama_upstream_root strips only a trailing
    # one. Same job, one rule.
    SLOTS_URL="$(llama_upstream_root "$LLAMA_CPP_BASE")/slots"
    echo "[proxy-startup] Detecting context window from ${SLOTS_URL}..."
    for i in $(seq 1 30); do
        CTX=$(curl -sf --max-time 2 -- "$SLOTS_URL" 2>/dev/null \
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

# Startup resolution alone still strands a LONG-LIVED proxy: llama can move
# ports hours after the proxy came up. Watch it in the background and stop the
# proxy once the upstream has demonstrably moved, so the supervisor restarts it
# through resolution above. $$ is the proxy's PID after the exec below, and the
# watcher dies with it via the unit's control group.
#
# SUPERVISED ONLY. src/cli/proxy.ts also launches this script as a detached,
# unsupervised `spawn(...)` when the systemd unit is not installed (fresh
# installs, UAP_PROXY_NO_SYSTEMD=1, containers, bench hosts). There, stopping
# the proxy is not a restart — it is the end of the proxy, which is strictly
# worse than pointing at a dead upstream, and on a bench host it would score as
# model failure rather than infrastructure failure. systemd sets INVOCATION_ID,
# so use it as the supervisor probe. UAP_LLAMA_UPSTREAM_WATCH=on forces the
# watcher on (for another supervisor), =off disables it everywhere.
_watch="${UAP_LLAMA_UPSTREAM_WATCH:-auto}"
if command -v llama_upstream_watch >/dev/null 2>&1 &&
   { [ "$_watch" = "on" ] || { [ "$_watch" = "auto" ] && [ -n "${INVOCATION_ID:-}" ]; }; }; then
    llama_upstream_watch "$LLAMA_CPP_BASE" "$$" &
fi

exec python3 tools/agents/scripts/anthropic_proxy.py
