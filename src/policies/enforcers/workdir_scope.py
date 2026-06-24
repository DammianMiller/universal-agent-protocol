#!/usr/bin/env python3
"""workdir-scope enforcer: file-mutating tool calls must stay within the project
working directory (the repo root + its worktrees + a small scratch allow-list).

Creating/writing/moving a path OUTSIDE the workdir is blocked by default — it
requires explicit operator approval. This is the policy-engine enforcement of the
operator rule "never step outside the current path without explicit permission":
agents running with --dangerously-skip-permissions emit absolute paths that can
escape the project (e.g. a sibling at ~/dev, or a garbled `octopusspace-shooter`),
silently creating directories outside the intended workspace.

Allowed targets:
  * anything under the current working tree (UAP_WORKTREE_ROOT) or the main
    checkout (UAP_REPO_ROOT) — worktrees included;
  * relative paths (they resolve under the project root);
  * a scratch allow-list: /tmp, $TMPDIR, ~/.cache/uap, ~/.config/uap, plus any
    colon-separated prefixes in UAP_WORKDIR_ALLOW.

Escape hatch: UAP_WORKDIR_SCOPE_OFF=1 allows everything (operator override).
"""
from __future__ import annotations

import os
import re
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, worktree_root  # noqa: E402

# Tools that create/modify a file at an explicit path argument.
PATH_WRITE_OPS = {
    "Write", "Edit", "MultiEdit", "NotebookEdit",
    "write", "edit", "multiedit", "notebookedit",
}
PATH_ARG_KEYS = ("file_path", "path", "notebook_path", "filePath", "target")

# Bash verbs that CREATE/MOVE filesystem entries (pure-read commands are ignored).
_BASH_CREATE = ("mkdir", "touch", "install", "tee")
_BASH_DEST_LAST = ("cp", "mv", "rsync")  # destination is the final argument


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(p)))


def _allowed_roots() -> list[Path]:
    roots: list[Path] = []

    def add(p: Path) -> None:
        try:
            r = p.resolve()
        except Exception:  # noqa: BLE001
            r = p
        if r not in roots:
            roots.append(r)

    add(worktree_root())
    add(repo_root())
    for p in ("/tmp", os.environ.get("TMPDIR", "/tmp"), "~/.cache/uap", "~/.config/uap"):
        add(_expand(p))
    for p in os.environ.get("UAP_WORKDIR_ALLOW", "").split(":"):
        if p.strip():
            add(_expand(p))
    return roots


def _inside(target: Path, roots: list[Path]) -> bool:
    try:
        t = target.resolve()
    except Exception:  # noqa: BLE001
        t = target
    for root in roots:
        try:
            t.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _check_path(target: str, roots: list[Path]) -> str:
    """Return the offending absolute path if out of scope, else ''."""
    if not target:
        return ""
    p = _expand(target)
    if not p.is_absolute():
        # Relative paths resolve under the enforcer cwd (the project root).
        return ""
    return "" if _inside(p, roots) else str(p)


def _scan_bash(cmd: str, roots: list[Path]) -> str:
    """Best-effort: flag an out-of-scope absolute path that a CREATE/MOVE command
    would write. Conservative — only inspects the destinations of known
    create/move verbs and output redirections, and ignores read sources."""
    if not cmd:
        return ""
    try:
        tokens = shlex.split(cmd, comments=True)
    except ValueError:
        tokens = cmd.split()

    candidates: list[str] = []

    # Output redirections: > /abs, >> /abs (also 2>/abs).
    for m in re.finditer(r'(?:\d*>>?|&>)\s*("?)(/[^\s"\';|&)]+)\1', cmd):
        candidates.append(m.group(2))

    # Split into pipeline/sequence segments so we read each command's own verb.
    segments = re.split(r'\|\||&&|[;|&\n]', cmd)
    for seg in segments:
        try:
            parts = shlex.split(seg, comments=True)
        except ValueError:
            parts = seg.split()
        if not parts:
            continue
        verb = os.path.basename(parts[0])
        argv = [a for a in parts[1:] if not a.startswith("-")]
        if verb in _BASH_CREATE:
            candidates.extend(argv)  # all targets are created
        elif verb in _BASH_DEST_LAST and argv:
            candidates.append(argv[-1])  # only the destination is written

    for c in candidates:
        bad = _check_path(c, roots)
        if bad:
            return bad
    return ""


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_WORKDIR_SCOPE_OFF") == "1":
        emit(True, "UAP_WORKDIR_SCOPE_OFF override set")

    roots = _allowed_roots()

    if op in PATH_WRITE_OPS:
        for key in PATH_ARG_KEYS:
            bad = _check_path(args.get(key) or "", roots)
            if bad:
                _deny(bad)
        emit(True, "target within workdir scope")

    if op in {"Bash", "bash"}:
        bad = _scan_bash(args.get("command") or "", roots)
        if bad:
            _deny(bad, bash=True)
        emit(True, "no out-of-scope write target in command")

    emit(True, "not a path-mutating operation")


def _deny(path: str, bash: bool = False) -> None:
    where = "command writes to" if bash else "target"
    emit(
        False,
        f"workdir-scope: {where} '{path}' is OUTSIDE the project working directory. "
        "Stepping outside the current path requires explicit permission. "
        "Write inside the project, or — if this is intended — re-run with "
        "UAP_WORKDIR_SCOPE_OFF=1 (or add the prefix to UAP_WORKDIR_ALLOW).",
    )


if __name__ == "__main__":
    main()
