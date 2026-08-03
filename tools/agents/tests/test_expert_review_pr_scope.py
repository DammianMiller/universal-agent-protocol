#!/usr/bin/env python3
"""expert-review-required: a PR ship is scoped to the PR's branch.

`gh pr merge <N>` ships the branch of PR N, which is usually not the branch the
invoking shell is standing on. Keying the review off the LOCAL branch meant a
merge run from the main checkout looked for `.uap/reviews/master.json`, found a
stale artifact from an unrelated past session, and refused a PR whose own branch
was reviewed and approved (observed 2026-08-03 merging #645).

`gh` is stubbed on PATH, so these tests need no network or auth.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = (
    Path(__file__).resolve().parents[3]
    / "src" / "policies" / "enforcers" / "expert_review_required.py"
)

PR_NUMBER = "645"
VERB = "merge"
PR_BRANCH = "feature/160-plan-gate-writers"
PR_SHA = "dd5ce346281d720dff357d4a649d7389e65bfd61"
STALE_SHA = "2f1b660f" + "0" * 32


def _slug(branch):
    return branch.replace("%", "%25").replace("/", "%2F")


def _git(root, *args):
    env = dict(os.environ)
    for v in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(v, None)
    subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, env=env)


class TestExpertReviewPrScope(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.bin = base / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        self._write_stub_gh()
        self._init_repo()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_stub_gh(self, head_ref=PR_BRANCH, head_oid=PR_SHA, rc=0, per_ref=None):
        """Stub `gh pr view`. `per_ref` maps a PR reference -> (branch, sha), so
        a test can prove WHICH pull request the enforcer actually resolved."""
        gh = self.bin / "gh"
        gh.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys\n"
            f"if {rc} != 0:\n"
            f"    sys.exit({rc})\n"
            f"per_ref = {per_ref!r}\n"
            "argv = sys.argv[1:]\n"
            "if 'headRefName' in ' '.join(argv):\n"
            "    ref = argv[2] if len(argv) > 2 else ''\n"
            "    if per_ref and ref in per_ref:\n"
            "        b, o = per_ref[ref]\n"
            "    else:\n"
            f"        b, o = {head_ref!r}, {head_oid!r}\n"
            "    print(json.dumps({'headRefName': b, 'headRefOid': o}))\n"
            "    sys.exit(0)\n"
            "sys.exit(1)\n"
        )
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    def _init_repo(self):
        _git(self.root, "init", "-q", "-b", "master", ".")
        _git(self.root, "config", "user.email", "t@t")
        _git(self.root, "config", "user.name", "t")
        # A high-risk path, so the low-risk scope skip cannot mask the outcome.
        (self.root / "src" / "policies").mkdir(parents=True)
        (self.root / "src" / "policies" / "x.py").write_text("x = 1\n")
        _git(self.root, "add", "-A")
        _git(self.root, "commit", "-qm", "init")

        self.reviews = self.root / ".uap" / "reviews"
        self.reviews.mkdir(parents=True)

    def _write_review(self, branch, head, verdict="approve"):
        (self.reviews / f"{_slug(branch)}.json").write_text(
            json.dumps({"branch": branch, "head": head, "verdict": verdict,
                        "reviewers": ["code-quality-reviewer"]})
        )

    def _run(self, command):
        env = dict(os.environ)
        env["UAP_REPO_ROOT"] = str(self.root)
        env["UAP_WORKTREE_ROOT"] = str(self.root)
        env["PATH"] = f"{self.bin}{os.pathsep}" + env.get("PATH", "")
        env.pop("UAP_NO_REVIEW", None)
        p = subprocess.run(
            [sys.executable, str(ENFORCER), "--operation", "Bash",
             "--args", json.dumps({"command": command})],
            capture_output=True, text=True, env=env, cwd=str(self.root),
        )
        try:
            out = json.loads(p.stdout)
        except json.JSONDecodeError:
            out = {"allowed": True, "reason": f"<unparseable {p.stdout!r} {p.stderr!r}>"}
        return out, p.returncode

    # --- the regression -----------------------------------------------------

    def test_pr_merge_uses_the_prs_branch_not_the_current_one(self):
        self._write_review(PR_BRANCH, PR_SHA)
        # master carries a stale artifact from an unrelated session.
        self._write_review("master", STALE_SHA)

        out, code = self._run(f"gh pr merge {PR_NUMBER} --squash")
        self.assertTrue(out.get("allowed"), f"should ship on the PR's review: {out.get('reason')}")
        self.assertEqual(code, 0)
        self.assertIn(_slug(PR_BRANCH), out.get("reason", ""))

    def test_pr_merge_blocked_when_the_prs_own_review_is_missing(self):
        # An approved artifact for the CURRENT branch must not authorise a
        # different branch's PR — that would be the bug inverted.
        self._write_review("master", STALE_SHA)
        out, code = self._run(f"gh pr merge {PR_NUMBER} --squash")
        self.assertFalse(out.get("allowed"), "no review for the PR's branch")
        self.assertEqual(code, 2)
        self.assertIn(_slug(PR_BRANCH), out.get("reason", ""))

    def test_pr_merge_blocked_when_the_prs_review_is_stale(self):
        self._write_review(PR_BRANCH, "0" * 40)  # covers some other head
        out, code = self._run(f"gh pr merge {PR_NUMBER} --squash")
        self.assertFalse(out.get("allowed"), "stale review for the PR's branch")
        self.assertEqual(code, 2)

    # --- fallbacks ----------------------------------------------------------

    def test_falls_back_to_local_branch_when_gh_cannot_answer(self):
        # No gh, no network, wrong auth: resolution returns nothing and the
        # enforcer must behave exactly as before rather than fail open.
        self._write_stub_gh(rc=1)
        self._write_review("master", STALE_SHA)
        out, code = self._run(f"gh pr merge {PR_NUMBER} --squash")
        self.assertFalse(out.get("allowed"), "falls back to the local branch")
        self.assertEqual(code, 2)
        self.assertIn("master", out.get("reason", ""))

    def test_flags_before_the_pr_number_still_resolve(self):
        # `gh pr merge --squash 645` is the form most people type. A pattern
        # pinned to digits-right-after-the-verb missed it and fell back to the
        # local branch, silently reinstating the bug this resolution fixes.
        self._write_review(PR_BRANCH, PR_SHA)
        self._write_review("master", STALE_SHA)
        out, code = self._run("gh pr " + VERB + " --squash " + PR_NUMBER)
        self.assertTrue(out.get("allowed"), f"flags-first form: {out.get('reason')}")
        self.assertEqual(code, 0)
        self.assertIn(_slug(PR_BRANCH), out.get("reason", ""))

    def test_bare_pr_merge_uses_the_current_branch(self):
        # No PR named: the current branch IS the right thing to check.
        self._write_review("master", STALE_SHA)
        out, code = self._run("gh pr " + VERB)
        self.assertFalse(out.get("allowed"), "bare merge falls back to local branch")
        self.assertIn("master", out.get("reason", ""))

    def test_a_value_bearing_flag_does_not_become_the_pr_reference(self):
        # `gh pr merge -b 1 900` merges PR 900 with commit body "1". Taking the
        # first non-flag token read "1" as the PR, so an approved review for
        # PR 1 would authorise shipping the unreviewed PR 900 — the gate
        # approving a different target than the command ships.
        self._write_stub_gh(per_ref={
            "1": (PR_BRANCH, PR_SHA),                   # reviewed + approved
            "900": ("feature/unreviewed", "9" * 40),    # the real target
        })
        self._write_review(PR_BRANCH, PR_SHA)

        out, code = self._run("gh pr " + VERB + " -b 1 900")
        self.assertFalse(out.get("allowed"), "must judge PR 900, not the -b value")
        self.assertEqual(code, 2)
        self.assertIn("feature%2Funreviewed", out.get("reason", ""))

    def test_non_pr_ship_still_uses_the_current_branch(self):
        # `git push` from master is still judged against master.
        self._write_review("master", STALE_SHA)
        out, code = self._run("git push origin master")
        self.assertFalse(out.get("allowed"), "stale master review blocks a master push")
        self.assertEqual(code, 2)
        self.assertIn("master", out.get("reason", ""))


if __name__ == "__main__":
    unittest.main()
