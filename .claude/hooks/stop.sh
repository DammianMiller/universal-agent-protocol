#!/usr/bin/env bash
# UAP Completion Gate + Session Cleanup — Stop hook
# Event: Stop
# Checks completion gates and cleans up session state.
# Exit 2 = BLOCK stop (force agent to continue). Exit 0 = allow stop.
# Enforces: completion-gate, mandatory-testing-deployment policies.
set -euo pipefail

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

ALL_CHANGES="${CHANGED_FILES}${STAGED_FILES}${UNTRACKED_FILES}"

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
    SRC_TIME=$(find "${PROJECT_DIR}/src" -name "*.ts" -newer "${PROJECT_DIR}/dist" 2>/dev/null | head -1)
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
# FIX A: Increased timeout from 5 minutes to 30 minutes to prevent premature cleanup
if [ -f "$COORD_DB" ]; then
  # Complete all active announcements for agents from this session
  sqlite3 "$COORD_DB" "
    UPDATE work_announcements SET completed_at = datetime('now')
    WHERE completed_at IS NULL AND agent_id IN (
      SELECT id FROM agent_registry
      WHERE status = 'active' AND last_heartbeat >= datetime('now', '-30 minutes')
    );
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status = 'active' AND last_heartbeat >= datetime('now', '-30 minutes')
    );
    UPDATE agent_registry SET status = 'completed'
    WHERE status = 'active' AND last_heartbeat >= datetime('now', '-30 minutes');
  " 2>/dev/null || true
fi

# Output the checklist (informational — shown to model)
if [ -n "$output" ]; then
  echo "$output"
fi

# Allow stop (exit 0) — we use warnings, not hard blocks, because
# the model needs agency to decide when it's truly done vs still working.
exit 0
