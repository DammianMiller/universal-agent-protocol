#!/usr/bin/env bash
# UAP Completion Gate + Session Cleanup — Stop hook
# Event: Stop
# Checks completion gates and cleans up session state.
# Exit 2 = BLOCK stop (force agent to continue). Exit 0 = allow stop.
# Enforces: completion-gate, mandatory-testing-deployment policies.
set -euo pipefail

# --- Re-entrancy guard (canonical Claude Code Stop-hook contract) ---
# Claude Code sets `stop_hook_active: true` on the Stop payload when the session
# is ALREADY continuing *because this hook blocked once*. Blocking again on that
# re-entry forces an unbounded Stop→continue→Stop loop, so we must relent. Read
# the payload from stdin (a pipe under Claude Code) and allow the stop. Tolerate
# absent/other stdin (a TTY or a harness that sends no payload) — never block.
STOP_HOOK_PAYLOAD=""
if [ ! -t 0 ]; then
  STOP_HOOK_PAYLOAD="$(cat 2>/dev/null || true)"
fi
if printf '%s' "$STOP_HOOK_PAYLOAD" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# --- Loop Protection ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${HOOK_DIR}/loop-protection.sh" ]; then
  source "${HOOK_DIR}/loop-protection.sh"
  if lp_should_suppress "stop"; then
    exit 0
  fi
  # Advance the per-session counter so the circuit-breaker can bound a runaway
  # Stop loop. Without this call the counter stays 0 and the guard is inert.
  lp_record_invocation "stop" 2>/dev/null || true
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

# ─── Detect if code was changed ─────────────────────────────────
CODE_CHANGED="false"
TS_CHANGED="false"
TEST_FILES_CHANGED="false"
UNCOMMITTED_CHANGES="false"

# Check for uncommitted changes in the working tree
CHANGED_FILES=$(git -C "$PROJECT_DIR" diff --name-only HEAD 2>/dev/null || true)
STAGED_FILES=$(git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null || true)
UNTRACKED_FILES=$(git -C "$PROJECT_DIR" ls-files --others --exclude-standard 2>/dev/null || true)

# Newline-join the three lists: plain concatenation mashes the last file of one
# list into the first of the next (e.g. "a.jsb.ts"), which breaks the per-line
# extension greps below.
ALL_CHANGES=$(printf '%s\n%s\n%s\n' "$CHANGED_FILES" "$STAGED_FILES" "$UNTRACKED_FILES")

if [ -n "$ALL_CHANGES" ]; then
  UNCOMMITTED_CHANGES="true"

  # Check for source code changes
  if echo "$ALL_CHANGES" | grep -qE '\.(ts|tsx|js|jsx)$'; then
    CODE_CHANGED="true"
  fi

  # Check for TypeScript changes specifically
  if echo "$ALL_CHANGES" | grep -qE '\.tsx?$'; then
    TS_CHANGED="true"
  fi

  # Check for test file changes
  if echo "$ALL_CHANGES" | grep -qE 'test/.*\.(ts|tsx|js|jsx)$'; then
    TEST_FILES_CHANGED="true"
  fi
fi

# ─── Completion Gate Checklist ───────────────────────────────────
output=""
warnings=0

if [ "$CODE_CHANGED" = "true" ]; then
  output+="## COMPLETION GATE CHECKLIST"$'\n'
  output+=""$'\n'

  # Gate 1: New tests written
  if [ "$TEST_FILES_CHANGED" = "true" ]; then
    output+="[PASS] New test files modified/added"$'\n'
  else
    output+="[WARN] No test files modified — completion-gate requires 2+ new tests for code changes"$'\n'
    warnings=$((warnings + 1))
  fi

  # Gate 2: Build check (heuristic — check if dist/ is newer than last src change)
  if [ -d "${PROJECT_DIR}/dist" ]; then
    DIST_TIME=$(stat -c %Y "${PROJECT_DIR}/dist" 2>/dev/null || echo "0")
    SRC_TIME=$(find "${PROJECT_DIR}/src" -name "*.ts" -newer "${PROJECT_DIR}/dist" -print -quit 2>/dev/null)
    if [ -z "$SRC_TIME" ]; then
      output+="[PASS] Build appears up-to-date (dist/ newer than src/)"$'\n'
    else
      output+="[WARN] Build may be stale — run 'npm run build' to verify"$'\n'
      warnings=$((warnings + 1))
    fi
  else
    output+="[WARN] No dist/ directory — run 'npm run build'"$'\n'
    warnings=$((warnings + 1))
  fi

  # Gate 3: Uncommitted changes
  if [ -n "$STAGED_FILES" ] || [ -n "$CHANGED_FILES" ]; then
    output+="[WARN] Uncommitted changes detected — commit or stash before version bump"$'\n'
    warnings=$((warnings + 1))
  fi

  # Gate 4: Version bump check (was package.json version changed?)
  VERSION_BUMPED="false"
  if echo "$ALL_CHANGES" | grep -q "package.json"; then
    # Check if version field actually changed
    VERSION_DIFF=$(git -C "$PROJECT_DIR" diff HEAD -- package.json 2>/dev/null | grep -E '^\+.*"version"' || true)
    if [ -n "$VERSION_DIFF" ]; then
      VERSION_BUMPED="true"
    fi
  fi
  if [ "$VERSION_BUMPED" = "true" ]; then
    output+="[PASS] Version bump detected in package.json"$'\n'
  else
    output+="[WARN] No version bump — run 'npm run version:patch/minor/major' before claiming done"$'\n'
    warnings=$((warnings + 1))
  fi

  output+=""$'\n'

  if [ "$warnings" -gt 0 ]; then
    output+="$warnings completion gate warning(s). Review policies/completion-gate.md before claiming task done."$'\n'
  else
    output+="All completion gates appear satisfied."$'\n'
  fi
fi

# ─── Session Cleanup ─────────────────────────────────────────────
# Store session marker in memory DB
if [ -f "$DB_PATH" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  sqlite3 "$DB_PATH" "
    INSERT OR IGNORE INTO memories (timestamp, type, content)
    VALUES ('$TIMESTAMP', 'action', '[session-end] Agent stopping at $TIMESTAMP. Code changed: $CODE_CHANGED, Tests: $TEST_FILES_CHANGED, Warnings: $warnings');
  " 2>/dev/null || true
fi

# Mark agent as completed in coordination DB
if [ -f "$COORD_DB" ]; then
  # Complete all active announcements for agents from this session
  sqlite3 "$COORD_DB" "
    UPDATE work_announcements SET completed_at = datetime('now')
    WHERE completed_at IS NULL AND agent_id IN (
      SELECT id FROM agent_registry
      WHERE status = 'active' AND last_heartbeat >= datetime('now', '-5 minutes')
    );
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status = 'active' AND last_heartbeat >= datetime('now', '-5 minutes')
    );
    UPDATE agent_registry SET status = 'completed'
    WHERE status = 'active' AND last_heartbeat >= datetime('now', '-5 minutes');
  " 2>/dev/null || true
fi

# Output the checklist (informational — shown to model)
if [ -n "$output" ]; then
  echo "$output"
fi

# ─── Runtime execution gate (HARD block) ─────────────────────────
# The checklist above is advisory. This is the one hard gate: when code changed,
# prove the artifact actually RUNS before the session may finish. Catches the
# crash-class bugs (TDZ ReferenceError, undefined globals, import throws) that
# static checks miss — exactly the failure that shipped in agentic sessions that
# bypass `uap deliver`. Cheap by design (--runtime-only runs just the execution
# gate, not the full test suite). Fails OPEN on any infra problem so it can only
# ever block on a genuine runtime failure, never on its own malfunction.
# Opt out with UAP_VERIFY_ON_STOP=0.
if [ "$CODE_CHANGED" = "true" ] && [ "${UAP_VERIFY_ON_STOP:-1}" != "0" ] && command -v uap >/dev/null 2>&1; then
  set +e
  # Version-skew guard: an older global `uap` without the `verify` subcommand
  # would exit non-zero (looking like a gate failure). Only proceed if `verify`
  # actually exists, so a stale CLI fails OPEN instead of false-blocking.
  uap verify --help >/dev/null 2>&1
  VERIFY_SUPPORTED=$?
  VERIFY_RC=0
  if [ "$VERIFY_SUPPORTED" = "0" ]; then
    # Portable timeout wrapper: GNU coreutils ships `timeout` (Linux), macOS
    # ships it as `gtimeout`, and minimal shells may lack both. Resolve once and
    # fall back to running verify directly — it enforces its own internal rung
    # timeouts. Without this, a missing `timeout` printed "command not found".
    if command -v timeout >/dev/null 2>&1; then
      TIMEOUT_WRAP="timeout -k 5 120"
    elif command -v gtimeout >/dev/null 2>&1; then
      TIMEOUT_WRAP="gtimeout -k 5 120"
    else
      TIMEOUT_WRAP=""
    fi
    # set +e: a failing command substitution under `set -e` would abort the hook
    # (allowing stop) before we can inspect the code and decide to block.
    # NOT --strict: strict upgrades "no runnable artifact detected" (a vacuous,
    # nothing-to-run project — every fresh/empty install) from a SKIP (RC 0) into
    # a hard failure (RC 1), which would exit 2 forever. Non-strict returns RC 1
    # ONLY on a genuine runtime failure, which is the sole case we want to block.
    # User-path gate (P3): when delivery.userValidation is on and the last
    # validation report is missing/stale/failed for the CURRENT tree, the
    # done-claim must re-prove the critical user journeys through the real
    # client. Fresh-pass reports skip the cost entirely. Version-skew guard:
    # only pass the flag when this uap build knows it, so an older CLI fails
    # OPEN instead of erroring on an unknown option.
    UV_AUTO=""
    if uap verify --help 2>/dev/null | grep -q 'user-paths-auto'; then
      UV_AUTO="--user-paths-auto"
    fi
    VERIFY_OUT="$(cd "$PROJECT_DIR" && $TIMEOUT_WRAP uap verify --runtime-only $UV_AUTO --dir "$PROJECT_DIR" 2>&1)"
    VERIFY_RC=$?
  fi
  set -e
  # RC 1 = a REAL gate failure (code is broken) → block. Everything else fails
  # OPEN: RC 3 = infra (gate timed out / couldn't spawn), 124 = outer timeout,
  # 127 = missing, any other = internal — none should ever wedge a session.
  if [ "$VERIFY_RC" = "1" ]; then
    echo ""
    echo "## RUNTIME/USER-PATH GATE FAILED — the code does not run or does not work for a real user"
    echo "$VERIFY_OUT"
    echo ""
    echo "Fix the runtime error above before finishing. (Set UAP_VERIFY_ON_STOP=0 to bypass.)"
    exit 2
  fi
fi

# Allow stop (exit 0) — completion-gate checklist uses warnings, not hard blocks;
# the runtime execution gate above is the sole hard block.
exit 0
