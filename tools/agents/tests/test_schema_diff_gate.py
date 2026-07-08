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

    def write_marker(self, iso_timestamp: str, table: str = "memories"):
        mem = self.root / "agents" / "data" / "memory"
        mem.mkdir(parents=True)
        con = sqlite3.connect(mem / "short_term.db")
        con.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, content TEXT, timestamp TEXT)")
        con.execute(
            f"INSERT INTO {table} (content, timestamp) VALUES (?, ?)",
            ("schema-diff pass: verified", iso_timestamp),
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


if __name__ == "__main__":
    unittest.main()
