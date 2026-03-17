#!/usr/bin/env bash
# UAP Session End Hook (universal - all coding harnesses)
# Records session completion in memory and cleans up agent state.
# Fails safely - never blocks the agent.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-${UAP_PROJECT_DIR:-.}}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Record session end marker in memory
sqlite3 "$DB_PATH" "
  INSERT OR IGNORE INTO memories (timestamp, type, content)
  VALUES ('$TIMESTAMP', 'action', '[post-session] Session completed at $TIMESTAMP');
" 2>/dev/null || true

# Count decisions stored this session
session_decisions=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM session_memories
  WHERE timestamp >= datetime('now', '-4 hours')
    AND type = 'decision';
" 2>/dev/null || echo "0")

if [ "$session_decisions" = "0" ]; then
  echo "<system-reminder>"
  echo "WARNING: No decisions stored this session."
  echo "Consider storing a summary before ending:"
  echo "  sqlite3 ./agents/data/memory/short_term.db \"INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary>',7);\""
  echo "</system-reminder>"
fi

# Clean up agent registrations from this session
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status='active' AND last_heartbeat >= datetime('now','-10 minutes')
    );
    UPDATE work_announcements SET completed_at='$TIMESTAMP'
      WHERE completed_at IS NULL AND agent_id IN (
        SELECT id FROM agent_registry
        WHERE status='active' AND last_heartbeat >= datetime('now','-10 minutes')
      );
    UPDATE agent_registry SET status='completed'
      WHERE status='active' AND last_heartbeat >= datetime('now','-10 minutes');
  " 2>/dev/null || true
fi
