#!/usr/bin/env python3
"""parallel-reads enforcer: nudge when serial read fan-out is detected."""
from __future__ import annotations
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

READ_OPS = {"Read", "Grep", "Glob", "WebFetch", "read", "grep", "glob", "webfetch"}
STATE = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "parallel_reads.state"
WINDOW_SEC = 4.0
THRESHOLD = 2


def main() -> None:
    op, _args = parse_cli()
    if op not in READ_OPS:
        emit(True, "not a read op")

    STATE.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    history: list[float] = []
    if STATE.exists():
        try:
            history = [
                float(l) for l in STATE.read_text().splitlines() if l.strip()
            ]
        except ValueError:
            history = []

    history = [t for t in history if now - t < WINDOW_SEC]
    history.append(now)
    STATE.write_text("\n".join(f"{t}" for t in history[-10:]))

    if len(history) > THRESHOLD:
        emit(
            True,
            f"parallel-reads: {len(history)} serial read ops in {WINDOW_SEC}s "
            "— batch independent reads in a single tool-call message for 2-5x speed-up",
            warning=True,
        )

    emit(True, "read cadence within batch window")


if __name__ == "__main__":
    main()
