#!/usr/bin/env python3
"""delivery-enforcement enforcer: route substantive coding through `uap deliver`.

Fires on Edit/Write/MultiEdit to source-code files. The intent is that
non-trivial coding work goes through the `uap deliver` convergence loop (which
drives a model to verified completion against the real gates) rather than
ad-hoc hand edits.

DEFAULT mode is BLOCK: substantive source edits must route through `uap deliver`
(set UAP_ENFORCE_DELIVERY=advisory to relax to a logged nudge). Escape hatches
(UAP_DELIVER_ACTIVE / UAP_DELIVER_BYPASS) are always honored:

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

# NOTE: `.worktrees/` is deliberately NOT exempt here. A real `uap deliver` run
# writes into a worktree but sets UAP_DELIVER_ACTIVE=1, which is honored below —
# so legitimate deliver edits still pass. An unconditional `.worktrees/` exemption
# let the model BYPASS deliver entirely by creating a worktree dir and writing
# source straight into it (observed: 24 source files written to
# .worktrees/001-space-shooter/ with no deliver run). Gating it behind the active
# flag closes that hole.
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

    # #3-F: terse, imperative, model-parseable. Weak local models otherwise
    # retry the blocked edit or hallucinate completion ("the files exist") when
    # the message is a passive explanation. State the exact next action.
    msg = (
        f"BLOCKED: do not edit '{rel_posix}' directly. "
        "To create or change code, call the `deliver` tool "
        "(or run: uap deliver \"<one-line description of the change>\"). "
        "Deliver writes the files and verifies them against the gates. "
        "Do NOT retry this edit. Do NOT say the file is written until deliver "
        "reports success. "
        "(Sanctioned manual edit only: set UAP_DELIVER_BYPASS=1.)"
    )

    mode = os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower()
    if mode == "block":
        emit(False, msg)

    # Advisory (opt-out): never blocks. Surface the nudge, then allow.
    print(f"[delivery-enforcement advisory] {msg}", file=sys.stderr)
    emit(True, "advisory: nudge logged (block is the default; UAP_ENFORCE_DELIVERY=advisory relaxes)")


if __name__ == "__main__":
    main()
