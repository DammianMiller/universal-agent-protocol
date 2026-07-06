#!/usr/bin/env bash
# UAP Session End Hook — Cleanup and archival
# Event: SessionEnd
# Stores final session summary and cleans up coordination state.
# Always exits 0 (never blocks).
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"

# Coordination DB is SHARED across all worktrees (see session-start.sh).
_GCD="$(git -C "$PROJECT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
case "$_GCD" in
  /*) : ;;
  "") _GCD="" ;;
  *) _GCD="$PROJECT_DIR/$_GCD" ;;
esac
if [ -n "$_GCD" ]; then
  COORD_ROOT="$(cd "$(dirname "$_GCD")" 2>/dev/null && pwd || echo "$PROJECT_DIR")"
else
  COORD_ROOT="$PROJECT_DIR"
fi
COORD_DB="${COORD_ROOT}/agents/data/coordination/coordination.db"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Store session end marker
if [ -f "$DB_PATH" ]; then
  sqlite3 "$DB_PATH" "
    INSERT OR IGNORE INTO memories (timestamp, type, content)
    VALUES ('$TIMESTAMP', 'action', '[session-end] Session terminated at $TIMESTAMP');
  " 2>/dev/null || true
fi

# Reap STALE coordination state only. The coordination DB is shared across all
# worktrees, so this hook must NOT mark every agent completed or complete every
# announcement — that would wipe other LIVE agents' state. Instead, complete the
# state of agents whose heartbeat has gone stale (>5 min), which covers this
# ending session (its heartbeat stops) without touching active peers.
STALE_SECS="${UAP_COORD_REAP_SECONDS:-300}"
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    UPDATE agent_registry SET status = 'completed'
    WHERE status IN ('active', 'idle')
      AND (strftime('%s','now') - strftime('%s', last_heartbeat)) >= $STALE_SECS;
    UPDATE work_announcements SET completed_at = '$TIMESTAMP'
    WHERE completed_at IS NULL
      AND agent_id IN (
        SELECT id FROM agent_registry
        WHERE status = 'completed'
           OR (strftime('%s','now') - strftime('%s', last_heartbeat)) >= $STALE_SECS
      );
  " 2>/dev/null || true
fi

# Clean up backup files older than 7 days (retention policy)
BACKUP_DIR="${PROJECT_DIR}/.uap-backups"
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
fi

exit 0
