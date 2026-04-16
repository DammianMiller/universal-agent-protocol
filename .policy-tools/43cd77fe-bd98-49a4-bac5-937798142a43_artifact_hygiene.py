#!/usr/bin/env python3
"""artifact-hygiene enforcer: block binary artifacts outside curated dirs."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

BINARY_RE = re.compile(r"\.(png|jpe?g|gif|pdf|zip|tar\.gz|tgz|db|sqlite\d?)$", re.I)
ALLOWED_PREFIXES = (
    "docs/",
    "tests/",
    "apps/",
    "agents/data/memory/",
    ".playwright-mcp/",
    "observability/",
)
ALLOWED_SUBSTRINGS = ("/__screenshots__/", "/public/", "/static/", "/assets/")
WRITE_OPS = {"Write", "write", "create-file"}


def main() -> None:
    op, args = parse_cli()
    if op not in WRITE_OPS:
        emit(True, "not a write op")

    path = (args.get("file_path") or args.get("path") or "").replace("\\", "/")
    if not BINARY_RE.search(path):
        emit(True, "not a binary artifact")

    rel = path
    for marker in ("/pay2u/", "/miller-tech/"):
        if marker in rel:
            rel = rel.split(marker, 1)[1]
            break

    if any(rel.startswith(p) for p in ALLOWED_PREFIXES):
        emit(True, f"allowed prefix: {rel}")
    if any(s in rel for s in ALLOWED_SUBSTRINGS):
        emit(True, f"allowed subdir: {rel}")

    emit(
        False,
        f"artifact-hygiene: binary '{rel}' must live under docs/, tests/, or apps/**/public|static|assets. "
        "Do not litter repo root.",
    )


if __name__ == "__main__":
    main()
