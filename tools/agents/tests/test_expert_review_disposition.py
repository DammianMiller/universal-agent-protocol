#!/usr/bin/env python3
"""expert-review-required: verdict disposition, carry-forward, findings.

Uplift 0.4 tightened three holes the PR-review line had:

  - the `verdict` field was recorded but never gate-parsed, so an artifact
    carrying "reject" still satisfied the existence check;
  - a stale review could be hand-carried across a new HEAD by editing `head`
    with a prose note — invisible and unbounded (observed 2026-11-24 on PR
    #960's version-merge commit);
  - the consolidated findings lived in chat, so "which findings were useful"
    was never recorded where the floor could ratchet on it.

These tests pin the three gate behaviours: only an approving verdict ships; a
carry-forward survives exactly the bounded low-risk delta class; no
blocker-severity finding may be open when the findings ride in the artifact.

Harness: a throwaway git repo per test (see test_enforcer_escape_hatches.py's
docstring for why the fixture must not be the checkout the suite runs in),
subprocess the enforcer, and assert on its JSON verdict. The ship command is
never executed — the gate only reads it.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = (
    Path(__file__).resolve().parents[3]
    / "src" / "policies" / "enforcers" / "expert_review_required.py"
)

BRANCH = "feature/disposition-fixture"
SHIP = "git " + "push"  # assembled: a literal ships this file's own test run


def _slug(branch):
    return branch.replace("%", "%25").replace("/", "%2F")


class DispositionGateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "repo"
        self.root.mkdir()
        self._git("init", "-q", "-b", BRANCH, ".")
        self._git("config", "user.email", "t@t")
        self._git("config", "user.name", "t")
        # A high-risk file so nothing low-risk can wave the diff through.
        (self.root / "src" / "policies").mkdir(parents=True)
        (self.root / "src" / "policies" / "x.py").write_text("x = 1\n")
        self._git("add", "-A")
        self._git("commit", "-qm", "init")
        self.reviews = self.root / ".uap" / "reviews"
        self.reviews.mkdir(parents=True)
        self.head = self._sha()

    def tearDown(self):
        self._tmp.cleanup()

    # --- fixture helpers -----------------------------------------------------

    def _git(self, *args):
        env = dict(os.environ)
        for v in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            env.pop(v, None)
        subprocess.run(["git", *args], cwd=self.root, capture_output=True,
                       text=True, env=env, check=True)

    def _sha(self):
        p = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root,
                           capture_output=True, text=True, check=True)
        return p.stdout.strip()

    def _commit(self, rel, text):
        target = self.root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self._git("add", "-A")
        self._git("commit", "-qm", f"add {rel}")
        self.head = self._sha()

    def _write_review(self, *, verdict=None, head=None, carry=None,
                      findings=None, reason=None):
        artifact = {
            "branch": BRANCH,
            "head": head or self.head,
            "reviewers": ["code-quality-reviewer"],
        }
        if verdict is not None:
            artifact["verdict"] = verdict
        if reason is not None:
            artifact["reason"] = reason
        if carry is not None:
            artifact["carry_forward"] = carry
        if findings is not None:
            artifact["findings"] = findings
        (self.reviews / f"{_slug(BRANCH)}.json").write_text(json.dumps(artifact))

    def _run(self, command=SHIP):
        env = dict(os.environ)
        env["UAP_REPO_ROOT"] = str(self.root)
        env["UAP_WORKTREE_ROOT"] = str(self.root)
        env.pop("UAP_NO_REVIEW", None)
        p = subprocess.run(
            [sys.executable, str(ENFORCER), "--operation", "Bash",
             "--args", json.dumps({"command": command})],
            capture_output=True, text=True, env=env, cwd=str(self.root),
        )
        try:
            out = json.loads(p.stdout)
        except json.JSONDecodeError:
            out = {"allowed": None, "reason": f"<unparseable {p.stdout!r} {p.stderr!r}>"}
        return out

    # --- verdict disposition -------------------------------------------------

    def test_verdict_missing_blocks(self):
        self._write_review()  # head matches, no verdict on record
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("verdict", out.get("reason", ""))

    def test_verdict_reject_blocks_and_surfaces_reason(self):
        self._write_review(verdict="reject", reason="2 blockers remain")
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("2 blockers remain", out.get("reason", ""))

    def test_verdict_approve_ships(self):
        self._write_review(verdict="approve")
        out = self._run()
        self.assertTrue(out.get("allowed"), out.get("reason"))

    def test_stale_head_without_carry_blocks(self):
        reviewed = self.head
        self._commit("docs/note.md", "more docs\n")
        self._write_review(verdict="approve", head=reviewed)
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("stale", out.get("reason", ""))

    # --- carry-forward bounds -------------------------------------------------

    def test_carry_forward_low_risk_delta_ships(self):
        reviewed = self.head
        self._commit("package.json", '{"version": "1.0.0"}\n')  # version-bump class
        self._commit("docs/notes.md", "doc change\n")
        self._write_review(
            verdict="approve",
            carry={"since_head": reviewed,
                   "justification": "version-line merge after master re-merge"},
        )
        out = self._run()
        self.assertTrue(out.get("allowed"), out.get("reason"))
        self.assertIn(f"carried from {reviewed[:8]}", out.get("reason", ""))

    def test_carry_forward_policy_delta_blocks(self):
        reviewed = self.head
        self._commit("src/policies/y.py", "y = 2\n")  # high-risk: policy code
        self._write_review(
            verdict="approve",
            carry={"since_head": reviewed, "justification": "policy tweak"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("carry-forward", out.get("reason", ""))
        self.assertIn("non-low-risk", out.get("reason", ""))

    def test_carry_forward_non_ancestor_blocks(self):
        self._write_review(
            verdict="approve",
            carry={"since_head": "1234567890" + "a" * 30,  # not a real ancestor
                   "justification": "fabricated base"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("ancestor", out.get("reason", ""))

    def test_carry_forward_too_many_hops_blocks(self):
        reviewed = self.head
        for i in range(4):  # max is 3
            self._commit(f"docs/n{i}.md", f"doc {i}\n")
        self._write_review(
            verdict="approve",
            carry={"since_head": reviewed, "justification": "four hops"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("max 3", out.get("reason", ""))

    def test_carry_forward_without_justification_blocks(self):
        reviewed = self.head
        self._commit("docs/n.md", "doc\n")
        self._write_review(
            verdict="approve",
            carry={"since_head": reviewed, "justification": "  "},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("justification", out.get("reason", ""))

    def test_carry_forward_short_sha_blocks(self):
        # A partial/fabricated sha fails before any git call is spent on it.
        self._write_review(
            verdict="approve",
            carry={"since_head": "abc123", "justification": "hand-waved base"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("not a sha", out.get("reason", ""))

    def test_carry_forward_moving_ref_rejected(self):
        # A branch/ref would pin nothing — the carry must name the exact
        # reviewed commit, and a non-hex string never reaches git argv.
        self._write_review(
            verdict="approve",
            carry={"since_head": "origin/master", "justification": "moving ref"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("not a sha", out.get("reason", ""))

    def test_carry_forward_non_object_blocks(self):
        self._write_review(verdict="approve", carry="carry it over, it's fine")
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("not an object", out.get("reason", ""))

    def test_carry_forward_suffix_deny_blocks(self):
        # Not high-risk by pattern, but no low-risk extension either: the
        # default-deny branch of the classifier, not the HIGH_RISK_PATH_RE one.
        reviewed = self.head
        self._commit("src/bootstrap.zig", "const x = 1;\n")
        self._write_review(
            verdict="approve",
            carry={"since_head": reviewed, "justification": "new source file"},
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("non-low-risk", out.get("reason", ""))

    # --- findings discipline ---------------------------------------------------

    def test_findings_open_blocker_blocks(self):
        self._write_review(
            verdict="approve",
            findings=[{"reviewer": "test-coverage-reviewer", "severity": "blocker",
                       "location": "src/x.ts:12", "disposition": "open"}],
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("open blocker", out.get("reason", ""))

    def test_findings_resolved_blocker_ships(self):
        self._write_review(
            verdict="approve",
            findings=[{"reviewer": "test-coverage-reviewer", "severity": "blocker",
                       "location": "src/x.ts:12", "disposition": "resolved"}],
        )
        out = self._run()
        self.assertTrue(out.get("allowed"), out.get("reason"))

    def test_findings_blocker_without_disposition_defaults_open(self):
        # Absent disposition key must mean open — a blocker never silently clears.
        self._write_review(
            verdict="approve",
            findings=[{"reviewer": "test-coverage-reviewer", "severity": "blocker",
                       "location": "src/x.ts:12"}],
        )
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("open blocker", out.get("reason", ""))

    def test_findings_withdrawn_blocker_ships(self):
        self._write_review(
            verdict="approve",
            findings=[{"reviewer": "test-coverage-reviewer", "severity": "blocker",
                       "location": "src/x.ts:12", "disposition": "withdrawn"}],
        )
        out = self._run()
        self.assertTrue(out.get("allowed"), out.get("reason"))

    def test_findings_open_non_blocker_severity_ships(self):
        # Only blocker severity gates — an open concern or note is recorded, not blocking.
        self._write_review(
            verdict="approve",
            findings=[{"reviewer": "code-quality-reviewer", "severity": "concern",
                       "location": "src/y.ts:8", "disposition": "open"}],
        )
        out = self._run()
        self.assertTrue(out.get("allowed"), out.get("reason"))

    def test_findings_malformed_entry_fails_closed(self):
        # An artifact whose findings cannot be read is refused, not waved
        # through — the same posture as the verdict check.
        self._write_review(verdict="approve", findings=["see consolidation notes"])
        out = self._run()
        self.assertFalse(out.get("allowed"), out.get("reason"))
        self.assertIn("open blocker", out.get("reason", ""))
        self.assertIn("malformed entry", out.get("reason", ""))


if __name__ == "__main__":
    unittest.main()
