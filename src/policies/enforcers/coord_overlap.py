#!/usr/bin/env python3
"""coord-overlap enforcer: don't spawn an agent onto paths a LIVE agent holds.

Rewritten. The previous implementation was effectively decorative:

  * it scraped candidate paths out of the raw prompt STRING by splitting on
    whitespace and keeping tokens containing "/", so "see src/foo.ts for
    context" registered as a reservation target while a structured `paths`
    list was the only input that ever worked properly;
  * it then iterated EVERY table in the coordination DB looking for a column
    coincidentally named path/paths/file/scope and substring-matched against it,
    so an unrelated table could veto a spawn;
  * it never consulted agent liveness, so a reservation left behind by an agent
    that died weeks ago blocked new work forever.

This version queries the real `work_announcements` schema, joins
`agent_registry` for heartbeat liveness (matching coordinate-file.sh's
semantics), and only considers paths it can defend as actual targets.

Env:
  UAP_NO_COORD_OVERLAP=1      disable
  UAP_COORD_LIVE_SECONDS=<n>  liveness window, shared with coordinate-file.sh (default 120)
"""
from __future__ import annotations
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

AGENT_OPS = {"Agent", "spawn-agent", "subagent", "delegate", "task"}

DEFAULT_LIVE_SECONDS = 120

# A path-ish token: has a separator, a file extension or a known source dir, and
# no spaces. Deliberately conservative — a false positive here BLOCKS work.
PATH_TOKEN = re.compile(
    r"(?:^|[\s'\"`(])((?:src|test|tests|lib|scripts|docs|policies|templates)/[\w./-]+"
    r"|[\w./-]+\.(?:ts|tsx|js|jsx|py|sh|md|json|yaml|yml|sql))(?:[\s'\"`),:;]|$)"
)


def _live_seconds() -> int:
    raw = os.environ.get("UAP_COORD_LIVE_SECONDS")
    if not raw:
        return DEFAULT_LIVE_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_LIVE_SECONDS
    return value if value > 0 else DEFAULT_LIVE_SECONDS


def candidate_paths(args: dict) -> list[str]:
    """Paths this spawn is going to work on.

    Prefers STRUCTURED input (`paths`, `scope`, `files`). Falls back to a
    conservative regex over the prompt, which is a hint, not a contract.
    """
    for key in ("paths", "scope", "files"):
        raw = args.get(key)
        if isinstance(raw, list) and raw:
            return [str(p).strip() for p in raw if str(p).strip()]
        if isinstance(raw, str) and raw.strip():
            return [p for p in re.split(r"[\s,]+", raw.strip()) if p]

    prompt = args.get("prompt") or args.get("description") or ""
    if not isinstance(prompt, str):
        return []
    return sorted({m.group(1) for m in PATH_TOKEN.finditer(prompt)})


def live_holders(root: Path, paths: list[str]) -> list[tuple[str, str]]:
    """(holder, resource) pairs for paths held by a LIVE agent other than us."""
    db = root / "agents" / "data" / "coordination" / "coordination.db"
    if not db.exists() or not paths:
        return []

    me = os.environ.get("UAP_AGENT_ID") or ""
    window = _live_seconds()
    hits: list[tuple[str, str]] = []

    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
    except sqlite3.Error:
        return []

    try:
        # Schema guard: if work_announcements is absent this DB predates the
        # coordination system — fail open rather than guessing at other tables.
        exists = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_announcements'"
        ).fetchone()
        if not exists:
            return []

        rows = con.execute(
            """
            SELECT wa.resource,
                   COALESCE(wa.agent_name, wa.agent_id) AS holder,
                   wa.agent_id
            FROM work_announcements wa
            LEFT JOIN agent_registry ar ON ar.id = wa.agent_id
            WHERE wa.completed_at IS NULL
              AND COALESCE(ar.status, 'active') = 'active'
              AND (strftime('%s','now')
                   - strftime('%s', COALESCE(ar.last_heartbeat, wa.announced_at))) < ?
            """,
            (window,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()

    for resource, holder, agent_id in rows:
        if not resource or (me and agent_id == me):
            continue
        res = str(resource)
        for p in paths:
            # Match on path containment in EITHER direction: reserving a
            # directory covers files under it, and reserving a file conflicts
            # with a spawn scoped to its directory.
            if res == p or res.startswith(p.rstrip("/") + "/") or p.startswith(res.rstrip("/") + "/"):
                hits.append((str(holder), res))
                break

    return hits


def main() -> None:
    op, args = parse_cli()
    if op not in AGENT_OPS:
        emit(True, "not an agent-spawn op")

    if os.environ.get("UAP_NO_COORD_OVERLAP") == "1":
        emit(True, "UAP_NO_COORD_OVERLAP override set")

    paths = candidate_paths(args)
    if not paths:
        emit(True, "no resolvable target paths")

    hits = live_holders(repo_root(), paths)
    if hits:
        detail = ", ".join(f"{holder} holds {res}" for holder, res in hits[:5])
        emit(
            False,
            f"coord-overlap: {detail}. Spawning onto the same paths risks two agents "
            "diverging on one file. Narrow the spawn's scope, wait for them to finish, "
            "or check `uap coord board`. Override: UAP_NO_COORD_OVERLAP=1.",
        )

    emit(True, f"no live holders for {len(paths)} path(s)")


if __name__ == "__main__":
    main()
