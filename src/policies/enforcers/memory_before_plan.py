#!/usr/bin/env python3
"""memory-before-plan enforcer: plans require a recent uap memory query."""
from __future__ import annotations
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli, repo_root  # noqa: E402

PLAN_OPS = {"ExitPlanMode", "Plan", "TodoWrite", "plan", "design"}
# Only match standalone words, not compounds like 'validate-plan-before-build'
PLAN_WORD_RE = re.compile(r"(?<![-\w/])(plan the|design the|architect the|propose a plan|roadmap for)", re.I)
RECENT_SEC = 300


def recent_memory_query(root: Path) -> bool:
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        cur = con.execute(
            "SELECT timestamp FROM session_memories "
            "WHERE content LIKE '%uap memory query%' OR type='memory_query' "
            "ORDER BY id DESC LIMIT 1"
        )
        row = cur.fetchone()
        con.close()
        if not row:
            return False
        raw = row[0][:19].replace("T", " ")
        try:
            ts = time.mktime(time.strptime(raw, "%Y-%m-%d %H:%M:%S"))
        except Exception:  # noqa: BLE001
            return False
        # Memory is stored as UTC from datetime('now'); compare with UTC now
        return (time.time() - (ts - time.timezone)) < RECENT_SEC
    except sqlite3.Error:
        return False


def main() -> None:
    op, args = parse_cli()
    blob = f"{op} {arg_str(args)}"
    if op not in PLAN_OPS and not PLAN_WORD_RE.search(blob):
        emit(True, "not a plan operation")

    if recent_memory_query(repo_root()):
        emit(True, "recent uap memory query on record")

    emit(
        False,
        "memory-before-plan: run `uap memory query <topic>` before planning to surface prior context",
    )


if __name__ == "__main__":
    main()
