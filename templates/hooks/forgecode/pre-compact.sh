#!/usr/bin/env bash
# UAP Pre-Compact Hook for Claude Code
# 1. Checks compliance state and warns on violations
# 2. Writes a timestamp marker to the daily log before context compaction
# 3. Marks any agents registered by this session as completed
# Fails safely - never blocks the agent.
set -euo pipefail

PROJECT_DIR="${FORGE_UAP_PROJECT:-.}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

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
output+="Context is being compacted. Before continuing work after compaction:"$'\n'
output+="1. Re-run: uap task ready"$'\n'
output+="2. Re-query memory for current task context"$'\n'
output+="3. Check for stale worktrees: uap worktree list"$'\n'
output+=""$'\n'

if [ "$recent_lessons" = "0" ]; then
  output+="WARNING: No lessons stored this session. Before compaction completes,"$'\n'
  output+="store a summary: sqlite3 ./agents/data/memory/short_term.db \"INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary>',7);\""$'\n'
fi

output+="</system-reminder>"$'\n'

echo "$output"

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
