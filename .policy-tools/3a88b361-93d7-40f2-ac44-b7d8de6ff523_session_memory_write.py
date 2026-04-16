#!/usr/bin/env python3
"""session-memory-write enforcer: code-changing sessions must write a lesson."""
from __future__ import annotations
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

END_OPS = {"session-end", "stop", "terminate", "SessionEnd"}


def recent_lesson(root: Path) -> bool:
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        cur = con.execute(
            "SELECT COUNT(*) FROM session_memories "
            "WHERE type IN ('decision','lesson','pattern') "
            "AND session_id='current'"
        )
        n = cur.fetchone()[0]
        con.close()
        return n > 0
    except sqlite3.Error:
        return False


def main() -> None:
    op, args = parse_cli()
    if op not in END_OPS:
        emit(True, "not a session-end op")

    code_changed = bool(args.get("code_changed"))
    if not code_changed:
        emit(True, "no code changes this session")

    if recent_lesson(repo_root()):
        emit(True, "lesson/decision recorded this session")

    emit(
        False,
        "session-memory-write: code changed but no decision/lesson/pattern row in short_term.db. "
        "Insert one before terminating.",
    )


if __name__ == "__main__":
    main()
