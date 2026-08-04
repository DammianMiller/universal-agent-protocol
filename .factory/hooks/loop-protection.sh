#!/usr/bin/env bash
# ============================================================
# UAP Loop Protection & Token Budget Circuit Breaker
# ============================================================
# Shared library sourced by all UAP hooks.
# Tracks hook invocation frequency and detects runaway loops
# that waste tokens (and money) by emitting the same system
# reminders, build-gate warnings, or compliance blocks
# hundreds of times in a single session.
#
# MECHANISM:
#   - Maintains a lightweight state file per session
#   - Counts hook invocations per type within sliding windows
#   - Suppresses redundant output after thresholds are hit
#   - Logs suppressed events for post-mortem analysis
#   - Provides hard circuit-breaker after extreme loop counts
#
# USAGE (source from any hook script):
#   source "$(dirname "$0")/loop-protection.sh"
#   if lp_should_suppress "post-tool-use-edit-write"; then
#     exit 0  # skip output, loop detected
#   fi
#   lp_record_invocation "post-tool-use-edit-write"
#
# CONFIGURATION (environment variables):
#   UAP_LP_DISABLED=1           Disable loop protection entirely
#   UAP_LP_SOFT_LIMIT=15        Warn after N invocations per hook (default: 15)
#   UAP_LP_HARD_LIMIT=50        Suppress output after N (default: 50)
#   UAP_LP_CIRCUIT_BREAK=200    Hard stop — emit circuit breaker msg (default: 200)
#   UAP_LP_WINDOW_SECS=300      Sliding window in seconds (default: 300 = 5 min)
#   UAP_LP_DEDUP_SECS=5         Min seconds between identical outputs (default: 5)
# ============================================================

# Guard against re-sourcing
if [ "${_UAP_LOOP_PROTECTION_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || true
fi
_UAP_LOOP_PROTECTION_LOADED=1

# --- Configuration ---
LP_DISABLED="${UAP_LP_DISABLED:-0}"
LP_SOFT_LIMIT="${UAP_LP_SOFT_LIMIT:-15}"
LP_HARD_LIMIT="${UAP_LP_HARD_LIMIT:-50}"
LP_CIRCUIT_BREAK="${UAP_LP_CIRCUIT_BREAK:-200}"
LP_WINDOW_SECS="${UAP_LP_WINDOW_SECS:-300}"
LP_DEDUP_SECS="${UAP_LP_DEDUP_SECS:-5}"

# --- State file location ---
LP_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
LP_STATE_DIR="${LP_PROJECT_DIR}/.uap/loop-protection"
LP_SESSION_ID="${UAP_SESSION_ID:-${SESSION_ID:-default}}"
LP_STATE_FILE="${LP_STATE_DIR}/session-${LP_SESSION_ID}.state"
LP_LOG_FILE="${LP_STATE_DIR}/loop-events.log"

# --- Ensure state directory exists ---
_lp_init() {
  if [ "$LP_DISABLED" = "1" ]; then
    return 0
  fi
  mkdir -p "$LP_STATE_DIR" 2>/dev/null || true
}

# --- Get current epoch seconds (portable) ---
_lp_now() {
  date +%s 2>/dev/null || echo "0"
}

# --- Read counter for a hook type from state file ---
# Format: hook_type|count|first_ts|last_ts|suppressed_count
_lp_read_state() {
  local hook_type="$1"
  if [ ! -f "$LP_STATE_FILE" ]; then
    echo "0|0|0|0"
    return
  fi
  local line
  line=$(grep "^${hook_type}|" "$LP_STATE_FILE" 2>/dev/null | tail -1)
  if [ -z "$line" ]; then
    echo "0|0|0|0"
    return
  fi
  echo "$line" | cut -d'|' -f2-5
}

# --- Write/update counter for a hook type ---
_lp_write_state() {
  local hook_type="$1"
  local count="$2"
  local first_ts="$3"
  local last_ts="$4"
  local suppressed="$5"

  # Atomic update: remove old line, append new
  if [ -f "$LP_STATE_FILE" ]; then
    grep -v "^${hook_type}|" "$LP_STATE_FILE" > "${LP_STATE_FILE}.tmp" 2>/dev/null || true
    mv "${LP_STATE_FILE}.tmp" "$LP_STATE_FILE" 2>/dev/null || true
  fi
  echo "${hook_type}|${count}|${first_ts}|${last_ts}|${suppressed}" >> "$LP_STATE_FILE"
}

# --- Log a loop event for post-mortem ---
_lp_log_event() {
  local level="$1"
  local hook_type="$2"
  local message="$3"
  local now
  now=$(_lp_now)
  echo "${now}|${level}|${hook_type}|${message}" >> "$LP_LOG_FILE" 2>/dev/null || true
}

# ============================================================
# PUBLIC API
# ============================================================

# Check if a hook invocation should be suppressed.
# Returns 0 (true/suppress) if the hook has been called too many times.
# Returns 1 (false/allow) if the hook should proceed normally.
lp_should_suppress() {
  local hook_type="${1:-unknown}"

  if [ "$LP_DISABLED" = "1" ]; then
    return 1  # don't suppress
  fi

  _lp_init

  local state
  state=$(_lp_read_state "$hook_type")
  local count first_ts last_ts suppressed
  count=$(echo "$state" | cut -d'|' -f1)
  first_ts=$(echo "$state" | cut -d'|' -f2)
  last_ts=$(echo "$state" | cut -d'|' -f3)
  suppressed=$(echo "$state" | cut -d'|' -f4)

  local now
  now=$(_lp_now)

  # Reset window if first_ts is too old
  if [ "$first_ts" != "0" ] && [ $((now - first_ts)) -gt "$LP_WINDOW_SECS" ]; then
    count=0
    first_ts="$now"
    suppressed=0
  fi

  # Dedup: if called within LP_DEDUP_SECS of last call, always suppress
  if [ "$last_ts" != "0" ] && [ $((now - last_ts)) -lt "$LP_DEDUP_SECS" ]; then
    suppressed=$((suppressed + 1))
    _lp_write_state "$hook_type" "$count" "$first_ts" "$now" "$suppressed"
    return 0  # suppress (dedup)
  fi

  # Check thresholds
  if [ "$count" -ge "$LP_CIRCUIT_BREAK" ]; then
    # Circuit breaker: emit ONE final warning then suppress everything
    if [ "$suppressed" -eq 0 ] || [ $((count % LP_CIRCUIT_BREAK)) -eq 0 ]; then
      _lp_log_event "CIRCUIT_BREAK" "$hook_type" "count=${count} in window"
    fi
    suppressed=$((suppressed + 1))
    _lp_write_state "$hook_type" "$count" "$first_ts" "$now" "$suppressed"
    return 0  # suppress
  fi

  if [ "$count" -ge "$LP_HARD_LIMIT" ]; then
    # Hard limit: suppress output, log
    if [ $((count % 10)) -eq 0 ]; then
      _lp_log_event "HARD_LIMIT" "$hook_type" "count=${count} suppressed=${suppressed}"
    fi
    suppressed=$((suppressed + 1))
    _lp_write_state "$hook_type" "$count" "$first_ts" "$now" "$suppressed"
    return 0  # suppress
  fi

  return 1  # allow
}

# Record a hook invocation (call AFTER producing output).
lp_record_invocation() {
  local hook_type="${1:-unknown}"

  if [ "$LP_DISABLED" = "1" ]; then
    return 0
  fi

  _lp_init

  local state
  state=$(_lp_read_state "$hook_type")
  local count first_ts last_ts suppressed
  count=$(echo "$state" | cut -d'|' -f1)
  first_ts=$(echo "$state" | cut -d'|' -f2)
  last_ts=$(echo "$state" | cut -d'|' -f3)
  suppressed=$(echo "$state" | cut -d'|' -f4)

  local now
  now=$(_lp_now)

  # Reset window if expired
  if [ "$first_ts" = "0" ] || [ $((now - first_ts)) -gt "$LP_WINDOW_SECS" ]; then
    count=1
    first_ts="$now"
    suppressed=0
  else
    count=$((count + 1))
  fi

  _lp_write_state "$hook_type" "$count" "$first_ts" "$now" "$suppressed"

  # Emit warnings at soft limit
  if [ "$count" -eq "$LP_SOFT_LIMIT" ]; then
    _lp_log_event "SOFT_LIMIT" "$hook_type" "count=${count} - approaching rate limit"
    echo "[UAP-LOOP-PROTECTION] Hook '${hook_type}' has fired ${count} times in ${LP_WINDOW_SECS}s. Output will be suppressed after ${LP_HARD_LIMIT} to prevent token waste." >&2
  fi
}

# Get the circuit breaker warning message (for hooks that want to emit it).
lp_circuit_breaker_message() {
  local hook_type="${1:-unknown}"
  local state
  state=$(_lp_read_state "$hook_type")
  local count
  count=$(echo "$state" | cut -d'|' -f1)
  local suppressed
  suppressed=$(echo "$state" | cut -d'|' -f4)

  echo "[UAP-CIRCUIT-BREAKER] Hook '${hook_type}' triggered ${count} times (${suppressed} suppressed). This is a runaway loop. Review your approach — repeated hook warnings are consuming tokens without progress."
}

# Get loop protection stats as a summary string.
lp_stats() {
  if [ ! -f "$LP_STATE_FILE" ]; then
    echo "No loop protection data for this session."
    return
  fi
  echo "=== UAP Loop Protection Stats ==="
  while IFS='|' read -r hook count first_ts last_ts suppressed; do
    echo "  ${hook}: ${count} calls, ${suppressed} suppressed"
  done < "$LP_STATE_FILE"
  echo "================================="
}

# Reset state for a specific hook or all hooks.
lp_reset() {
  local hook_type="${1:-}"
  if [ -z "$hook_type" ]; then
    rm -f "$LP_STATE_FILE" 2>/dev/null || true
  elif [ -f "$LP_STATE_FILE" ]; then
    grep -v "^${hook_type}|" "$LP_STATE_FILE" > "${LP_STATE_FILE}.tmp" 2>/dev/null || true
    mv "${LP_STATE_FILE}.tmp" "$LP_STATE_FILE" 2>/dev/null || true
  fi
}
