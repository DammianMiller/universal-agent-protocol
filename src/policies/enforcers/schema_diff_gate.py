#!/usr/bin/env python3
"""schema-diff-gate enforcer: schema/pool changes must pass uap schema-diff."""
from __future__ import annotations
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run  # noqa: E402

WATCHED_RE = re.compile(
    r"(migrations/.*\.sql|infra/postgres-spock/|infra/helm_charts/[^/]*pgdog|"
    r"infra/helm_charts/[^/]*cnpg|infra/helm_charts/[^/]*redis|"
    r"infra/helm_charts/[^/]*envoy|infra/helm_charts/[^/]*sentinel)",
    re.I,
)
COMMIT_OPS = {"git-commit", "git commit", "Bash"}
RECENT_SEC = 3600


def touched_watched_paths(root: Path) -> list[str]:
    rc, out, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=root)
    if rc != 0:
        return []
    rc2, staged, _ = run(["git", "diff", "--name-only", "--cached"], cwd=root)
    all_files = (out + "\n" + (staged if rc2 == 0 else "")).splitlines()
    return [f for f in all_files if f and WATCHED_RE.search(f)]


def schema_diff_ok(root: Path) -> bool:
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        cur = con.execute(
            "SELECT timestamp FROM session_memories "
            "WHERE content LIKE '%schema-diff%pass%' "
            "ORDER BY id DESC LIMIT 1"
        )
        row = cur.fetchone()
        con.close()
        if not row:
            return False
        try:
            ts = time.mktime(time.strptime(row[0][:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:  # noqa: BLE001
            return False
        return (time.time() - ts) < RECENT_SEC
    except sqlite3.Error:
        return False


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or "").lower()
    is_commit = op in COMMIT_OPS or "git commit" in cmd or "git push" in cmd
    if not is_commit:
        emit(True, "not a commit/push gate point")

    root = repo_root()
    watched = touched_watched_paths(root)
    if not watched:
        emit(True, "no watched schema/pool paths in diff")

    if schema_diff_ok(root):
        emit(True, f"recent schema-diff pass covers: {', '.join(watched[:5])}")

    emit(
        False,
        "schema-diff-gate: changes to "
        + ", ".join(watched[:5])
        + " require `uap schema-diff` to pass (within 1h). Run it and re-commit.",
    )


if __name__ == "__main__":
    main()
