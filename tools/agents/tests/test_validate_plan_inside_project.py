"""validate-plan-on-change: only track what `uap plan validate` can validate.

The enforcer recorded ANY plan-named file it saw written, including paths
outside the project. `uap plan validate` refuses those ("explicit plan file must
live under the project directory"), so the entry could never be cleared: every
build in the repo blocked, and the remedy the refusal named declined the file.
Observed live with a memory note at
~/.claude/projects/<slug>/memory/plan_gate_before_build.md — not a plan at all,
matched only because its filename contains "plan".

The rename case is the one to guard hardest. `mv PLAN.md PLAN2.md` is not an
edit op, so no new pending entry is recorded; auto-forgiving the old key on the
build path would make a rename a silent, unattended gate bypass with the plan
content fully intact. An earlier draft of this change did exactly that.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "validate_plan_on_change.py"


def run(cwd: str, op: str, args: dict) -> str:
    proc = subprocess.run(
        [sys.executable, str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    return proc.stdout + proc.stderr


def state(cwd: str) -> dict:
    path = Path(cwd) / ".uap" / "plan_state.json"
    return json.loads(path.read_text()) if path.exists() else {}


class TestPlanGateTracksOnlyProjectFiles(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.cwd = self._tmp.name
        os.makedirs(os.path.join(self.cwd, "docs", "plans"), exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_outside_project_plan_is_not_tracked(self) -> None:
        out = run(self.cwd, "Write", {"file_path": "/tmp/elsewhere/stray-plan.md"})
        self.assertIn("outside the project", out)
        self.assertEqual(state(self.cwd).get("pending", {}), {})

    def test_in_project_plan_is_still_tracked(self) -> None:
        Path(self.cwd, "docs", "plans", "real-plan.md").write_text("# real")
        run(self.cwd, "Write", {"file_path": "docs/plans/real-plan.md"})
        self.assertIn("docs/plans/real-plan.md", state(self.cwd).get("pending", {}))

    def test_build_is_blocked_and_names_the_recovery_command(self) -> None:
        Path(self.cwd, "docs", "plans", "real-plan.md").write_text("# real")
        run(self.cwd, "Write", {"file_path": "docs/plans/real-plan.md"})
        out = run(self.cwd, "Bash", {"command": "npm run build"})
        self.assertIn("never validated", out)
        # A wedged agent must not be sent to the one command that declines the file.
        self.assertIn("uap plan clear", out)

    def test_renaming_a_pending_plan_does_not_forgive_it(self) -> None:
        plan = Path(self.cwd, "docs", "plans", "real-plan.md")
        plan.write_text("# real")
        run(self.cwd, "Write", {"file_path": "docs/plans/real-plan.md"})
        plan.rename(Path(self.cwd, "docs", "plans", "real-plan-v2.md"))

        out = run(self.cwd, "Bash", {"command": "npm run build"})
        self.assertIn("never validated", out)
        self.assertIn("docs/plans/real-plan.md", state(self.cwd).get("pending", {}))

    def test_legacy_outside_entry_is_pruned_and_audited(self) -> None:
        Path(self.cwd, "docs", "plans", "real-plan.md").write_text("# real")
        run(self.cwd, "Write", {"file_path": "docs/plans/real-plan.md"})
        st = state(self.cwd)
        st.setdefault("pending", {})["/home/somewhere/legacy-plan.md"] = 1
        Path(self.cwd, ".uap", "plan_state.json").write_text(json.dumps(st))

        run(self.cwd, "Bash", {"command": "npm run build"})
        st = state(self.cwd)
        self.assertNotIn("/home/somewhere/legacy-plan.md", st.get("pending", {}))
        # The in-project plan still gates the build.
        self.assertIn("docs/plans/real-plan.md", st.get("pending", {}))
        # A shrinking blocking set must leave a trail.
        cleared = st.get("cleared", [])
        self.assertEqual(len(cleared), 1)
        self.assertEqual(cleared[0]["key"], "/home/somewhere/legacy-plan.md")
        self.assertIn("outside the project", cleared[0]["reason"])

    def test_non_plan_writes_are_untouched(self) -> None:
        out = run(self.cwd, "Write", {"file_path": "src/index.ts"})
        self.assertIn("not a plan artifact", out)
        self.assertEqual(state(self.cwd).get("pending", {}), {})


if __name__ == "__main__":
    unittest.main()
