#!/usr/bin/env python3
"""task-required enforcer: a UAP task must be in_progress before mutating work.

Blocks Edit/Write/MultiEdit (outside exempt prefixes) and the ship actions
git commit / git push / gh pr create when no row in .uap/tasks/tasks.db has
status='in_progress'. Closes UAP protocol step 4 — which was previously
text-injection only and therefore skippable.

Fail-open: if UAP task tracking is not initialised (no tasks.db) or the DB is
unreadable, the operation is allowed — so non-UAP repos are unaffected.
Override: set UAP_NO_TASK=1 to bypass.
"""
from __future__ import annotations
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run  # noqa: E402

EDIT_OPS = {"edit", "write", "multiedit"}

# Meta / infra / docs paths that do not require a task (mirror worktree_required,
# plus .policy-tools/ which is the policy-system's own runtime artifact dir).
EXEMPT_PREFIXES = (
    ".claude/",
    ".cursor/",
    ".opencode/",
    ".codex/",
    ".forge/",
    ".uap/",
    ".policy-tools/",
    "src/policies/",
    "scripts/",
    "docs/",
)

# Bash ship actions gated even though Bash itself is otherwise unrestricted.
SHIP_PATTERNS = (
    re.compile(r"\bgit\s+(commit|push)\b"),
    re.compile(r"\bgh\s+pr\s+create\b"),
)


def main_repo_root() -> Path:
    """Resolve the primary worktree root, even when invoked from a linked
    worktree — `git rev-parse --git-common-dir` always points at the main
    .git, whose parent is the primary checkout."""
    rc, out, _ = run(["git", "rev-parse", "--git-common-dir"])
    if rc == 0 and out.strip():
        p = Path(out.strip())
        if not p.is_absolute():
            p = (Path.cwd() / p).resolve()
        return p.parent
    return repo_root()


def in_progress_task_state():
    """True if an in_progress task exists, False if none, None if UAP task
    tracking is not set up / DB unreadable (caller treats None as allow)."""
    db = main_repo_root() / ".uap" / "tasks" / "tasks.db"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            n = con.execute(
                "SELECT COUNT(*) FROM tasks WHERE status='in_progress'"
            ).fetchone()[0]
        finally:
            con.close()
        return n > 0
    except Exception:  # noqa: BLE001
        return None


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_NO_TASK") == "1":
        emit(True, "UAP_NO_TASK override set")

    op_l = op.lower()
    is_edit = op_l in EDIT_OPS
    is_bash = op_l == "bash"
    if not is_edit and not is_bash:
        emit(True, "not a mutating operation")

    if is_bash:
        cmd = args.get("command") or args.get("cmd") or ""
        if not any(p.search(cmd) for p in SHIP_PATTERNS):
            emit(True, "not a ship action")
        gate_label = "ship action (git commit/push, gh pr create)"
    else:
        target = (
            args.get("file_path")
            or args.get("path")
            or args.get("target")
            or ""
        )
        if not target:
            emit(True, "no file path in args")
        root = repo_root()
        try:
            rel = str(Path(target).resolve().relative_to(root))
        except ValueError:
            emit(True, "target outside repo")
        if any(rel.startswith(p) for p in EXEMPT_PREFIXES):
            emit(True, f"exempt path: {rel}")
        gate_label = f"edit of '{rel}'"

    state = in_progress_task_state()
    if state is None:
        emit(True, "UAP task tracking not initialised — fail-open")
    if state:
        emit(True, "in_progress UAP task present")

    emit(
        False,
        f"task-required: no in_progress UAP task — {gate_label} blocked. "
        'Run:  uap task create --type <task|bug|feature> --title "<desc>"  '
        "then:  uap task update <id> --status in_progress  "
        "(or:  uap task claim <id>  to also spin a worktree). "
        "Override for one-off meta-work: UAP_NO_TASK=1.",
    )


if __name__ == "__main__":
    main()
