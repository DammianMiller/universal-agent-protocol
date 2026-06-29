"""Tests for worktree-required R1 (fail-open on non-git) + R3 (route hint)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "worktree_required.py"


def run(root, target):
    e = dict(os.environ)
    e["UAP_REPO_ROOT"] = str(root)
    e.pop("UAP_NO_WORKTREE", None)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", "Write",
         "--args", json.dumps({"file_path": str(target)})],
        capture_output=True, text=True, env=e,
    )
    out = json.loads(p.stdout) if p.stdout.strip() else {}
    return p.returncode, out


class WorktreeRequiredTest(unittest.TestCase):
    def test_R1_fail_open_on_non_git(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            f = root / "foo.ts"
            f.write_text("x")
            rc, out = run(root, f)
            self.assertEqual(rc, 0)
            self.assertTrue(out["allowed"])
            self.assertIn("not a git repo", out["reason"])

    def test_R3_blocks_with_route_on_git_repo(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()  # make it look like a git repo
            f = root / "src" / "app.ts"
            f.parent.mkdir(parents=True)
            f.write_text("x")
            rc, out = run(root, f)
            self.assertEqual(rc, 2)
            self.assertFalse(out["allowed"])
            self.assertEqual(out.get("route"), "worktree")
            self.assertIn("worktreeHint", out)
            self.assertIn("run the command now", out["reason"])

    def test_worktree_path_allowed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            f = root / ".worktrees" / "001-x" / "a.ts"
            f.parent.mkdir(parents=True)
            f.write_text("x")
            rc, out = run(root, f)
            self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
