#!/usr/bin/env python3
"""delivery-enforcement must NOT let a `.worktrees/` path bypass the deliver
pipeline. A real `uap deliver` run writes into a worktree but sets
UAP_DELIVER_ACTIVE=1 (honored), so legitimate deliver edits still pass; an
unconditional `.worktrees/` exemption let the model sidestep deliver by writing
source straight into a worktree dir it created itself.
"""

import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ENF = (
    Path(__file__).resolve().parents[3]
    / "src" / "policies" / "enforcers" / "delivery_enforcement.py"
)


def run(path, root, env_extra=None):
    env = dict(os.environ)
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_ENFORCE_DELIVERY"] = "block"
    env.pop("UAP_DELIVER_ACTIVE", None)
    env.pop("UAP_DELIVER_BYPASS", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", "Write",
         "--args", json.dumps({"file_path": str(Path(root) / path)})],
        capture_output=True, text=True, env=env,
    )
    try:
        return json.loads(p.stdout)["allowed"]
    except Exception:
        return None


class TestDeliveryEnforcementWorktree(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._t = tempfile.TemporaryDirectory()
        self.root = self._t.name

    def tearDown(self):
        self._t.cleanup()

    def test_worktree_source_write_blocked_without_deliver_run(self):
        # the bypass: was ALLOWED, must now be BLOCKED
        self.assertFalse(run(".worktrees/001-x/js/game.js", self.root))

    def test_worktree_source_write_allowed_inside_deliver_run(self):
        self.assertTrue(
            run(".worktrees/001-x/js/game.js", self.root, {"UAP_DELIVER_ACTIVE": "1"})
        )

    def test_worktree_nonsource_still_allowed(self):
        self.assertTrue(run(".worktrees/001-x/css/styles.css", self.root))

    def test_direct_source_still_blocked(self):
        self.assertFalse(run("src/game.js", self.root))

    def test_other_exemptions_intact(self):
        self.assertTrue(run(".uap/state.js", self.root))
        self.assertTrue(run("scripts/build.js", self.root))

    def test_bypass_override_still_works(self):
        self.assertTrue(
            run(".worktrees/001-x/js/game.js", self.root, {"UAP_DELIVER_BYPASS": "1"})
        )


if __name__ == "__main__":
    unittest.main()
