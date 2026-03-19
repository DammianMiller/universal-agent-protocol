#!/usr/bin/env bash
# UAP Session End Hook — Cleanup and archival
# Event: SessionEnd
# Stores final session summary and cleans up coordination state.
# Always exits 0 (never blocks).
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Store session end marker
if [ -f "$DB_PATH" ]; then
  sqlite3 "$DB_PATH" "
    INSERT OR IGNORE INTO memories (timestamp, type, content)
    VALUES ('$TIMESTAMP', 'action', '[session-end] Session terminated at $TIMESTAMP');
  " 2>/dev/null || true
fi

# FIX C: Only clean up agents that have been idle for extended periods (>30 min)
# This prevents premature cleanup during normal session pauses
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    UPDATE work_announcements SET completed_at = '$TIMESTAMP'
    WHERE completed_at IS NULL AND agent_id IN (
      SELECT id FROM agent_registry
      WHERE status IN ('active', 'idle') AND last_heartbeat < datetime('now', '-30 minutes')
    );
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status IN ('active', 'idle') AND last_heartbeat < datetime('now', '-30 minutes')
    );
    UPDATE agent_registry SET status = 'completed'
    WHERE status IN ('active', 'idle') AND last_heartbeat < datetime('now', '-30 minutes');
  " 2>/dev/null || true
fi

# Clean up backup files older than 7 days (retention policy)
BACKUP_DIR="${PROJECT_DIR}/.uap-backups"
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
fi

exit 0
