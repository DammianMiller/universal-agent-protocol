"""Tests for deliver-autoroute (R1 follow-up): consume route:deliver."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[3] / "templates" / "hooks" / "deliver_autoroute.py"
spec = importlib.util.spec_from_file_location("deliver_autoroute", HELPER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

BLOCK_OUT = {
    "allowed": False,
    "reason": "BLOCKED: do not edit src/foo.ts directly.",
    "route": "deliver",
    "deliverHint": 'uap deliver "implement the intended change to src/foo.ts"',
}
ARGS = {"file_path": "/repo/src/foo.ts"}


class DecideTest(unittest.TestCase):
    def test_non_deliver_route_is_passthrough(self):
        d = mod.decide({"reason": "blocked", "route": "worktree"}, "Write", ARGS, True, set())
        self.assertFalse(d["spawn"])
        self.assertIsNone(d["intent"])
        self.assertEqual(d["message"], "blocked")

    def test_deliver_route_logs_intent_no_spawn_when_off(self):
        d = mod.decide(BLOCK_OUT, "Write", ARGS, False, set())
        self.assertFalse(d["spawn"])
        self.assertIsNotNone(d["intent"])
        self.assertEqual(d["intent"]["file_path"], "/repo/src/foo.ts")
        self.assertEqual(d["message"], BLOCK_OUT["reason"])  # unchanged

    def test_deliver_route_spawns_when_on_and_unseen(self):
        d = mod.decide(BLOCK_OUT, "Write", ARGS, True, set())
        self.assertTrue(d["spawn"])
        self.assertIn("auto-routed", d["message"])

    def test_deliver_route_dedupes_seen_file(self):
        d = mod.decide(BLOCK_OUT, "Write", ARGS, True, {"/repo/src/foo.ts"})
        self.assertFalse(d["spawn"])
        self.assertIn("already auto-routed", d["message"])

    def test_no_spawn_without_hint(self):
        out = dict(BLOCK_OUT); out["deliverHint"] = ""
        d = mod.decide(out, "Write", ARGS, True, set())
        self.assertFalse(d["spawn"])


class LoggingTest(unittest.TestCase):
    def test_main_logs_pending_intent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # invoke main() via subprocess to exercise the full path (autoroute off)
            import subprocess, sys
            env = dict(os.environ); env.pop("UAP_DELIVER_AUTOROUTE", None)
            p = subprocess.run(
                [sys.executable, str(HELPER), "--tool", "Write",
                 "--args", json.dumps(ARGS), "--root", str(root), "--policy", "delivery-enforcement"],
                input=json.dumps(BLOCK_OUT), capture_output=True, text=True, env=env,
            )
            self.assertIn("BLOCKED", p.stdout)
            log = root / ".uap" / "pending-deliver.jsonl"
            self.assertTrue(log.exists(), "intent must be logged")
            rec = json.loads(log.read_text().strip())
            self.assertEqual(rec["file_path"], "/repo/src/foo.ts")


if __name__ == "__main__":
    unittest.main()
