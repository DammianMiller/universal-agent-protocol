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
    # Every ambient input that can turn "block" into "allow" must be cleared,
    # or these tests assert the developer's shell rather than the enforcer.
    # ANTHROPIC_BASE_URL is the subtle one: delivery_enforcement downgrades
    # block -> advisory for a local-model session, so with a loopback base URL
    # exported (the normal shape of a local session here) the three
    # block-expecting tests below flip to allowed. CI has it unset, so this
    # fails only for developers — presenting as "behaviour drifted".
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS",
              "UAP_DELIVER_LOCAL_MODE", "UAP_DELIVER_LOCAL_ADVISORY",
              "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"):
        env.pop(k, None)
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
        # NOTE: .css is now SOURCE (web deliverables are gated) — use a genuinely
        # non-source file to keep this test's intent (non-source is not routed).
        self.assertTrue(run(".worktrees/001-x/docs/NOTES.md", self.root))

    def test_direct_source_still_blocked(self):
        self.assertFalse(run("src/game.js", self.root))

    def test_other_exemptions_intact(self):
        # Agent/enforcement infra stays exempt (routing the hooks that RUN the
        # gate is a bootstrap deadlock).
        self.assertTrue(run(".uap/state.js", self.root))
        self.assertTrue(run("test/helper.js", self.root))

    def test_scripts_no_longer_exempt(self):
        # TIGHTENED: scripts/ executes — it is code, so it must route through
        # deliver and be tested like any other source.
        self.assertFalse(run("scripts/build.js", self.root))

    def test_bypass_override_still_works(self):
        self.assertTrue(
            run(".worktrees/001-x/js/game.js", self.root, {"UAP_DELIVER_BYPASS": "1"})
        )


# NB: the `unittest.main()` entrypoint lives at the END of this file, not here.
# It used to sit at this point, above the two classes below, so running the file
# directly (`python3 tools/agents/tests/test_delivery_enforcement_worktree.py`)
# ran 7 tests and printed OK while `python -m unittest` ran 14 — the 7 it
# skipped being exactly LocalAdvisoryTest + LocalModeTest. Anyone verifying a
# change to those got a false green.


import os as _os, subprocess as _sp, sys as _sys, json as _json, tempfile as _tf
from pathlib import Path as _Path
_ENF = _Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"

class LocalAdvisoryTest(unittest.TestCase):
    def _run(self, extra_env):
        with _tf.TemporaryDirectory() as td:
            root = _Path(td); (root/".git").mkdir()
            f = root/"src"/"a.ts"; f.parent.mkdir(parents=True); f.write_text("x")
            e = dict(_os.environ); e["UAP_REPO_ROOT"]=str(root)
            # This test asserts the DEFAULT for a local session, so every input
            # that overrides that default has to be cleared:
            #  - UAP_DELIVER_BYPASS: run() already strips it. An agent shell
            #    commonly exports it, the enforcer then allows every write, and
            #    the block-expecting tests fail rc 0 != 2 — which reads as
            #    "behaviour drifted" rather than "your env leaked".
            #  - UAP_DELIVER_LOCAL_MODE: LocalModeTest._run already strips it;
            #    omitting it here was an inconsistency. Importing the proxy
            #    module (any test that does _load_proxy_module()) runs
            #    _load_proxy_env_file(), which loads .uap/proxy.env into the
            #    real os.environ — and that file sets UAP_DELIVER_LOCAL_MODE.
            #    So this test's result depended on whether a proxy-importing
            #    module ran before it in the same process.
            for k in ("ANTHROPIC_BASE_URL","UAP_DELIVER_LOCAL_ADVISORY","UAP_DELIVER_ACTIVE",
                      "UAP_DELIVER_BYPASS","UAP_DELIVER_LOCAL_MODE"): e.pop(k, None)
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
            # See the note in LocalAdvisoryTest._run — same ambient-bypass leak.
            for k in ("ANTHROPIC_BASE_URL","UAP_DELIVER_LOCAL_ADVISORY","UAP_DELIVER_LOCAL_MODE","UAP_DELIVER_ACTIVE","UAP_DELIVER_BYPASS"): e.pop(k, None)
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


if __name__ == "__main__":
    unittest.main()
