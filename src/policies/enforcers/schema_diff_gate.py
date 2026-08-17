#!/usr/bin/env python3
"""schema-diff-gate enforcer: schema/pool changes must pass uap schema-diff."""
from __future__ import annotations
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run, worktree_root  # noqa: E402

WATCHED_RE = re.compile(
    r"(migrations/.*\.sql|infra/postgres-spock/|infra/helm_charts/[^/]*pgdog|"
    r"infra/helm_charts/[^/]*cnpg|infra/helm_charts/[^/]*redis|"
    r"infra/helm_charts/[^/]*envoy|infra/helm_charts/[^/]*sentinel)",
    re.I,
)
# NOTE: bare "Bash" used to be in this set, which made EVERY shell command a
# gate point — including the `uap schema-diff` remedy itself (self-deadlock).
# Gate only actual commit/push commands (main() also inspects cmd content).
COMMIT_OPS = {"git-commit", "git commit"}
RECENT_SEC = 3600


def merge_verbatim(root: Path, path: str) -> bool:
    """During a merge, a staged watched file that is byte-identical to the
    incoming MERGE_HEAD version was not authored on this branch — it was
    reviewed and gated on its own branch and arrives verbatim. Gating it here
    forced a schema-diff re-pass for content the merge cannot change (hit on
    the 2026-08-16 pay2u #3153 conflict-resolution merge, where migrations
    from already-merged main blocked the merge commit)."""
    git_dir = root / ".git"
    # Worktrees use a .git FILE pointing at the real gitdir.
    if git_dir.is_file():
        try:
            ref = git_dir.read_text().strip()
            if ref.startswith("gitdir:"):
                git_dir = Path(ref.split(":", 1)[1].strip())
        except OSError:
            return False
    if not (git_dir / "MERGE_HEAD").exists():
        return False
    rc, staged_sha, _ = run(["git", "rev-parse", f":{path}"], cwd=root)
    rc2, theirs_sha, _ = run(["git", "rev-parse", f"MERGE_HEAD:{path}"], cwd=root)
    return rc == 0 and rc2 == 0 and staged_sha.strip() == theirs_sha.strip()


def touched_watched_paths(root: Path) -> list[str]:
    rc, out, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=root)
    if rc != 0:
        return []
    rc2, staged, _ = run(["git", "diff", "--name-only", "--cached"], cwd=root)
    all_files = (out + "\n" + (staged if rc2 == 0 else "")).splitlines()
    watched = [f for f in all_files if f and WATCHED_RE.search(f)]
    return [f for f in watched if not merge_verbatim(root, f)]


def schema_diff_ok(root: Path) -> bool:
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        # `uap memory store` writes to `memories` (type 'action'), while older
        # UAP wrote session rows to `session_memories` — accept the marker from
        # either table so the documented remedy actually clears the gate.
        row = None
        for table in ("memories", "session_memories"):
            try:
                cur = con.execute(
                    f"SELECT timestamp FROM {table} "
                    "WHERE content LIKE '%schema-diff%pass%' "
                    "ORDER BY id DESC LIMIT 1"
                )
                r = cur.fetchone()
                if r and (row is None or r[0] > row[0]):
                    row = r
            except sqlite3.Error:
                continue
        con.close()
        if not row:
            return False
        try:
            # Timestamps are stored as UTC ISO-8601 (trailing 'Z'); parse them
            # as UTC — time.mktime would misread them as local time and expire
            # the marker hours early (or late) depending on the host TZ.
            import calendar
            ts = calendar.timegm(time.strptime(row[0][:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:  # noqa: BLE001
            return False
        return (time.time() - ts) < RECENT_SEC
    except sqlite3.Error:
        return False


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or "").lower()
    is_commit = op in COMMIT_OPS or "git commit" in cmd or "git push" in cmd
    if not is_commit:
        emit(True, "not a commit/push gate point")

    # git diff runs against the working tree; short_term.db lives in MAIN_ROOT
    watched = touched_watched_paths(worktree_root())
    if not watched:
        emit(True, "no watched schema/pool paths in diff")

    if schema_diff_ok(repo_root()):
        emit(True, f"recent schema-diff pass covers: {', '.join(watched[:5])}")

    emit(
        False,
        "schema-diff-gate: changes to "
        + ", ".join(watched[:5])
        + " require `uap schema-diff` to pass (within 1h). Run it and re-commit.",
    )


if __name__ == "__main__":
    main()
