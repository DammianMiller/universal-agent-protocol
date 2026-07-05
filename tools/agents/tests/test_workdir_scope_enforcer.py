#!/usr/bin/env python3
"""Tests for the workdir-scope policy enforcer.

Invoked the way the policy gate invokes it: a subprocess given --operation and
--args, returning {"allowed": bool, "reason": str} on stdout and exit 0/2. The
project roots are supplied via UAP_REPO_ROOT / UAP_WORKTREE_ROOT (as the gate
does), pointed at a temp directory so tests are hermetic.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = (
    Path(__file__).resolve().parents[3]
    / "src" / "policies" / "enforcers" / "workdir_scope.py"
)


def run(op, args, root, env_extra=None):
    env = dict(os.environ)
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    env.pop("UAP_WORKDIR_SCOPE_OFF", None)
    env.pop("UAP_WORKDIR_ALLOW", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(
        [sys.executable, str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=env, cwd=str(root),
    )
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        out = {"allowed": True, "reason": f"<unparseable: {p.stdout!r} {p.stderr!r}>"}
    return out, p.returncode


class TestWorkdirScopeEnforcer(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / ".worktrees" / "001-x").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _allow(self, out, code, msg=""):
        self.assertTrue(out["allowed"], f"{msg}: {out}")
        self.assertEqual(code, 0)

    def _block(self, out, code, msg=""):
        self.assertFalse(out["allowed"], f"{msg}: {out}")
        self.assertEqual(code, 2)
        self.assertIn("workdir-scope", out["reason"])

    # --- file-write tools ---

    def test_write_inside_root_allowed(self):
        out, c = run("Write", {"file_path": str(self.root / "src/a.js")}, self.root)
        self._allow(out, c, "in-root write")

    def test_write_outside_root_blocked(self):
        out, c = run("Write", {"file_path": "/home/cogtek/dev/octopusspace-shooter/x.js"}, self.root)
        self._block(out, c, "out-of-root write")

    def test_relative_path_allowed(self):
        out, c = run("Edit", {"file_path": "src/a.js"}, self.root)
        self._allow(out, c, "relative path")

    def test_scratch_tmp_allowed(self):
        out, c = run("Write", {"file_path": "/tmp/uap-scratch/x"}, self.root)
        self._allow(out, c, "/tmp scratch")

    def test_claude_memory_dir_allowed(self):
        # ~/.claude/projects is the Claude Code harness's auto-memory/session
        # storage; the harness instructs agents to write memories there.
        out, c = run(
            "Write",
            {"file_path": str(Path.home() / ".claude/projects/-x-proj/memory/note.md")},
            self.root,
        )
        self._allow(out, c, "claude memory dir")

    def test_worktree_path_allowed(self):
        out, c = run("Write", {"file_path": str(self.root / ".worktrees/001-x/f.ts")}, self.root)
        self._allow(out, c, "worktree path")

    def test_notebook_edit_outside_blocked(self):
        out, c = run("NotebookEdit", {"notebook_path": "/etc/evil.ipynb"}, self.root)
        self._block(out, c, "notebook outside")

    # --- bash ---

    def test_bash_mkdir_outside_blocked(self):
        out, c = run("Bash", {"command": "mkdir -p /home/cogtek/dev/octopusspace-shooter/js"}, self.root)
        self._block(out, c, "mkdir outside")

    def test_bash_mkdir_inside_allowed(self):
        out, c = run("Bash", {"command": "mkdir -p ./src/new"}, self.root)
        self._allow(out, c, "mkdir inside")

    def test_bash_read_only_allowed(self):
        out, c = run("Bash", {"command": "cat /etc/hosts && ls /usr/bin"}, self.root)
        self._allow(out, c, "read-only command")

    def test_bash_cp_dest_outside_blocked(self):
        out, c = run("Bash", {"command": "cp ./a.txt /var/tmp2/out/b.txt"}, self.root)
        self._block(out, c, "cp dest outside")

    def test_bash_cp_source_outside_dest_inside_allowed(self):
        out, c = run("Bash", {"command": "cp /etc/hosts ./local-hosts"}, self.root)
        self._allow(out, c, "read source outside, write inside")

    def test_bash_redirect_outside_blocked(self):
        out, c = run("Bash", {"command": "echo hi > /opt/somewhere/file"}, self.root)
        self._block(out, c, "redirect outside")

    # --- overrides / non-mutating ---

    def test_scope_off_override_allows(self):
        out, c = run("Write", {"file_path": "/anywhere/x"}, self.root, {"UAP_WORKDIR_SCOPE_OFF": "1"})
        self._allow(out, c, "scope-off override")

    def test_workdir_allow_widens(self):
        out, c = run("Write", {"file_path": "/opt/extra/x"}, self.root, {"UAP_WORKDIR_ALLOW": "/opt/extra"})
        self._allow(out, c, "allow-list widened")

    def test_non_path_op_allowed(self):
        out, c = run("Grep", {"pattern": "foo"}, self.root)
        self._allow(out, c, "non-path op")

    def test_read_op_outside_allowed(self):
        # Reading outside the workdir is fine; only mutations are scoped.
        out, c = run("Read", {"file_path": "/etc/hosts"}, self.root)
        self._allow(out, c, "read outside allowed")


if __name__ == "__main__":
    unittest.main()
