#!/usr/bin/env bash
# UAP file-coordination helper — announce a file edit to the SHARED coordination
# DB and detect live overlaps so independently-launched agents never silently
# clobber the same file (merge conflicts / wasted work).
#
# Called by pre-tool-use-edit-write.sh for real worktree source edits.
#
# Usage: coordinate-file.sh <COORD_DB> <AGENT_ID> <AGENT_NAME> <WORKTREE_BRANCH> <REL_PATH> <ABS_PATH>
#
# Resource key is the REPO-RELATIVE path so the same logical file edited from two
# different worktrees collides (that IS the future merge conflict).
#
# Exit 0 = allow (no conflict, or only a stale/self-healed announcement → warn).
# Exit 2 = BLOCK: another LIVE agent (heartbeat < THRESHOLD) holds this file.
#
# Always fails OPEN: any missing dependency or DB error allows the edit. This
# hook must never break editing because coordination is unavailable.
set -uo pipefail

DB="${1:-}"
ME="${2:-}"
NAME="${3:-agent}"
WT="${4:-}"
REL="${5:-}"
ABS="${6:-}"

# Seconds since another agent's last heartbeat for it to count as "live".
THRESHOLD="${UAP_COORD_LIVE_SECONDS:-120}"

# Fail open on any missing prerequisite.
command -v sqlite3 >/dev/null 2>&1 || exit 0
[ -n "$DB" ] && [ -f "$DB" ] || exit 0
[ -n "$ME" ] && [ -n "$REL" ] || exit 0

# SQL-escape single quotes.
q() { printf '%s' "${1:-}" | sed "s/'/''/g"; }
MEq=$(q "$ME"); NAMEq=$(q "$NAME"); WTq=$(q "$WT"); RELq=$(q "$REL"); ABSq=$(q "$ABS")

# 1) Detect a conflicting announcement from ANOTHER agent on the same resource,
#    BEFORE we announce our own (so we never self-detect). Classify live vs stale
#    by the other agent's last heartbeat (fall back to the announcement time when
#    the agent row is absent).
LIVE=$(sqlite3 "$DB" "
  SELECT wa.agent_name || ' (' || wa.agent_id || ')'
  FROM work_announcements wa
  LEFT JOIN agent_registry ar ON ar.id = wa.agent_id
  WHERE wa.resource = '$RELq'
    AND wa.agent_id <> '$MEq'
    AND wa.completed_at IS NULL
    AND COALESCE(ar.status, 'active') = 'active'
    AND (strftime('%s','now') - strftime('%s', COALESCE(ar.last_heartbeat, wa.announced_at))) < $THRESHOLD
  ORDER BY wa.announced_at DESC LIMIT 1;" 2>/dev/null || true)

STALE=$(sqlite3 "$DB" "
  SELECT wa.agent_name || ' (' || wa.agent_id || ')'
  FROM work_announcements wa
  LEFT JOIN agent_registry ar ON ar.id = wa.agent_id
  WHERE wa.resource = '$RELq'
    AND wa.agent_id <> '$MEq'
    AND wa.completed_at IS NULL
    AND (strftime('%s','now') - strftime('%s', COALESCE(ar.last_heartbeat, wa.announced_at))) >= $THRESHOLD
  ORDER BY wa.announced_at DESC LIMIT 1;" 2>/dev/null || true)

# 2) Live conflict → block. Do NOT announce (our edit won't happen).
if [ -n "$LIVE" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"COORDINATION: ${LIVE} is currently editing ${REL} (live agent). Editing it now risks a merge conflict. Coordinate via 'uap agent overlaps --resource ${REL}', pick a different file, or wait for them to finish.\"}" >&2
  exit 2
fi

# 3) No live conflict → announce our intent (idempotent per open resource).
EXISTS=$(sqlite3 "$DB" "SELECT 1 FROM work_announcements WHERE agent_id='$MEq' AND resource='$RELq' AND completed_at IS NULL LIMIT 1;" 2>/dev/null || true)
if [ -z "$EXISTS" ]; then
  sqlite3 "$DB" "INSERT INTO work_announcements
    (agent_id, agent_name, worktree_branch, intent_type, resource, description, files_affected, announced_at)
    VALUES ('$MEq', '$NAMEq', '$WTq', 'editing', '$RELq', NULL, '[\"$ABSq\"]', datetime('now'));" 2>/dev/null || true
else
  sqlite3 "$DB" "UPDATE work_announcements SET announced_at=datetime('now')
    WHERE agent_id='$MEq' AND resource='$RELq' AND completed_at IS NULL;" 2>/dev/null || true
fi

# 4) Stale overlap (crashed/idle agent) → warn but allow; self-heal by completing
#    the stale announcement so it stops nagging.
if [ -n "$STALE" ]; then
  echo "COORDINATION WARNING: ${STALE} has a stale open announcement on ${REL}; proceeding. If they are still active, coordinate to avoid conflicts." >&2
  sqlite3 "$DB" "UPDATE work_announcements SET completed_at=datetime('now')
    WHERE resource='$RELq' AND agent_id<>'$MEq' AND completed_at IS NULL
      AND agent_id IN (
        SELECT wa.agent_id FROM work_announcements wa
        LEFT JOIN agent_registry ar ON ar.id = wa.agent_id
        WHERE (strftime('%s','now') - strftime('%s', COALESCE(ar.last_heartbeat, wa.announced_at))) >= $THRESHOLD
      );" 2>/dev/null || true
fi

exit 0
