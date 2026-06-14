#!/usr/bin/env python3
"""delivery-enforcement enforcer: route substantive coding through `uap deliver`.

Fires on Edit/Write/MultiEdit to source-code files. The intent is that
non-trivial coding work goes through the `uap deliver` convergence loop (which
drives a model to verified completion against the real gates) rather than
ad-hoc hand edits.

SAFETY — default mode is ADVISORY (always allows, logs a nudge), so installing
this policy never breaks editing. Strict enforcement is opt-in:

  UAP_ENFORCE_DELIVERY=block   # direct source edits outside a deliver context
                               # are blocked (exit 2)

Escape hatches (always honored, even in block mode):
  - UAP_DELIVER_ACTIVE=1   set by the deliver loop for its own subprocesses
  - UAP_DELIVER_BYPASS=1   explicit operator override for a sanctioned manual edit

Exempt by construction: non-source files, docs/configs/scripts/policies, test
files (deliver protects those itself), and tooling dot-dirs.
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

# Only real implementation code is gated.
SOURCE_EXTS = (
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".swift", ".kt",
    ".c", ".cc", ".cpp", ".h", ".hpp",
)

EXEMPT_PREFIXES = (
    ".claude/", ".cursor/", ".opencode/", ".codex/", ".forge/", ".omp/",
    ".uap/", ".policy-tools/",
    "src/policies/", "scripts/", "docs/", "policies/", "test/", "tests/",
)

# Test files are protected by deliver itself; never gate them here.
TEST_MARKERS = (".test.", ".spec.", "_test.", "/test/", "/tests/", "/__tests__/")


def main() -> None:
    op, args = parse_cli()
    if op not in EDIT_OPS:
        emit(True, "not a file-edit operation")

    target = args.get("file_path") or args.get("path") or args.get("target") or ""
    if not target:
        emit(True, "no file path in args")

    root = repo_root()
    try:
        rel = str(Path(target).resolve().relative_to(root))
    except ValueError:
        emit(True, "target outside repo")

    rel_posix = rel.replace(os.sep, "/")
    low = rel_posix.lower()

    if not low.endswith(SOURCE_EXTS):
        emit(True, "not source code")
    if any(rel_posix.startswith(p) for p in EXEMPT_PREFIXES):
        emit(True, f"exempt path: {rel_posix}")
    if any(m in "/" + low for m in TEST_MARKERS):
        emit(True, "test file (protected by deliver itself)")

    # Escape hatches.
    if os.environ.get("UAP_DELIVER_ACTIVE") == "1":
        emit(True, "inside a deliver-driven run")
    if os.environ.get("UAP_DELIVER_BYPASS") == "1":
        emit(True, "UAP_DELIVER_BYPASS override set")

    msg = (
        f"delivery-enforcement: '{rel_posix}' is source code being edited directly. "
        "Route substantive coding through `uap deliver` (drives a model to verified "
        "completion against the gates), or set UAP_DELIVER_BYPASS=1 for a sanctioned "
        "manual edit."
    )

    mode = os.environ.get("UAP_ENFORCE_DELIVERY", "advisory").lower()
    if mode == "block":
        emit(False, msg)

    # Advisory (default): never blocks. Surface the nudge, then allow.
    print(f"[delivery-enforcement advisory] {msg}", file=sys.stderr)
    emit(True, "advisory: nudge logged (set UAP_ENFORCE_DELIVERY=block to enforce)")


if __name__ == "__main__":
    main()
