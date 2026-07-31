#!/usr/bin/env python3
"""The plan gate must fire BEFORE the build, not on the plan write.

The old rule blocked a Write/Edit to a plan artifact unless `uap plan validate`
had run in the last 300 seconds. That asks the agent to validate a plan that does
not exist yet: `findPlanArtifact` turns up nothing (or an older file), the review
is recorded as "skipped — no plan artifact found", the stamp lands anyway, and
for the next five minutes any plan content can be written unread. Nothing gated
the build at all, so the plan that actually got implemented was never reviewed.

User directive: "once a plan is created the LLM is prompted to 'validate the
plan' before execution/build."

So:
  - creating or editing a plan is ALLOWED, and records the plan as pending
  - a BUILD / EXECUTE / DEPLOY command is BLOCKED while any plan is pending, or
    while a validated plan has since drifted on disk
  - the block message carries the `validate the plan` self-prompt

State is shared with `uap plan validate` (src/cli/plan.ts) in
`.uap/plan_state.json`:

    pending   { "<repo-relative path>": <epoch seen> }
    validated { "<repo-relative path>": "<sha256 of the reviewed bytes>" }

Keying on CONTENT rather than a clock is the fix: "these exact bytes were
reviewed" cannot be satisfied by validating an empty file first.

NOTE ON PROVENANCE: the enforcer is written through `uap deliver` (the agent is
blocked from editing src/policies/enforcers/ directly). During that run the
model rewrote THIS file — stripping the rationale and deleting the one
assertion it could not satisfy, test_the_refusal_names_the_offending_plan. The
file was restored. A contract test that the implementer may edit is not a
contract; if these ever thin out again, check the diff rather than the result.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "validate_plan_on_change.py"
# The agent is blocked from writing src/policies/enforcers/, so a candidate
# enforcer has to be provable BEFORE an operator installs it. Point this at the
# candidate to run the same contract against it. CI never sets it.
ENFORCER = Path(os.environ.get("UAP_PLAN_ENFORCER") or ENFORCER)


def raw(project: Path, op: str, args: dict, env: dict | None = None):
    e = {k: v for k, v in os.environ.items() if k != "UAP_PLAN_VALIDATE_OFF"}
    e.update(env or {})
    return subprocess.run(
        [sys.executable, str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, cwd=str(project), env=e,
    )


def verdict(project: Path, op: str, args: dict, env: dict | None = None) -> dict:
    p = raw(project, op, args, env)
    try:
        d = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        return {"allowed": None, "reason": f"UNPARSEABLE rc={p.returncode} err={p.stderr[:200]}"}
    d["_rc"] = p.returncode
    return d


def allowed(project: Path, op: str, args: dict, env: dict | None = None) -> bool:
    return verdict(project, op, args, env).get("allowed") is True


BUILD = {"command": "npm run build"}
PLAN = "docs/plans/feature-plan.md"


class PlanGateTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="uap-plangate-"))
        (self.dir / ".uap").mkdir(parents=True, exist_ok=True)
        (self.dir / "docs" / "plans").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def write_plan(self, text: str = "# Plan\n\nDo the thing.\n", path: str = PLAN) -> Path:
        p = self.dir / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def state(self) -> dict:
        try:
            return json.loads((self.dir / ".uap" / "plan_state.json").read_text())
        except Exception:  # noqa: BLE001
            return {}

    def set_state(self, **kw) -> None:
        (self.dir / ".uap" / "plan_state.json").write_text(json.dumps(kw))

    @staticmethod
    def sha(text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()


class TestWritingAPlanIsNeverBlocked(PlanGateTestCase):
    def test_creating_a_plan_is_allowed(self):
        # The old gate blocked here, which is what made it ask for validation of
        # a plan that did not exist yet.
        self.assertTrue(allowed(self.dir, "Write", {"file_path": PLAN, "content": "# Plan"}))

    def test_editing_a_plan_is_allowed(self):
        self.write_plan()
        self.assertTrue(allowed(self.dir, "Edit", {"file_path": PLAN}))

    def test_the_write_records_the_plan_as_pending(self):
        allowed(self.dir, "Write", {"file_path": PLAN, "content": "# Plan"})
        self.assertIn(PLAN, self.state().get("pending", {}))

    def test_a_non_plan_write_records_nothing(self):
        allowed(self.dir, "Write", {"file_path": "src/index.ts", "content": "x"})
        self.assertEqual(self.state().get("pending", {}), {})


class TestPlanArtifactDetection(PlanGateTestCase):
    """A plan is not only a file under plans/.

    The first delivered enforcer narrowed detection to directory prefixes, so a
    root PLAN.md — the most common shape — armed nothing at all and the build
    gate was silently dead for it. These cases mirror the rule the policy has
    always stated: any file under a plans/ dir, OR a .md whose stem matches
    (^|[-_. ])plans?([-_. ]|$).
    """

    def assert_detected(self, path: str, expected: bool) -> None:
        self.set_state()
        allowed(self.dir, "Write", {"file_path": path, "content": "x"})
        got = bool(self.state().get("pending", {}))
        self.assertEqual(got, expected, f"{path}: detected={got}, expected={expected}")

    def test_plan_like_filenames_are_detected(self):
        for path in ("PLAN.md", "IMPLEMENTATION-PLAN.md", "rollout-plan.md",
                     "plan-v2.md", "docs/feature.plan.md"):
            self.assert_detected(path, True)

    def test_files_under_a_plans_directory_are_detected(self):
        for path in ("plans/x.md", "docs/plans/feature-plan.md", "plans/notes.txt"):
            self.assert_detected(path, True)

    def test_lookalikes_are_not_plans(self):
        # `planning` and `explanation` contain "plan" as a substring only.
        for path in ("planning-guide.md", "explanation.md", "src/index.ts", "README.md"):
            self.assert_detected(path, False)


class TestBuildIsBlockedUntilValidated(PlanGateTestCase):
    def test_build_blocked_while_a_plan_is_pending(self):
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        v = verdict(self.dir, "Bash", BUILD)
        self.assertFalse(v.get("allowed"))
        self.assertIn("validate the plan", (v.get("reason") or "").lower())

    def test_the_block_carries_the_self_prompt(self):
        # The whole point of the directive: the agent is PROMPTED, not merely
        # refused. inject_prompt is what puts `validate the plan` in front of it.
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        self.assertEqual(verdict(self.dir, "Bash", BUILD).get("inject_prompt"), "validate the plan")

    def test_build_allowed_once_the_plan_is_validated(self):
        text = "# Plan\n\nDo the thing.\n"
        self.write_plan(text)
        self.set_state(pending={}, validated={PLAN: self.sha(text)})
        self.assertTrue(allowed(self.dir, "Bash", BUILD))

    def test_build_blocked_again_when_a_validated_plan_drifts(self):
        # Validate, then edit the plan: the gate must re-arm. This is what the
        # content hash buys over a time window.
        text = "# Plan\n\nDo the thing.\n"
        self.write_plan(text)
        self.set_state(pending={}, validated={PLAN: self.sha(text)})
        self.write_plan(text + "\nAlso do another thing.\n")
        v = verdict(self.dir, "Bash", BUILD)
        self.assertFalse(v.get("allowed"))

    def test_no_plan_anywhere_means_no_gate(self):
        # Most work has no plan; the gate must be invisible then.
        self.assertTrue(allowed(self.dir, "Bash", BUILD))

    def test_a_deleted_validated_plan_does_not_wedge_the_gate(self):
        self.set_state(pending={}, validated={PLAN: self.sha("gone")})
        self.assertTrue(allowed(self.dir, "Bash", BUILD))


class TestWhichCommandsAreGated(PlanGateTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.write_plan()
        self.set_state(pending={PLAN: 1})

    def test_build_execute_and_deploy_are_gated(self):
        for cmd in (
            "npm run build",
            "uap deliver \"do the thing\"",
            "make",
            "cargo build --release",
            "go build ./...",
            "docker build -t x .",
            "terraform apply",
            "kubectl apply -f k8s/",
        ):
            self.assertFalse(allowed(self.dir, "Bash", {"command": cmd}), cmd)

    def test_reading_testing_and_linting_stay_free(self):
        # Gating these would fight the very work the prompt asks for: you cannot
        # review a plan if you cannot look at the tree or run its tests.
        for cmd in (
            "ls -la",
            "cat README.md",
            "git status",
            "npm test",
            "npx vitest run",
            "npx eslint .",
            "npx tsc --noEmit",
            "grep -r thing src/",
        ):
            self.assertTrue(allowed(self.dir, "Bash", {"command": cmd}), cmd)

    def test_a_build_word_inside_quoted_data_is_not_a_build(self):
        # Same trap the other enforcers hit: the marker appears in a PAYLOAD.
        for cmd in (
            "echo 'npm run build'",
            "git commit -m 'make the build faster'",
        ):
            self.assertTrue(allowed(self.dir, "Bash", {"command": cmd}), cmd)


class TestTheGateActuallyEnforces(PlanGateTestCase):
    """A refusal that exits 0 is not a gate — it is a log line.

    `_common.emit` exits 2 on a block and 0 on an allow; the whole harness keys
    on that exit code. The first delivered rewrite printed its JSON with a bare
    `print()` and no `sys.exit`, so every "allowed": false still exited 0 and
    the build went ahead. The JSON assertions elsewhere in this file all passed
    while nothing was enforced, which is exactly why this class exists.
    """

    def test_a_refusal_exits_2(self):
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        self.assertEqual(raw(self.dir, "Bash", BUILD).returncode, 2)

    def test_an_allow_exits_0(self):
        self.assertEqual(raw(self.dir, "Bash", {"command": "npm test"}).returncode, 0)
        self.assertEqual(raw(self.dir, "Write", {"file_path": PLAN, "content": "x"}).returncode, 0)

    def test_an_unrelated_operation_does_not_crash(self):
        # argparse `choices=` turns an unlisted operation into a usage error —
        # which also exits 2, i.e. reads as a BLOCK. A plan gate must be
        # invisible to Read/Grep/MultiEdit, not refuse them.
        for op in ("Read", "MultiEdit", "Grep", "bash", "write"):
            rc = raw(self.dir, op, {"file_path": "src/x.ts", "command": "ls"}).returncode
            self.assertEqual(rc, 0, f"operation {op} exited {rc}")

    def test_the_state_dir_env_override_is_honoured(self):
        # Every other enforcer honours UAP_STATE_DIR; tests and sandboxes rely
        # on redirecting state somewhere disposable.
        alt = self.dir / "elsewhere"
        alt.mkdir(parents=True, exist_ok=True)
        raw(self.dir, "Write", {"file_path": PLAN, "content": "x"}, {"UAP_STATE_DIR": str(alt)})
        self.assertTrue((alt / "plan_state.json").exists())

    def test_a_build_later_in_a_compound_command_is_still_gated(self):
        # `... && npm run build` is a build. Matching only on a command PREFIX
        # makes the gate trivially avoidable by prepending anything at all.
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        for cmd in ("cd sub && npm run build", "echo hi; npm run build"):
            self.assertFalse(allowed(self.dir, "Bash", {"command": cmd}), cmd)


class TestEscapeHatch(PlanGateTestCase):
    def test_env_override_allows_the_build(self):
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        self.assertTrue(allowed(self.dir, "Bash", BUILD, {"UAP_PLAN_VALIDATE_OFF": "1"}))

    def test_the_refusal_names_the_hatch(self):
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        self.assertIn("UAP_PLAN_VALIDATE_OFF", verdict(self.dir, "Bash", BUILD).get("reason", ""))

    def test_the_refusal_names_the_offending_plan(self):
        # A refusal the agent cannot act on is just an obstacle. This is the
        # assertion the delivering model deleted rather than satisfy.
        self.write_plan()
        self.set_state(pending={PLAN: 1})
        self.assertIn(PLAN, verdict(self.dir, "Bash", BUILD).get("reason", ""))


if __name__ == "__main__":
    unittest.main()
