#!/usr/bin/env python3
"""Gate evidence must not be writable by the agent.

Both plan-time gates accept "a record exists" as proof a required action
happened. Those records used to sit where an agent could write them: a shell
append to .uap/read_log.state was allowed (self-protect keeps its Bash scan
deliberately permissive inside .uap/, which is mostly runtime state), and the
memory_query record was an ordinary row in a database the agent writes to
constantly. During development a gate was in fact satisfied by exactly such an
append.

Evidence now lives in .uap/evidence/, listed in self-protect's
PROTECTED_TARGETS. Written only by the PostToolUse hook and the CLI — neither
is an agent tool call, so neither is intercepted.

This is not cryptographic and does not claim to be: forging evidence now costs
the same as defeating self-protect for any other purpose, rather than one echo.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ENFORCERS = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers"
SELF_PROTECT = ENFORCERS / "enforcement_self_protect.py"
READ_GATE = ENFORCERS / "codebase_read_before_plan.py"
MEM_GATE = ENFORCERS / "memory_before_plan.py"
GT = chr(62)


def run_enforcer(enforcer, op, args, root):
    env = dict(os.environ)
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    env["PYTHONPATH"] = str(ENFORCERS)
    env.pop("UAP_SELF_PROTECT_OFF", None)
    p = subprocess.run(
        [sys.executable, str(enforcer), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=env, cwd=str(root),
    )
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"allowed": True, "reason": f"<unparseable {p.stdout!r} {p.stderr!r}>"}


class TestEvidenceIsNotAgentWritable(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".uap" / "evidence").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _bash_blocked(self, cmd, label):
        out = run_enforcer(SELF_PROTECT, "Bash", {"command": cmd}, self.root)
        self.assertFalse(out.get("allowed"), f"{label}: {cmd!r} should be refused")

    def test_shell_append_to_evidence_is_refused(self):
        # The exact forgery that worked before.
        self._bash_blocked("echo hi " + GT * 2 + " .uap/evidence/reads.log", "append")
        self._bash_blocked(
            "echo hi " + GT * 2 + " .uap/evidence/memory-queries.log", "append")

    def test_other_writes_into_evidence_are_refused(self):
        self._bash_blocked("echo hi | tee .uap/evidence/reads.log", "tee")
        self._bash_blocked("cp /etc/hostname .uap/evidence/reads.log", "cp")
        self._bash_blocked("rm -f .uap/evidence/reads.log", "rm")

    def test_write_tool_into_evidence_is_refused(self):
        out = run_enforcer(
            SELF_PROTECT, "Write",
            {"file_path": str(self.root / ".uap/evidence/reads.log")}, self.root)
        self.assertFalse(out.get("allowed"), "Write into evidence should be refused")

    def test_ordinary_uap_runtime_writes_still_work(self):
        # The rest of .uap/ is runtime state the tooling writes constantly.
        # Over-blocking it would break the project's own plumbing — the reason
        # that scan was narrow to begin with.
        for cmd in ["echo 0 " + GT + " .uap/verify-cadence",
                    "echo x " + GT * 2 + " .uap/pending-deliver.jsonl"]:
            out = run_enforcer(SELF_PROTECT, "Bash", {"command": cmd}, self.root)
            self.assertTrue(out.get("allowed"), f"{cmd!r} must stay allowed")


class TestGatesReadProtectedEvidence(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".uap" / "evidence").mkdir(parents=True)
        # Writer hook present, so the read gate enforces instead of degrading
        # to advisory.
        hooks = self.root / ".claude" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "post-tool-use-read.sh").write_text("#!/bin/sh\n")

    def tearDown(self):
        self._tmp.cleanup()

    def _evidence(self, kind, age=0, detail="src/x.ts"):
        path = self.root / ".uap" / "evidence" / f"{kind}.log"
        with path.open("a") as f:
            f.write(f"{int(time.time()) - age}\t{detail}\n")

    def test_read_gate_accepts_fresh_evidence_and_blocks_without(self):
        out = run_enforcer(READ_GATE, "ExitPlanMode", {}, self.root)
        self.assertFalse(out.get("allowed"), "no evidence -> blocked")

        self._evidence("reads")
        out = run_enforcer(READ_GATE, "ExitPlanMode", {}, self.root)
        self.assertTrue(out.get("allowed"), out.get("reason"))
        self.assertIn("evidence", out.get("reason", ""))

    def test_read_gate_still_blocks_on_stale_evidence(self):
        self._evidence("reads", age=4000)      # past the 30-minute window
        out = run_enforcer(READ_GATE, "ExitPlanMode", {}, self.root)
        self.assertFalse(out.get("allowed"), "stale evidence must not satisfy the gate")

    def test_memory_gate_accepts_fresh_evidence_and_blocks_without(self):
        out = run_enforcer(MEM_GATE, "ExitPlanMode", {}, self.root)
        self.assertFalse(out.get("allowed"), "no evidence -> blocked")

        self._evidence("memory-queries", detail="a topic")
        out = run_enforcer(MEM_GATE, "ExitPlanMode", {}, self.root)
        self.assertTrue(out.get("allowed"), out.get("reason"))
        self.assertIn("evidence", out.get("reason", ""))

    def test_memory_gate_still_blocks_on_stale_evidence(self):
        self._evidence("memory-queries", age=1000, detail="old")   # past 300s
        out = run_enforcer(MEM_GATE, "ExitPlanMode", {}, self.root)
        self.assertFalse(out.get("allowed"), "stale evidence must not satisfy the gate")


if __name__ == "__main__":
    unittest.main()
