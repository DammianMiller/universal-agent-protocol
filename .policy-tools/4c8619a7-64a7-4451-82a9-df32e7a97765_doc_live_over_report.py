#!/usr/bin/env python3
"""doc-live-over-report enforcer: block new *_REPORT/*_COMPLETE/*_SUMMARY/*_PLAN md files."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

BLOCKED_RE = re.compile(
    r"(_REPORT|_COMPLETE|_SUMMARY|_PLAN|_FIX_\d|_\d{4}-\d{2}-\d{2})\.md$",
    re.I,
)
SCOPED_DIRS = ("infra/", "docs/", "")
WRITE_OPS = {"Write", "write", "create-file"}


def main() -> None:
    op, args = parse_cli()
    if op not in WRITE_OPS:
        emit(True, "not a write op")

    path = args.get("file_path") or args.get("path") or ""
    if not path.endswith(".md"):
        emit(True, "not a markdown file")

    rel = path.replace("\\", "/")
    # Strip leading abs path prefix if present
    for marker in ("/pay2u/", "/miller-tech/"):
        if marker in rel:
            rel = rel.split(marker, 1)[1]
            break

    is_scoped = any(rel.startswith(d) for d in SCOPED_DIRS if d) or "/" not in rel
    if not is_scoped:
        emit(True, "out-of-scope path")

    if BLOCKED_RE.search(rel):
        emit(
            False,
            f"doc-live-over-report: '{rel}' is a retrospective/dated doc pattern. "
            "Update canonical README/runbook instead.",
        )

    emit(True, "not a blocked doc pattern")


if __name__ == "__main__":
    main()
