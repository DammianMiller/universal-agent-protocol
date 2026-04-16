#!/usr/bin/env python3
"""coord-overlap enforcer: check for in-flight agent path reservations."""
from __future__ import annotations
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

AGENT_OPS = {"Agent", "spawn-agent", "subagent", "delegate"}


def overlapping_reservations(root: Path, paths: list[str]) -> list[str]:
    db = root / "agents" / "data" / "coordination" / "coordination.db"
    if not db.exists() or not paths:
        return []
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        # Best-effort: look for any reservations table with path-like column
        cur = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
        tables = [r[0] for r in cur.fetchall()]
        hits: list[str] = []
        for t in tables:
            try:
                cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
                path_col = next(
                    (c for c in cols if c.lower() in ("path", "paths", "file", "scope")),
                    None,
                )
                status_col = next(
                    (c for c in cols if c.lower() in ("status", "state", "active")), None
                )
                if not path_col:
                    continue
                where = f" WHERE {status_col} IN ('active','in_progress',1)" if status_col else ""
                rows = con.execute(f"SELECT {path_col} FROM {t}{where}").fetchall()
                for (v,) in rows:
                    if not v:
                        continue
                    for p in paths:
                        if p and p in str(v):
                            hits.append(f"{t}:{v}")
            except sqlite3.Error:
                continue
        con.close()
        return hits
    except sqlite3.Error:
        return []


def main() -> None:
    op, args = parse_cli()
    if op not in AGENT_OPS:
        emit(True, "not an agent-spawn op")

    paths_raw = (
        args.get("paths")
        or args.get("scope")
        or args.get("prompt", "")
    )
    if isinstance(paths_raw, list):
        paths = [str(p) for p in paths_raw]
    else:
        paths = [p for p in str(paths_raw).split() if "/" in p]

    hits = overlapping_reservations(repo_root(), paths)
    if hits:
        emit(
            False,
            f"coord-overlap: active reservations on: {', '.join(hits[:5])}. "
            "Run `uap coordination check` before spawning.",
        )

    emit(True, "no overlapping reservations")


if __name__ == "__main__":
    main()
