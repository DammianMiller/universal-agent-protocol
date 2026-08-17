"""Tests for the schema-diff-gate enforcer fixes (self-deadlock + marker read).

Covers the 2026-07-08 mid-session incident: bare "Bash" in COMMIT_OPS gated
EVERY shell command (including the `uap schema-diff` remedy — self-deadlock),
and the pass-marker check read only the legacy session_memories table and
parsed UTC timestamps with time.mktime (host-timezone skew).
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENFORCER = REPO / "src" / "policies" / "enforcers" / "schema_diff_gate.py"


def run_gate(op: str, args: dict, root: Path, tz: str | None = None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    if tz:
        env["TZ"] = tz
    r = subprocess.run(
        ["python3", str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    try:
        payload = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        payload = {}
    return r.returncode, payload.get("allowed", False), payload.get("reason", "")


class SchemaDiffGateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="schema-gate-")
        self.root = Path(self._tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
            cwd=self.root,
            check=True,
        )
        (self.root / "migrations").mkdir()
        (self.root / "migrations" / "001_add_table.sql").write_text("CREATE TABLE t (id int);")
        subprocess.run(["git", "add", "migrations"], cwd=self.root, check=True)

    def tearDown(self):
        self._tmp.cleanup()

    # The literal the CLI records (src/cli/schema-diff.ts). The gate matches it
    # ANCHORED, so this string is now a contract between the two.
    MARKER = "schema-diff pass: base HEAD~1 | files: migrations/001_add_table.sql"

    def write_marker(self, iso_timestamp: str, table: str = "memories", content: str | None = None):
        mem = self.root / "agents" / "data" / "memory"
        mem.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(mem / "short_term.db")
        con.execute(
            f"CREATE TABLE IF NOT EXISTS {table} "
            "(id INTEGER PRIMARY KEY, content TEXT, timestamp TEXT)"
        )
        con.execute(
            f"INSERT INTO {table} (content, timestamp) VALUES (?, ?)",
            (self.MARKER if content is None else content, iso_timestamp),
        )
        con.commit()
        con.close()

    def test_ordinary_bash_is_not_a_gate_point(self):
        """Regression: bare Bash op must not gate — that deadlocked the remedy itself."""
        code, allowed, reason = run_gate("Bash", {"command": "uap schema-diff"}, self.root)
        self.assertEqual(code, 0)
        self.assertTrue(allowed)
        self.assertIn("not a commit/push gate point", reason)

    def test_commit_command_still_gated(self):
        code, allowed, reason = run_gate("Bash", {"command": 'git commit -m "add migration"'}, self.root)
        self.assertEqual(code, 2)
        self.assertFalse(allowed)
        self.assertIn("uap schema-diff", reason)

    def test_fresh_marker_in_memories_table_clears_gate(self):
        """`uap memory store` writes to `memories`; the gate must accept it."""
        self.write_marker(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        code, allowed, reason = run_gate("git-commit", {}, self.root)
        self.assertEqual(code, 0)
        self.assertTrue(allowed)
        self.assertIn("recent schema-diff pass", reason)

    def test_legacy_session_memories_table_still_accepted(self):
        self.write_marker(
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), table="session_memories"
        )
        code, allowed, _ = run_gate("git-commit", {}, self.root)
        self.assertEqual(code, 0)
        self.assertTrue(allowed)

    def test_stale_marker_blocks_regardless_of_host_timezone(self):
        """Pre-fix, time.mktime read UTC timestamps as local: east-of-UTC hosts
        saw stale markers shifted into the future and the gate cleared on a
        2h-old pass."""
        stale = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.write_marker(stale)
        code, allowed, _ = run_gate("git-commit", {}, self.root, tz="Australia/Sydney")
        self.assertEqual(code, 2)
        self.assertFalse(allowed)

    def test_the_gates_own_refusal_message_does_not_clear_it(self):
        """A block message that is itself a valid unblock token is self-defeating.

        The old matcher was LIKE '%schema-diff%pass%', which the gate's own
        refusal text satisfies ("...require `uap schema-diff` to pass"). Agents
        here are instructed to store lessons, and blockers are exactly what they
        store — so recording the refusal unblocked the next commit.
        """
        self.write_marker(
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            content=(
                "Lesson: schema-diff-gate: changes to migrations/001_add_table.sql "
                "require `uap schema-diff` to pass (within 1h). Run it and re-commit."
            ),
        )
        code, allowed, _ = run_gate("git-commit", {}, self.root)
        self.assertFalse(allowed, "the gate's own refusal text must not clear the gate")
        self.assertEqual(code, 2)

    def test_a_marker_from_the_PREVIOUS_cli_release_still_clears_it(self):
        """Anchoring must not deadlock operators running an older global `uap`.

        The previously-released recorder wrote
        "schema-diff pass: base <b>, N schema file(s) checked, no breaking
        changes" — same prefix — so it still matches. If a future format change
        drops that prefix, the gate must be updated in the same commit or every
        operator on the old CLI is blocked with no reachable remedy.
        """
        self.write_marker(
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            content="schema-diff pass: base HEAD~1, 3 schema file(s) checked, no breaking changes",
        )
        _, allowed, _ = run_gate("git-commit", {}, self.root)
        self.assertTrue(allowed, "a marker from the previous CLI release must still clear the gate")

    def test_a_note_saying_the_diff_FAILED_does_not_clear_it(self):
        self.write_marker(
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            content="schema-diff FAILED - breaking change, do not pass this to review",
        )
        _, allowed, _ = run_gate("git-commit", {}, self.root)
        self.assertFalse(allowed, "a failure note must not read as a pass")

    def test_a_future_dated_marker_does_not_clear_it(self):
        """The window was upper-bounded only, so a future timestamp cleared the
        gate until wall-clock caught up — reachable via an importing writer that
        supplies its own timestamp, or plain clock skew."""
        ahead = (datetime.now(timezone.utc) + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.write_marker(ahead)
        _, allowed, _ = run_gate("git-commit", {}, self.root)
        self.assertFalse(allowed, "a future-dated marker must not clear the gate")

    def test_watched_path_is_listed_once(self):
        """A file both unstaged and staged appeared twice in the reason line,
        which reads as two covered files."""
        (self.root / "migrations" / "001_add_table.sql").write_text("CREATE TABLE t (id bigint);")
        _, _, reason = run_gate("git-commit", {"command": "git commit"}, self.root)
        self.assertEqual(reason.count("001_add_table.sql"), 1, reason)


class MergeVerbatimTest(unittest.TestCase):
    """2026-08-16 pay2u #3153 incident: a conflict-resolution merge staged
    migration files that arrived VERBATIM from the already-merged base branch,
    and the gate demanded a schema-diff re-pass for content this branch never
    authored. merge_verbatim() must exempt staged files whose blob equals the
    MERGE_HEAD version — and must NOT exempt files the merge actually edited."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="schema-gate-merge-")
        self.root = Path(self._tmp.name)
        g = lambda *a: subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", *a],
            cwd=self.root, check=True, capture_output=True,
        )
        g("init", "-q", "-b", "main")
        (self.root / "migrations").mkdir()
        (self.root / "base.txt").write_text("base")
        g("add", "-A")
        g("commit", "-q", "-m", "init")
        # Feature branch diverges without touching migrations.
        g("checkout", "-q", "-b", "feature")
        (self.root / "feature.txt").write_text("feature work")
        g("add", "-A")
        g("commit", "-q", "-m", "feature")
        # Main gains a watched migration (reviewed there).
        g("checkout", "-q", "main")
        (self.root / "migrations" / "001_add_table.sql").write_text("CREATE TABLE t (id int);")
        g("add", "-A")
        g("commit", "-q", "-m", "migration on main")
        # Merge main INTO feature: migration arrives verbatim, merge left open
        # (no commit) so MERGE_HEAD exists and the file is staged.
        g("checkout", "-q", "feature")
        subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-commit", "--no-ff", "main"],
            cwd=self.root, check=True, capture_output=True,
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_verbatim_incoming_migration_is_exempt(self):
        _, allowed, reason = run_gate("git-commit", {"command": "git commit"}, self.root)
        self.assertTrue(allowed, f"verbatim merge-incoming migration should not gate: {reason}")

    def test_merge_edited_migration_still_gates(self):
        # Editing the migration during the merge makes it THIS branch's change.
        # NB this stages the edit; the UNSTAGED variant below is the one that
        # was actually exploitable.
        (self.root / "migrations" / "001_add_table.sql").write_text("CREATE TABLE t (id bigint);")
        subprocess.run(["git", "add", "migrations/001_add_table.sql"], cwd=self.root, check=True)
        _, allowed, reason = run_gate("git-commit", {"command": "git commit"}, self.root)
        self.assertFalse(allowed, "a migration edited during the merge must still gate")
        self.assertIn("schema-diff", reason)

    def test_UNSTAGED_merge_edit_still_gates(self):
        """The exemption compared the INDEX blob, but `git commit -a` commits the
        WORKING TREE.

        Reproduced against the shipped gate: with the index still matching
        MERGE_HEAD and an unstaged `DROP TABLE users;` appended, it answered
        {"allowed": true, "reason": "no watched schema/pool paths in diff"} —
        not even naming the exemption — while `git commit -am` would have
        committed the drop. This is also the likely ACCIDENTAL path: a human
        resolving a conflict, tweaking a migration, running `git commit -am`.
        """
        p = self.root / "migrations" / "001_add_table.sql"
        p.write_text(p.read_text() + "\nDROP TABLE t;\n")  # deliberately NOT staged
        _, allowed, reason = run_gate("git-commit", {"command": "git commit -am merge"}, self.root)
        self.assertFalse(
            allowed,
            "an unstaged edit during a merge is committed by `commit -a` and must gate: " + reason,
        )

    def test_a_genuinely_verbatim_merge_is_still_exempt_after_the_fix(self):
        """The deadlock fix must survive the hardening: with no local edit at
        all, the incoming migration stays exempt."""
        _, allowed, reason = run_gate("git-commit", {"command": "git commit -am merge"}, self.root)
        self.assertTrue(allowed, f"verbatim merge must remain exempt: {reason}")


if __name__ == "__main__":
    unittest.main()

