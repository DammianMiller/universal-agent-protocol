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

  # Release THIS agent's own holds immediately. The stale sweep above only frees
  # an agent once its heartbeat has been dead for STALE_SECS — so a session that
  # ended cleanly seconds after an edit kept its files locked against every peer
  # for the full window, and peers saw a "live agent" that had already exited.
  # We know our own id, so there is no reason to wait for it to look dead.
  if [ -n "${UAP_AGENT_ID:-}" ]; then
    ME_Q=$(printf '%s' "$UAP_AGENT_ID" | sed "s/'/''/g")
    sqlite3 "$COORD_DB" "
      UPDATE work_announcements SET completed_at = '$TIMESTAMP'
      WHERE completed_at IS NULL AND agent_id = '$ME_Q';
      UPDATE agent_registry SET status = 'completed'
      WHERE id = '$ME_Q';
    " 2>/dev/null || true
  fi
fi

# Clean up backup files older than 7 days (retention policy)
BACKUP_DIR="${PROJECT_DIR}/.uap-backups"
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
fi

# Session-scoped proxy + dashboard release: stop them ONLY if THIS session
# started them and no other client remains (adopted/externally-managed services
# are never killed; other active clients keep them alive). Fail-open; never
# blocks exit.
if command -v uap >/dev/null 2>&1; then
  _uap_pc="${CLAUDE_SESSION_ID:-${FACTORY_SESSION_ID:-${CURSOR_SESSION_ID:-${UAP_SESSION_ID:-ppid-$PPID}}}}"
  ( cd "$PROJECT_DIR" 2>/dev/null && timeout 20 uap proxy release --if-enabled --quiet --client "$_uap_pc" --client-pid "$PPID" ) >/dev/null 2>&1 || true
fi

exit 0
