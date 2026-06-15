#!/usr/bin/env python3
"""codebase-read-before-plan enforcer: plans require prior reads of target paths."""
from __future__ import annotations
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli  # noqa: E402

PLAN_OPS = {"ExitPlanMode", "Plan", "TodoWrite"}
PLAN_WORD_RE = re.compile(r"(?<![-\w/])(plan the|design the|architect the|propose a plan|spec the)", re.I)
READ_LOG = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "read_log.state"
RECENT_SEC = 1800


def recent_reads() -> set[str]:
    if not READ_LOG.exists():
        return set()
    out: set[str] = set()
    now = time.time()
    for line in READ_LOG.read_text().splitlines():
        try:
            ts, path = line.split("\t", 1)
            if now - float(ts) < RECENT_SEC:
                out.add(path)
        except ValueError:
            continue
    return out


def main() -> None:
    op, args = parse_cli()
    blob = f"{op} {arg_str(args)}"
    if op not in PLAN_OPS and not PLAN_WORD_RE.search(blob):
        emit(True, "not a plan op")

    reads = recent_reads()
    if reads:
        emit(True, f"{len(reads)} recent codebase reads on record")

    emit(
        False,
        "codebase-read-before-plan: no Read/Grep/Glob within the last 30 min. "
        "Read the existing codebase in the target scope before emitting a plan.",
    )


if __name__ == "__main__":
    main()
