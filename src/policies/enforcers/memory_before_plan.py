#!/usr/bin/env python3
"""memory-before-plan enforcer: plans require a recent uap memory query."""
from __future__ import annotations
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli, repo_root, worktree_root, recent_evidence  # noqa: E402

PLAN_OPS = {"ExitPlanMode", "Plan", "TodoWrite", "plan", "design"}
# Only match standalone words, not compounds like 'validate-plan-on-change'
PLAN_WORD_RE = re.compile(r"(?<![-\w/])(plan the|design the|architect the|propose a plan|roadmap for)", re.I)
RECENT_SEC = 300
DB_REL = Path("agents") / "data" / "memory" / "short_term.db"


def candidate_dbs() -> list[Path]:
    """Every short-term DB that could hold the evidence, worktree first.

    `uap memory query` writes to the DB under the CWD, which inside a worktree
    is the WORKTREE's DB — but this gate used to read only repo_root()'s. An
    agent doing the required query while working in a worktree (which the
    worktree policy mandates) therefore produced evidence the gate never saw,
    and the remedy could not clear it. Same repo_root()-vs-worktree_root() bug
    already fixed in expert-review-required and local-build-before-push.
    """
    seen: list[Path] = []
    for root in (worktree_root(), repo_root()):
        db = root / DB_REL
        if db not in seen:
            seen.append(db)
    return seen


def recent_memory_query(db: Path) -> bool:
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

    # Protected evidence first; the DB row is still accepted, but it is an
    # ordinary row in a database the agent writes to constantly.
    if recent_evidence("memory-queries", RECENT_SEC, repo_root()):
        emit(True, "recent uap memory query on record (evidence)")

    for db in candidate_dbs():
        if recent_memory_query(db):
            emit(True, "recent uap memory query on record (db row)")

    emit(
        False,
        "memory-before-plan: run `uap memory query <topic>` before planning to surface prior context",
    )


if __name__ == "__main__":
    main()
