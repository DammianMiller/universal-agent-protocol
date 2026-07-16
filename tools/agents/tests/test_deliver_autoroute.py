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
        self.assertFalse(d["replay"])  # no recorded content -> not replayable
        self.assertIsNotNone(d["intent"])
        self.assertEqual(d["intent"]["file_path"], "/repo/src/foo.ts")
        # autoroute off + no recorded content: message is annotated to tell the
        # agent to run deliver itself; the block reason is preserved as prefix.
        self.assertTrue(d["message"].startswith(BLOCK_OUT["reason"]))
        self.assertIn("apply it yourself", d["message"])

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


class AgentKeySpellingTest(unittest.TestCase):
    """autoroute must accept EVERY agent's file-path key.

    The enforcer was fixed for this long ago; autoroute was not — so for opencode
    (which sends `filePath`) file_path was always "", `spawn` was always False, and
    autoroute was INERT: the gate blocked the edit, logged the intent, told the
    model to call deliver… and deliver never ran. Observed live: 3 routed intents,
    0 deliver runs, 0 files changed — work blocked but never delivered. The old
    tests only ever passed snake_case, which is why this went unnoticed.
    """

    def test_opencode_filePath_spawns(self):
        d = mod.decide(BLOCK_OUT, "Write", {"filePath": "/repo/src/foo.ts"}, True, set())
        self.assertTrue(d["spawn"])
        self.assertEqual(d["dedup_key"], "/repo/src/foo.ts")

    def test_claude_file_path_still_spawns(self):
        d = mod.decide(BLOCK_OUT, "Write", {"file_path": "/repo/src/foo.ts"}, True, set())
        self.assertTrue(d["spawn"])

    def test_other_spellings(self):
        for key in ("path", "target", "filename", "file"):
            d = mod.decide(BLOCK_OUT, "Write", {key: "/repo/src/foo.ts"}, True, set())
            self.assertTrue(d["spawn"], key)


class BashRoutedIntentTest(unittest.TestCase):
    """A BASH-routed source-write carries a `command`, not a path — requiring
    file_path made that whole class unspawnable (blocked, then silently dropped).
    The hint is what deliver actually runs, so it is the correct spawn key."""

    def test_bash_intent_spawns_on_hint_alone(self):
        d = mod.decide(BLOCK_OUT, "Bash", {"command": "cat > src/app.js <<EOF"}, True, set())
        self.assertTrue(d["spawn"])
        self.assertEqual(d["file_path"], "")           # genuinely has no path
        self.assertEqual(d["dedup_key"], d["hint"])    # …so it dedups on the hint

    def test_bash_intent_dedupes_on_hint(self):
        d1 = mod.decide(BLOCK_OUT, "Bash", {"command": "cat > a.js <<EOF"}, True, set())
        d2 = mod.decide(BLOCK_OUT, "Bash", {"command": "cat > a.js <<EOF"}, True, {d1["dedup_key"]})
        self.assertTrue(d1["spawn"])
        self.assertFalse(d2["spawn"])  # no double-spawn for the same change

    def test_still_never_spawns_without_a_hint(self):
        d = mod.decide({"reason": "x", "route": "deliver"}, "Bash", {"command": "cat > a.js"}, True, set())
        self.assertFalse(d["spawn"])


class ReplayIntentTest(unittest.TestCase):
    """A REPLAYABLE intent (the blocked edit's exact content was recorded) must
    be applied DETERMINISTICALLY via `uap deliver --pending` — not re-routed
    through a fresh model deliver that just re-blocks. Without this the blocked
    write is recorded but never lands: the model re-emits it forever and 0 files
    change (octopus_invaders_v3, 2026-07-16 — every run frozen at phase 0)."""

    REPLAY_ARGS = {"file_path": "/repo/src/foo.ts", "content": "const X = 1;\n"}

    def test_content_intent_is_replayable_not_model_spawn(self):
        d = mod.decide(BLOCK_OUT, "Write", self.REPLAY_ARGS, True, set())
        self.assertTrue(d["replay"])
        self.assertFalse(d["spawn"])  # deterministic replay, not a model run
        self.assertIn("--pending", d["message"])
        self.assertEqual(d["intent"]["edit"]["content"], "const X = 1;\n")

    def test_replay_not_gated_on_autoroute(self):
        d = mod.decide(BLOCK_OUT, "Write", self.REPLAY_ARGS, False, set())
        self.assertTrue(d["replay"])  # safe deterministic path runs even when autoroute is off
        self.assertFalse(d["spawn"])

    def test_enforcer_editIntent_old_new_is_replayable(self):
        out = dict(BLOCK_OUT); out["editIntent"] = {"old_string": "a", "new_string": "b"}
        d = mod.decide(out, "Edit", {"file_path": "/repo/src/foo.ts"}, True, set())
        self.assertTrue(d["replay"])
        self.assertFalse(d["spawn"])

    def test_non_replayable_still_model_spawns(self):
        d = mod.decide(BLOCK_OUT, "Write", ARGS, True, set())  # no content recorded
        self.assertFalse(d["replay"])
        self.assertTrue(d["spawn"])


if __name__ == "__main__":
    unittest.main()
