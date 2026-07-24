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
# Exit 2 = BLOCK: another LIVE agent (heartbeat < THRESHOLD) holds this file, OR
#          the file has MOVED on the integration branch since this branch's
#          merge-base (editing it now would silently revert landed work).
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

# ---------------------------------------------------------------------------
# Merge-base drift check (sequential-overwrite protection).
#
# The live-lock below only covers CONCURRENT edits — two agents holding the same
# file at the same moment. The far more common loss is SEQUENTIAL: agent A landed
# a change to foo.ts an hour ago; agent B's worktree was cut before that and never
# re-synced, so B edits a stale copy and its merge quietly reverts A's work.
#
# So: if THIS exact file changed on the integration branch since our merge-base,
# block until the agent syncs. Scoped to the single file being edited, so a stale
# worktree touching untouched files keeps working — no blanket freeze.
#
#   UAP_COORD_DRIFT=block|warn|off   (default block)
#   UAP_COORD_FETCH_SECONDS=<n>      throttle for the background fetch (default 600)
# ---------------------------------------------------------------------------
DRIFT_MODE="${UAP_COORD_DRIFT:-block}"
FETCH_THROTTLE="${UAP_COORD_FETCH_SECONDS:-600}"

[ -n "$ME" ] && [ -n "$REL" ] || exit 0

# Resolve the integration ref (origin/HEAD → origin/master → origin/main).
integration_ref() {
  local d="$1" r
  r=$(git -C "$d" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) && {
    printf '%s' "${r#refs/remotes/}"; return 0; }
  for c in master main; do
    git -C "$d" rev-parse --verify --quiet "refs/remotes/origin/$c" >/dev/null 2>&1 && {
      printf 'origin/%s' "$c"; return 0; }
  done
  return 1
}

check_drift() {
  [ "$DRIFT_MODE" = "off" ] && return 0
  command -v git >/dev/null 2>&1 || return 0
  [ -n "$ABS" ] || return 0

  local dir; dir=$(dirname "$ABS")
  [ -d "$dir" ] || return 0
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  local ref; ref=$(integration_ref "$dir") || return 0

  # Throttled fetch: an edit-time network call on EVERY keystroke-scale edit would
  # be intolerable, so refresh at most once per FETCH_THROTTLE seconds. Between
  # refreshes we compare against the last known remote tip — still catches the
  # overwhelming majority of drift, and `uap worktree sync` refreshes on demand.
  local common; common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 0
  case "$common" in /*) ;; *) common="$dir/$common" ;; esac
  local stamp="$common/.uap-drift-fetch"
  local now; now=$(date +%s)
  local last=0
  [ -f "$stamp" ] && last=$(cat "$stamp" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -ge "$FETCH_THROTTLE" ]; then
    printf '%s' "$now" > "$stamp" 2>/dev/null || true
    if command -v timeout >/dev/null 2>&1; then
      timeout 10 git -C "$dir" fetch -q origin "${ref#origin/}" >/dev/null 2>&1 || true
    else
      git -C "$dir" fetch -q origin "${ref#origin/}" >/dev/null 2>&1 || true
    fi
  fi

  local mb; mb=$(git -C "$dir" merge-base HEAD "$ref" 2>/dev/null) || return 0
  [ -n "$mb" ] || return 0

  # Did this specific path change on the integration branch since we branched?
  local moved; moved=$(git -C "$dir" diff --name-only "$mb" "$ref" -- "$REL" 2>/dev/null)
  [ -n "$moved" ] || return 0

  local n; n=$(git -C "$dir" rev-list --count "$mb..$ref" 2>/dev/null || echo '?')

  if [ "$DRIFT_MODE" = "warn" ]; then
    echo "COORDINATION WARNING: ${REL} changed on ${ref} since your branch point (${n} commits behind). Run 'uap worktree sync' before editing or your merge may revert landed work." >&2
    return 0
  fi

  echo "{\"decision\":\"block\",\"reason\":\"STALE FILE: ${REL} has changed on ${ref} since your branch point (you are ${n} commits behind). Editing this copy risks silently reverting work that already landed. Run 'uap worktree sync' first, then re-apply your change on top. Override: UAP_COORD_DRIFT=warn.\"}" >&2
  return 2
}

# 0) Sequential-drift check FIRST. It depends only on git, never on the
#    coordination DB — a missing/unwritable DB must not silently disable
#    overwrite protection (it did: the DB prerequisite used to exit 0 above it).
check_drift || exit 2

# The announcement half needs sqlite3 and a real DB file; fail open without them.
command -v sqlite3 >/dev/null 2>&1 || exit 0
[ -n "$DB" ] && [ -f "$DB" ] || exit 0

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
