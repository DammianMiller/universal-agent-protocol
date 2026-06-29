#!/usr/bin/env python3
"""worktree-required enforcer: Edit/Write must target a .worktrees/ path."""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

EXEMPT_PREFIXES = (
    ".claude/",
    ".cursor/",
    ".opencode/",
    ".codex/",
    ".forge/",
    ".uap/",
    "src/policies/",
    "scripts/",
    "docs/",
)
EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}


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

    if rel.startswith(".worktrees/"):
        emit(True, "target inside a worktree")

    if any(rel.startswith(p) for p in EXEMPT_PREFIXES):
        emit(True, f"exempt path: {rel}")

    if os.environ.get("UAP_NO_WORKTREE") == "1":
        emit(True, "UAP_NO_WORKTREE override set")

    # R1: a worktree cannot exist without git, so the requirement is
    # UNSATISFIABLE on a non-git project -- blocking there is a guaranteed
    # deadlock (the model loops creating tasks about a worktree it can never
    # create). Fail open when there is no git metadata.
    if not os.path.exists(os.path.join(str(root), ".git")):
        emit(True, "not a git repo -- worktrees are not applicable")

    # R3: imperative message with a working fallback command + a machine-
    # actionable route hint. The old message pointed only at uap worktree
    # create, which fails on hybrid/bare repos.
    emit(
        False,
        f"BLOCKED: '{rel}' must be edited inside a worktree (.worktrees/NNN-<slug>/). "
        "Create one FIRST, then edit there: `uap worktree create <slug>` "
        "(or if that fails: `git worktree add .worktrees/001-<slug> -b feature/<slug>`). "
        "Do NOT keep planning or creating tasks about the worktree -- run the command now.",
        route="worktree",
        worktreeHint="uap worktree create <slug>",
    )


if __name__ == "__main__":
    main()
