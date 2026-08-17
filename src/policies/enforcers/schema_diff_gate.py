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


def merge_in_progress(root: Path) -> bool:
    """Whether a merge is underway — invocation-constant, so resolved ONCE.

    This used to be re-derived per watched file, spawning a `git rev-parse`
    for each one on the hot path of every commit and push, purely to learn
    "not a merge". A merge touching 30 migrations paid 30 spawns.
    """
    rc, git_dir_out, _ = run(["git", "rev-parse", "--absolute-git-dir"], cwd=root)
    if rc != 0:
        return False
    return (Path(git_dir_out.strip()) / "MERGE_HEAD").exists()


def merge_verbatim(root: Path, path: str) -> bool:
    """During a merge, a staged watched file that is byte-identical to the
    incoming MERGE_HEAD version was not authored on this branch — it was
    reviewed and gated on its own branch and arrives verbatim. Gating it here
    forced a schema-diff re-pass for content the merge cannot change (hit on
    the 2026-08-16 pay2u #3153 conflict-resolution merge, where migrations
    from already-merged main blocked the merge commit)."""
    rc, staged_sha, _ = run(["git", "rev-parse", f":{path}"], cwd=root)
    rc2, theirs_sha, _ = run(["git", "rev-parse", f"MERGE_HEAD:{path}"], cwd=root)
    if rc != 0 or rc2 != 0 or staged_sha.strip() != theirs_sha.strip():
        return False

    # The INDEX matching theirs is not enough: `git commit -a` and
    # `git commit -- <path>` commit the WORKING TREE. Exempting on the index
    # alone let an unstaged edit ride along ungated -- reproduced: an appended
    # `DROP TABLE users;` yielded {"allowed": true, "reason": "no watched
    # schema/pool paths in diff"} while `commit -am` would have committed the
    # drop.
    #
    # `git diff --quiet` rather than hashing the file ourselves: it exits 0
    # exactly when the worktree copy matches the index, using git's own
    # comparison. Hashing followed symlinks (so a verbatim merged symlink never
    # matched), failed outright on a dangling link or a sparse/skip-worktree
    # path, and re-ran clean filters on large files against a 5s timeout --
    # every one of those a FALSE BLOCK on a legitimate merge.
    rc3, _, _ = run(["git", "diff", "--quiet", "--", path], cwd=root)
    return rc3 == 0


def touched_watched_paths(root: Path) -> list[str]:
    rc, out, _ = run(["git", "diff", "--name-only", "HEAD"], cwd=root)
    if rc != 0:
        return []
    rc2, staged, _ = run(["git", "diff", "--name-only", "--cached"], cwd=root)
    all_files = (out + "\n" + (staged if rc2 == 0 else "")).splitlines()
    # dict.fromkeys dedupes while preserving order: a file that is both
    # unstaged and staged appeared twice, and the gate's reason line listed it
    # twice ("covers: x, x"), which reads like two files were covered.
    watched = list(dict.fromkeys(f for f in all_files if f and WATCHED_RE.search(f)))
    # Nothing watched is the overwhelmingly common case; probing git there
    # would make the hoist a net cost rather than a saving.
    if not watched or not merge_in_progress(root):
        return watched
    return [f for f in watched if not merge_verbatim(root, f)]


def _parse_marker_ts(raw) -> float | None:
    """Epoch seconds for a marker timestamp, or None when it cannot be read.

    Stored as UTC ISO-8601 with a trailing Z; parsed as UTC because
    time.mktime would read them as local time and expire the marker hours
    early or late depending on the host timezone.
    """
    if not isinstance(raw, str):
        return None
    try:
        import calendar
        return calendar.timegm(time.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:  # noqa: BLE001
        return None


def schema_diff_ok(root: Path) -> bool:
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        # `uap memory store` writes to `memories` (type 'action'), while older
        # UAP wrote session rows to `session_memories` — accept the marker from
        # either table so the documented remedy actually clears the gate.
        newest = None
        for table in ("memories", "session_memories"):
            try:
                # ANCHORED to the recorder's fixed prefix. The old
                # '%schema-diff%pass%' matched those substrings anywhere in any
                # memory -- including this gate's OWN refusal text ("...require
                # `uap schema-diff` to pass"), so an agent storing the blocker
                # as a lesson unblocked itself, and a note saying the diff
                # FAILED cleared it just as well. Verified both.
                cur = con.execute(
                    f"SELECT timestamp FROM {table} "
                    "WHERE content LIKE 'schema-diff pass: base %' "
                    "ORDER BY id DESC LIMIT 1"
                )
                r = cur.fetchone()
                # Compare PARSED epochs, not raw strings. The two tables need
                # not share a timestamp format, and a lexicographic winner that
                # then fails to parse returned False without ever considering
                # the runner-up: one legacy row sorting above ISO-8601 (say
                # "2026/08/17", '/' > '-') would out-rank every correct marker
                # forever, and re-running the remedy could not help because it
                # writes to the other table. Gate shut permanently, no waiver.
                # A malformed row is ignored, never authoritative.
                ts_val = _parse_marker_ts(r[0]) if r else None
                if ts_val is not None and (newest is None or ts_val > newest):
                    newest = ts_val
            except sqlite3.Error:
                continue
        con.close()
        if newest is None:
            return False
        ts = newest
        # Two-sided. The upper bound alone let a FUTURE timestamp clear the
        # gate until wall-clock caught up -- reachable via an importing writer
        # that supplies its own timestamp, or plain clock skew. A small
        # tolerance absorbs sub-second skew between writer and reader.
        age = time.time() - ts
        return -5 <= age < RECENT_SEC
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
        # Says what was checked, not what it "covers". The marker is not scoped
        # to files, so claiming coverage of these specific paths asserted
        # something the gate never computed.
        emit(True, f"recent schema-diff pass on record; watched paths: {', '.join(watched[:5])}")

    emit(
        False,
        "schema-diff-gate: changes to "
        + ", ".join(watched[:5])
        + " require `uap schema-diff` to pass (within 1h). Run it and re-commit.",
    )


if __name__ == "__main__":
    main()
