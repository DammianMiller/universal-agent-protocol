#!/usr/bin/env python3
"""branch-freshness enforcer: a worktree branch must not drift far from the
integration branch before it is allowed to keep accumulating edits.

The file-level companion (coordinate-file.sh) blocks precisely: only when the
FILE being edited moved on the integration branch. That is the right default —
it never freezes work that cannot conflict. This enforcer is the coarse backstop
for the other failure mode: a branch so far behind that its whole mental model of
the codebase is wrong, where the eventual merge is a rewrite rather than a merge.

Measured on this repo before the gate existed: 151 worktrees, the worst 1241
commits behind origin/master, 23 holding unmerged commits. None of that drift was
visible to any gate.

Env:
  UAP_NO_FRESHNESS=1        disable entirely
  UAP_FRESHNESS_WARN=<n>    advisory threshold (default 50)
  UAP_FRESHNESS_BLOCK=<n>   blocking threshold (default 200)
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, run, worktree_root  # noqa: E402

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

DEFAULT_WARN = 50
DEFAULT_BLOCK = 200


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def integration_ref(root: Path) -> str | None:
    """origin/HEAD -> origin/master -> origin/main, or None when there is no remote."""
    code, out, _ = run(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd=root)
    if code == 0 and out.strip():
        return out.strip().replace("refs/remotes/", "")
    for candidate in ("master", "main"):
        code, _, _ = run(
            ["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{candidate}"],
            cwd=root,
        )
        if code == 0:
            return f"origin/{candidate}"
    return None


def commits_behind(root: Path, ref: str) -> int | None:
    code, out, _ = run(["git", "rev-list", "--count", f"HEAD..{ref}"], cwd=root)
    if code != 0:
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def main() -> None:
    op, args = parse_cli()
    if op not in EDIT_OPS:
        emit(True, "not a file-edit operation")

    if os.environ.get("UAP_NO_FRESHNESS") == "1":
        emit(True, "UAP_NO_FRESHNESS override set")

    target = args.get("file_path") or args.get("path") or args.get("target") or ""
    if not target:
        emit(True, "no file path in args")

    # Only worktree edits are in scope. Edits in the main checkout are governed by
    # worktree-required, and non-repo paths are none of our business.
    if ".worktrees/" not in str(Path(target)):
        emit(True, "not a worktree edit")

    root = worktree_root()
    # A linked worktree has .git as a FILE, not a directory — both are valid.
    git_marker = root / ".git"
    if not git_marker.exists():
        emit(True, "not a git working tree — fail open")

    ref = integration_ref(root)
    if ref is None:
        emit(True, "no integration ref (no remote) — fail open")

    behind = commits_behind(root, ref)
    if behind is None:
        emit(True, "drift not measurable — fail open")

    warn_at = _int_env("UAP_FRESHNESS_WARN", DEFAULT_WARN)
    block_at = _int_env("UAP_FRESHNESS_BLOCK", DEFAULT_BLOCK)
    # A warn threshold above the block threshold would silently never fire.
    if warn_at > block_at:
        warn_at = block_at

    if behind >= block_at:
        emit(
            False,
            f"branch-freshness: this worktree is {behind} commits behind {ref} "
            f"(limit {block_at}). Edits here are being written against a codebase that "
            "has moved on, and the merge will be a rewrite rather than a merge. "
            "Run `uap worktree sync` first. Override: UAP_NO_FRESHNESS=1.",
            route="worktree-sync",
            worktreeHint="uap worktree sync",
            behind=behind,
        )

    if behind >= warn_at:
        emit(
            True,
            f"branch-freshness: {behind} commits behind {ref} — consider "
            "`uap worktree sync` before this grows into a conflict.",
            behind=behind,
        )

    # Report `behind` on EVERY path, not just warn/block — callers and tests read
    # it for observability, and a field that appears only on failure is a field
    # nobody can build a dashboard on.
    emit(True, f"fresh ({behind} behind {ref})", behind=behind)


if __name__ == "__main__":
    main()
