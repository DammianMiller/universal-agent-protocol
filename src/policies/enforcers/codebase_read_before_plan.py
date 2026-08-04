#!/usr/bin/env python3
"""codebase-read-before-plan enforcer: plans require prior reads of target paths."""
from __future__ import annotations
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli, repo_root, recent_evidence  # noqa: E402

PLAN_OPS = {"ExitPlanMode", "Plan", "TodoWrite"}
PLAN_WORD_RE = re.compile(r"(?<![-\w/])(plan the|design the|architect the|propose a plan|spec the)", re.I)
READ_LOG = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "read_log.state"
RECENT_SEC = 1800
# The PostToolUse hook that writes READ_LOG. This gate accepts evidence that
# ONLY that hook produces, so without it the evidence can never appear.
#
# Checked per platform, not just under .claude/: copyHookScripts() drops the
# script into EVERY platform's hook dir, but each platform needs its own
# PostToolUse wiring. A hardcoded .claude/ probe would report "writer present"
# for a Factory or Cursor session whose settings never invoke it — enforcing
# strictly against evidence that platform cannot produce, which is the same
# permanent block this fail-open exists to prevent.
WRITER_HOOK_DIRS = (".claude", ".factory", ".cursor", ".codex", ".forge", ".opencode")
WRITER_HOOK_NAME = "post-tool-use-read.sh"


def writer_installed() -> bool:
    """True when the hook that populates READ_LOG is installed for this platform.

    Load-bearing. For a long time nothing wrote read_log.state at all: the
    matcher was never added to settings.json, the last entries aged past
    RECENT_SEC, and this gate then refused every ExitPlanMode with a remedy
    ("read the codebase first") that no amount of reading could clear. A gate
    whose writer is missing silently escalates from advisory to a wall, so when
    the writer is absent we degrade to advisory instead of bricking planning.
    """
    roots = (repo_root(), Path.cwd())
    for root in roots:
        for hook_dir in WRITER_HOOK_DIRS:
            if (root / hook_dir / "hooks" / WRITER_HOOK_NAME).exists():
                return True
    return False


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

    # Prefer the protected evidence log; fall back to the legacy read_log while
    # installs catch up. The legacy file is shell-writable, so it is accepted
    # but no longer the only source.
    trusted = recent_evidence("reads", RECENT_SEC, repo_root())
    if trusted:
        emit(True, f"{trusted} recent codebase reads on record (evidence)")

    reads = recent_reads()
    if reads:
        emit(True, f"{len(reads)} recent codebase reads on record (legacy log)")

    if not writer_installed():
        emit(True, "read-log writer hook not installed — gate advisory (run `uap hooks install`)")

    emit(
        False,
        "codebase-read-before-plan: no Read/Grep/Glob within the last 30 min. "
        "Read the existing codebase in the target scope before emitting a plan.",
    )


if __name__ == "__main__":
    main()
