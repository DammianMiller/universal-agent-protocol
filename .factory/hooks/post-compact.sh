#!/usr/bin/env bash
# UAP Post-Compact Compliance Re-injection — INFORMATIONAL hook
# Event: PostCompact
# Re-injects policy awareness after context compaction.
# Always exits 0 (never blocks).
set -euo pipefail

# --- Loop Protection: suppress if compaction is happening in rapid succession ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${HOOK_DIR}/loop-protection.sh" ]; then
  source "${HOOK_DIR}/loop-protection.sh"
  if lp_should_suppress "post-compact"; then
    exit 0
  fi
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

CONTEXT_LEVEL="${UAP_CONTEXT_LEVEL:-}"
if [ -z "$CONTEXT_LEVEL" ] && [ -f "${PROJECT_DIR}/.factory/config.json" ]; then
  CONTEXT_LEVEL=$(python3 - <<PY 2>/dev/null || true
import json
path = "${PROJECT_DIR}/.factory/config.json"
try:
    data = json.load(open(path, "r", encoding="utf-8"))
    for key in ("contextLevel", "context_level"):
        if key in data and isinstance(data[key], str):
            print(data[key])
            raise SystemExit
    hooks = data.get("hooks") or {}
    for key in ("contextLevel", "context_level"):
        if key in hooks and isinstance(hooks[key], str):
            print(hooks[key])
            raise SystemExit
except Exception:
    pass
PY
  )
fi
CONTEXT_LEVEL="${CONTEXT_LEVEL:-normal}"

output=""

# ─── Active Policy Summary ──────────────────────────────────────
output+="<system-reminder>"$'\n'
output+="## UAP COMPLIANCE RESTORED (Post-Compact)"$'\n'
output+=""$'\n'
output+="Context was compacted. Policies remain enforced (worktree guard, dangerous cmd guard, completion gate, pre-edit build, versioning, backups)."$'\n'
if [ "$CONTEXT_LEVEL" != "quiet" ]; then
  output+="See policies/ for full requirements."$'\n'
  output+=""$'\n'
  output+="Before work: ensure worktree, run uap task ready, query memory."$'\n'
  output+=""$'\n'
fi

# ─── Restore session context from memory ─────────────────────────
if [ "$CONTEXT_LEVEL" = "verbose" ] && [ -f "$DB_PATH" ]; then
  recent=$(sqlite3 "$DB_PATH" "
    SELECT type || ': ' || substr(content, 1, 100) FROM memories
    WHERE timestamp >= datetime('now', '-2 hours')
    ORDER BY id DESC LIMIT 5;
  " 2>/dev/null || true)

  if [ -n "$recent" ]; then
    output+="### Recent Memory (last 2h):"$'\n'
    output+="$recent"$'\n'
    output+=""$'\n'
  fi

  # Session decisions
  decisions=$(sqlite3 "$DB_PATH" "
    SELECT substr(content, 1, 120) FROM session_memories
    WHERE type = 'decision' AND importance >= 6
    ORDER BY id DESC LIMIT 3;
  " 2>/dev/null || true)

  if [ -n "$decisions" ]; then
    output+="### Recent Decisions:"$'\n'
    output+="$decisions"$'\n'
    output+=""$'\n'
  fi
fi

# ─── Multi-agent coordination status ────────────────────────────
if [ "$CONTEXT_LEVEL" = "verbose" ] && [ -f "$COORD_DB" ]; then
  active_work=$(sqlite3 "$COORD_DB" "
    SELECT agent_id || ' editing ' || resource
    FROM work_announcements
    WHERE completed_at IS NULL
    ORDER BY announced_at DESC LIMIT 5;
  " 2>/dev/null || true)

  if [ -n "$active_work" ]; then
    output+="### Active Work (coordinate — do not conflict):"$'\n'
    output+="$active_work"$'\n'
    output+=""$'\n'
  fi
fi

# ─── Worktree status ────────────────────────────────────────────
CURRENT_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
IS_WORKTREE="false"
if echo "$PROJECT_DIR" | grep -q '\.worktrees/'; then
  IS_WORKTREE="true"
fi
GIT_DIR=$(git -C "$PROJECT_DIR" rev-parse --git-dir 2>/dev/null || true)
GIT_COMMON=$(git -C "$PROJECT_DIR" rev-parse --git-common-dir 2>/dev/null || true)
if [ -n "$GIT_DIR" ] && [ -n "$GIT_COMMON" ] && [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  IS_WORKTREE="true"
fi

if [ "$IS_WORKTREE" = "false" ] && { [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; }; then
  output+="### ⚠ WORKTREE VIOLATION: You are on $CURRENT_BRANCH in the project root."$'\n'
  output+="Run: uap worktree create <slug> BEFORE any file edits."$'\n'
  output+=""$'\n'
else
  output+="### Worktree: ACTIVE (branch: $CURRENT_BRANCH)"$'\n'
  output+=""$'\n'
fi

output+="</system-reminder>"$'\n'

# --- Record invocation for loop tracking ---
if type lp_record_invocation &>/dev/null; then
  lp_record_invocation "post-compact"
fi

echo "$output"
