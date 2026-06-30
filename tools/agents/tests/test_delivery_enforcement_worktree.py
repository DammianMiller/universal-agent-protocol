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


import os as _os, subprocess as _sp, sys as _sys, json as _json, tempfile as _tf
from pathlib import Path as _Path
_ENF = _Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"

class LocalAdvisoryTest(unittest.TestCase):
    def _run(self, extra_env):
        with _tf.TemporaryDirectory() as td:
            root = _Path(td); (root/".git").mkdir()
            f = root/"src"/"a.ts"; f.parent.mkdir(parents=True); f.write_text("x")
            e = dict(_os.environ); e["UAP_REPO_ROOT"]=str(root)
            for k in ("ANTHROPIC_BASE_URL","UAP_DELIVER_LOCAL_ADVISORY","UAP_DELIVER_ACTIVE"): e.pop(k, None)
            e.update(extra_env)
            p = _sp.run([_sys.executable, str(_ENF), "--operation","Write","--args",_json.dumps({"file_path":str(f)})], capture_output=True, text=True, env=e)
            return p.returncode, _json.loads(p.stdout) if p.stdout.strip() else {}

    def test_local_session_downgrades_to_advisory(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000"})
        self.assertEqual(rc, 0); self.assertTrue(out["allowed"])

    def test_local_advisory_off_keeps_block(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000","UAP_DELIVER_LOCAL_ADVISORY":"0"})
        self.assertEqual(rc, 2)

    def test_cloud_session_still_blocks(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"https://api.anthropic.com"})
        self.assertEqual(rc, 2)


class LocalModeTest(unittest.TestCase):
    def _run(self, env):
        with _tf.TemporaryDirectory() as td:
            root = _Path(td); (root/".git").mkdir()
            f = root/"src"/"a.ts"; f.parent.mkdir(parents=True); f.write_text("x")
            e = dict(_os.environ); e["UAP_REPO_ROOT"]=str(root)
            for k in ("ANTHROPIC_BASE_URL","UAP_DELIVER_LOCAL_ADVISORY","UAP_DELIVER_LOCAL_MODE","UAP_DELIVER_ACTIVE"): e.pop(k, None)
            e.update(env)
            p = _sp.run([_sys.executable, str(_ENF), "--operation","Write","--args",_json.dumps({"file_path":str(f)})], capture_output=True, text=True, env=e)
            return p.returncode, _json.loads(p.stdout) if p.stdout.strip() else {}

    def test_local_mode_deliver_routes_through_deliver(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000","UAP_DELIVER_LOCAL_MODE":"deliver"})
        self.assertEqual(rc, 2)
        self.assertEqual(out.get("route"), "deliver")

    def test_local_mode_advisory_allows(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000","UAP_DELIVER_LOCAL_MODE":"advisory"})
        self.assertEqual(rc, 0); self.assertTrue(out["allowed"])

    def test_local_mode_block_strict(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000","UAP_DELIVER_LOCAL_MODE":"block"})
        self.assertEqual(rc, 2)

    def test_default_is_advisory(self):
        rc, out = self._run({"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000"})
        self.assertEqual(rc, 0)
