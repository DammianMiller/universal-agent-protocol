#!/usr/bin/env bash
# UAP Pre-Compact Hook (universal - all coding harnesses)
# 1. Checks compliance state and warns on violations
# 2. Writes a timestamp marker to the daily log before context compaction
# 3. Shows compact session dashboard before compaction
# 4. Marks any agents registered by this session as completed
# Fails safely - never blocks the agent.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

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

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Record a compaction marker in memory so sessions can detect context resets
sqlite3 "$DB_PATH" "
  INSERT OR IGNORE INTO memories (timestamp, type, content)
  VALUES ('$TIMESTAMP', 'action', '[pre-compact] Context compaction at $TIMESTAMP');
" 2>/dev/null || true

# Check if any lessons were stored this session
recent_lessons=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM session_memories
  WHERE timestamp >= datetime('now', '-2 hours')
    AND type = 'decision';
" 2>/dev/null || echo "0")

output=""

# Compliance reminder on compaction
output+="<system-reminder>"$'\n'
output+="## UAP COMPLIANCE REMINDER (Pre-Compact)"$'\n'
output+=""$'\n'
if [ "$CONTEXT_LEVEL" = "quiet" ]; then
  output+="Context compacting. After compaction: uap task ready; uap memory query \"<task>\"; uap worktree list."$'\n'
  output+=""$'\n'
else
  output+="Context is being compacted. Before continuing work after compaction:"$'\n'
  output+="1. Re-run: uap task ready"$'\n'
  output+="2. Re-query memory for current task context"$'\n'
  output+="3. Check for stale worktrees: uap worktree list"$'\n'
  output+=""$'\n'
fi

if [ "$recent_lessons" = "0" ]; then
  output+="WARNING: No lessons stored this session. Before compaction completes, store a summary:"$'\n'
  output+="uap memory store \"<summary>\" --importance 7"$'\n'
fi

output+="</system-reminder>"$'\n'

echo "$output"

# Session summary panel (rich UAP state snapshot before compaction)
if [ "$CONTEXT_LEVEL" = "verbose" ] && [ -f "${PROJECT_DIR}/dist/bin/cli.js" ]; then
  node "${PROJECT_DIR}/dist/bin/cli.js" dash session --compact 2>/dev/null || true
fi

# Clean up agents with recent heartbeats (likely from this session being compacted)
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status='active' AND last_heartbeat >= datetime('now','-5 minutes')
    );
    UPDATE work_announcements SET completed_at='$TIMESTAMP'
      WHERE completed_at IS NULL AND agent_id IN (
        SELECT id FROM agent_registry
        WHERE status='active' AND last_heartbeat >= datetime('now','-5 minutes')
      );
    UPDATE agent_registry SET status='completed'
      WHERE status='active' AND last_heartbeat >= datetime('now','-5 minutes');
  " 2>/dev/null || true
fi
