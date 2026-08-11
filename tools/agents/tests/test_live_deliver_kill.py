#!/usr/bin/env python3
"""Killing a RUNNING deliver run is the blocker, not planning.

Measured 2026-08-11: three consecutive runs reached turn 3, turn 8 and turn 10
and every one was terminated from outside. The proxy journal caught the shape —
a kill of the run's own pid, followed by a cooperative stop request, five
minutes after launch. Both halves are the caller trying to stop a run; only the
second keeps the work. The first drops the turn in flight with the lock still
held, and it is why "deliver never gets past planning" was believed while the
runs were in fact working.

The rule has to be NARROW: killing anything else stays allowed, because a
blanket refusal on `kill` would block ordinary process cleanup for no gain.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "enforcement_self_protect.py"
    spec = importlib.util.spec_from_file_location("esp", p)
    assert spec and spec.loader
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


esp = _load()


class LiveRunFixture:
    """A real sleeping process, recorded as a running deliver run."""

    def __init__(self, root: Path, run_id: str = "run-20260811T091247-84d1f1", pid: int | None = None):
        self.root = root
        self.run_id = run_id
        self.proc = None
        if pid is None:
            # argv must contain "deliver" — the rule verifies against /proc so a
            # recycled pid cannot be mistaken for a run.
            self.proc = subprocess.Popen(
                [sys.executable, "-c", "import time,sys; sys.argv.append('deliver'); time.sleep(30)", "deliver"]
            )
            pid = self.proc.pid
        self.pid = pid
        d = root / ".uap" / "deliver-runs" / run_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "state.json").write_text(json.dumps({
            "runId": run_id, "instruction": "replace the lateral joins",
            "presetId": "p", "projectRoot": str(root), "status": "running",
            "createdAt": "2026-08-11T09:12:47Z", "updatedAt": "2026-08-11T09:15:00Z",
            "pid": self.pid,
        }))

    def close(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait()


class KillsLiveDeliverRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fx = LiveRunFixture(self.root)

    def tearDown(self):
        self.fx.close()
        self.tmp.cleanup()

    def test_refuses_the_exact_command_from_the_journal(self):
        cmd = f"kill {self.fx.pid} 2>/dev/null; touch {self.root}/.uap/deliver-runs/STOP"
        self.assertEqual(esp._kills_live_deliver_run(cmd, self.root), self.fx.run_id)

    def test_refuses_kill_9_and_explicit_signals(self):
        for cmd in (f"kill -9 {self.fx.pid}", f"kill -TERM {self.fx.pid}", f"kill -15 {self.fx.pid}"):
            self.assertTrue(esp._kills_live_deliver_run(cmd, self.root), cmd)

    def test_ALLOWS_kill_0_because_that_is_a_liveness_PROBE(self):
        # Refusing this would break the very check that tells a caller whether
        # the run is still alive — and push it back toward killing blindly.
        self.assertEqual(esp._kills_live_deliver_run(f"kill -0 {self.fx.pid}", self.root), "")

    def test_ALLOWS_killing_an_unrelated_process(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.assertEqual(esp._kills_live_deliver_run(f"kill {other.pid}", self.root), "")
        finally:
            other.kill()
            other.wait()

    def test_refuses_a_pattern_kill_that_would_match_the_run(self):
        self.assertTrue(esp._kills_live_deliver_run("pkill -f deliver", self.root))

    def test_ALLOWS_a_pattern_kill_that_matches_nothing_of_ours(self):
        self.assertEqual(esp._kills_live_deliver_run("pkill -f 'http.server 8765'", self.root), "")

    def test_a_recycled_pid_is_not_treated_as_a_live_run(self):
        # The PID-reuse trap that once deadlocked the deliver lock: the record
        # says running, but the process at that pid is something else entirely.
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            fx = LiveRunFixture(self.root, run_id="run-stale-aaaaaa", pid=other.pid)
            self.assertEqual(esp._kills_live_deliver_run(f"kill {other.pid}", self.root), "")
        finally:
            other.kill()
            other.wait()

    def test_a_dead_pid_is_not_a_live_run(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        time.sleep(0.05)
        LiveRunFixture(self.root, run_id="run-dead-bbbbbb", pid=dead.pid)
        self.assertEqual(esp._kills_live_deliver_run(f"kill {dead.pid}", self.root), "")

    def test_a_FINISHED_run_is_not_protected_even_if_its_process_lingers(self):
        # Only a run that is still RUNNING has work to lose. One marked
        # delivered or failed has finished; its process may be winding down, and
        # refusing to kill that would block ordinary cleanup for no benefit.
        for status in ("delivered", "failed", "interrupted"):
            d = self.root / ".uap" / "deliver-runs" / self.fx.run_id
            data = json.loads((d / "state.json").read_text())
            data["status"] = status
            (d / "state.json").write_text(json.dumps(data))
            self.assertEqual(
                esp._kills_live_deliver_run(f"kill {self.fx.pid}", self.root), "", status
            )

    def test_a_run_that_already_recorded_an_exit_is_not_live(self):
        d = self.root / ".uap" / "deliver-runs" / self.fx.run_id
        data = json.loads((d / "state.json").read_text())
        data["exit"] = {"at": "2026-08-11T09:18:10Z", "reason": "killed by SIGTERM"}
        (d / "state.json").write_text(json.dumps(data))
        self.assertEqual(esp._kills_live_deliver_run(f"kill {self.fx.pid}", self.root), "")

    def test_costs_nothing_when_the_command_is_not_a_kill(self):
        self.assertEqual(esp._kills_live_deliver_run("uap deliver --await-run", self.root), "")
        self.assertEqual(esp._kills_live_deliver_run("", self.root), "")

    def test_survives_a_project_with_no_runs_at_all(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(esp._kills_live_deliver_run("kill 1", Path(empty)), "")

    def test_survives_unreadable_run_state(self):
        (self.root / ".uap" / "deliver-runs" / "run-junk-cccccc").mkdir(parents=True)
        (self.root / ".uap" / "deliver-runs" / "run-junk-cccccc" / "state.json").write_text("{not json")
        self.assertEqual(esp._kills_live_deliver_run(f"kill {self.fx.pid}", self.root), self.fx.run_id)


class RefusalIsActionable(unittest.TestCase):
    """A refusal that does not name the alternative is how a loop survives a guard."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fx = LiveRunFixture(self.root)

    def tearDown(self):
        self.fx.close()
        self.tmp.cleanup()

    def test_the_enforcer_refuses_end_to_end_and_names_the_cooperative_stop(self):
        env = dict(os.environ)
        env.pop("UAP_SELF_PROTECT_OFF", None)
        env["CLAUDE_PROJECT_DIR"] = str(self.root)
        enforcer = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "enforcement_self_protect.py"
        r = subprocess.run(
            [sys.executable, str(enforcer), "--operation", "Bash",
             "--args", json.dumps({"command": f"kill {self.fx.pid} 2>/dev/null"})],
            capture_output=True, text=True, cwd=str(self.root), env=env)
        out = r.stdout + r.stderr
        self.assertIn("RUNNING", out, out[:400])
        self.assertIn("deliver-runs/STOP", out, out[:400])
        self.assertIn("--await-run", out, out[:400])


if __name__ == "__main__":
    unittest.main()
