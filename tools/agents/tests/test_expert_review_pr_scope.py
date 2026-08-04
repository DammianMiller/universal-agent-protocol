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
DQ, SQ = chr(34), chr(39)
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


class TestShipDetectionIsCommandPosition(unittest.TestCase):
    """A ship verb in PROSE is not a ship action.

    The patterns used to be searched over the whole command string, so any text
    that merely named a ship verb tripped the gate — a quoted string, a grep
    pattern, a heredoc body. It self-deadlocked too: writing this gate's own
    review artifact was refused because the notes described the bug being fixed.

    The risk in the fix is UNDER-detection, so the ship cases below matter more
    than the prose ones. `rtk git push` especially: this repo requires git to be
    invoked through rtk, so a verb check that stopped at the wrapper would miss
    every real ship command in the codebase.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.bin = base / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        self._write_stub_gh()
        self._init_repo()
        # Deliberately NO review artifact: a ship action must be refused, and a
        # non-ship command must sail past with "not a ship action".

    def tearDown(self):
        self._tmp.cleanup()

    _write_stub_gh = TestExpertReviewPrScope._write_stub_gh
    _init_repo = TestExpertReviewPrScope._init_repo
    _run = TestExpertReviewPrScope._run

    def assert_ship(self, command):
        out, code = self._run(command)
        self.assertFalse(out.get("allowed"), f"{command!r} should be gated as a ship action")
        self.assertEqual(code, 2, command)

    def assert_not_ship(self, command):
        out, code = self._run(command)
        self.assertTrue(out.get("allowed"), f"{command!r} should not be a ship action")
        self.assertIn("not a ship action", out.get("reason", ""), command)

    # --- real ship actions must STILL be gated ---

    def test_plain_git_push_is_a_ship_action(self):
        self.assert_ship("git push origin master")

    def test_rtk_wrapped_git_is_a_ship_action(self):
        # The mandated form in this repo. Missing it would silently ungate
        # every push and commit made here.
        self.assert_ship("rtk git push origin master")

    def test_ship_action_after_a_chained_command(self):
        self.assert_ship("cd sub && git commit -m x")

    def test_git_global_option_before_the_subcommand(self):
        # `git -C <path> push` — not caught by the old pattern at all.
        self.assert_ship("git -C /repo push")

    def test_gh_pr_merge_is_a_ship_action(self):
        self.assert_ship("gh pr merge 645 --squash")

    # --- prose that merely NAMES a ship verb must not be ---

    def test_quoted_ship_verb_is_prose(self):
        self.assert_not_ship("echo 'gh pr merge 645'")

    def test_grep_pattern_is_prose(self):
        self.assert_not_ship("grep -r 'git push' docs/")

    def test_heredoc_body_is_data_not_commands(self):
        # The exact self-deadlock: writing the review artifact whose notes
        # describe the gate being fixed.
        self.assert_not_ship(
            "python3 - <<'PY'\n"
            "notes = 'refused because the notes mention gh pr merge'\n"
            "print(notes)\n"
            "PY"
        )

    # --- forms a command-position-only check LOSES ---
    #
    # A first attempt at this fix replaced the patterns with a verb-at-position-0
    # check, copying self-protect. Measured against the old patterns it dropped
    # 14 real detections, every one of them below: the loose patterns caught
    # these by accident and the verb check does not. A gate that stops
    # recognising a ship action stops gating, which is strictly worse than the
    # false positives being fixed — so these are pinned.

    def test_wrapper_with_its_own_argument_still_ships(self):
        # The wrapper takes an argument, so the wrapped verb is not token 1.
        self.assert_ship("timeout 30 git push")
        self.assert_ship("sudo -u someone git push")

    def test_subshell_and_brace_group_still_ship(self):
        self.assert_ship("(git push)")
        self.assert_ship("{ git push; }")

    def test_negated_command_still_ships(self):
        self.assert_ship("! git push")

    def test_shell_exec_string_still_ships(self):
        # The ship verb is inside quotes, but `bash -c` makes that text a
        # command — which is exactly what separates it from `echo 'git push'`.
        self.assert_ship("bash -c 'git push'")
        self.assert_ship("sh -c 'git push'")

    def test_xargs_and_find_exec_still_ship(self):
        self.assert_ship("echo origin | xargs git push")
        self.assert_ship("find . -exec git push ;")

    def test_leading_redirect_still_ships(self):
        # Bash allows a redirection before the command word.
        self.assert_ship("> /tmp/uap-out.log git push")

    def test_commit_message_naming_other_ship_verbs_still_ships(self):
        # The quotes hold prose, but `git commit` is outside them.
        self.assert_ship("git commit -m 'explain gh pr merge behaviour'")

    # --- an interpreter's -c/-e payload is CODE, not prose ---
    #
    # Masking quoted spans assumed quoted text is inert. That holds for `echo`
    # and fails for every interpreter: each command below really pushed in a
    # throwaway repo (the bare origin gained the commit) while an earlier
    # version of this fix blanked the payload and let it through.

    def test_python_payload_that_shells_out_is_a_ship_action(self):
        self.assert_ship(
            "python3 -c " + DQ + "import os; os.system(" + SQ + "git push" + SQ + ")" + DQ
        )

    def test_perl_payload_that_shells_out_is_a_ship_action(self):
        self.assert_ship("perl -e " + DQ + "system(" + SQ + "git push" + SQ + ")" + DQ)

    def test_node_payload_that_shells_out_is_a_ship_action(self):
        self.assert_ship(
            "node -e " + DQ + "require(" + SQ + "child_process" + SQ
            + ").execSync(" + SQ + "git push" + SQ + ")" + DQ
        )

    def test_an_inert_interpreter_payload_is_over_detected_on_purpose(self):
        # `print('git push')` ships nothing, but is indistinguishable from
        # `os.system('git push')` without running the interpreter. Gated on
        # purpose: an unnecessary review is a nuisance, an ungated ship is not.
        self.assert_ship("python3 -c " + DQ + "print(" + SQ + "git push" + SQ + ")" + DQ)

    # --- executors nobody thought to list ---
    #
    # Quoting used to be masked by default, with an exemption list for things
    # that execute: bash -c, then python/perl/node, and `script -qc` still got
    # through — it really ships (a throwaway bare repo gained the commit). su,
    # fish, expect, parallel and watch sat behind it. A denylist of executors
    # cannot be completed, so masking is now allowlisted to verbs that print or
    # search their arguments, and anything unrecognised scans the raw text.
    #
    # These cases exist to keep that inversion from being quietly undone: they
    # pass because `script`/`su`/`fish` are NOT on the inert allowlist, not
    # because anyone enumerated them.

    def test_script_wrapped_ship_is_detected(self):
        self.assert_ship("script -qc " + SQ + "git push" + SQ + " /dev/null")

    def test_su_wrapped_ship_is_detected(self):
        self.assert_ship("su -c " + SQ + "git push" + SQ)

    def test_unlisted_shell_wrapped_ship_is_detected(self):
        self.assert_ship("fish -c " + SQ + "git push" + SQ)
        self.assert_ship("expect -c " + SQ + "git push" + SQ)

    def test_remote_execution_is_detected(self):
        # Ships on the far side; gated on purpose.
        self.assert_ship("ssh somehost " + SQ + "git push" + SQ)

    def test_inert_verbs_still_treat_quotes_as_prose(self):
        # The allowlist half: these must stay unblocked, or the false positives
        # this branch exists to fix come straight back.
        self.assert_not_ship("printf " + SQ + "run gh pr merge later" + SQ)
        self.assert_not_ship("cat docs/merge-strategy.md")

    # --- verbs that ship without saying "push" or "merge" ---
    #
    # Catalogued as gaps that pattern-matching could not reach. Three of the
    # four turned out to be reachable; the fourth (a variable holding the
    # binary name, `G=git; $G push`) is not, because knowing what $G contains
    # means running the shell — it is documented rather than half-solved.

    def test_plumbing_push_is_a_ship_action(self):
        # `git push` is a wrapper around send-pack. Same effect, different verb.
        self.assert_ship("git send-pack origin HEAD:refs/heads/main")

    def test_plumbing_commit_is_a_ship_action(self):
        self.assert_ship("git commit-tree abc123 -m msg")

    def test_gh_api_rest_merge_is_a_ship_action(self):
        # Merges the PR without the string "pr merge" appearing anywhere.
        self.assert_ship("gh api -X PUT repos/owner/repo/pulls/1/merge")

    def test_gh_api_graphql_merge_is_a_ship_action(self):
        self.assert_ship(
            "gh api graphql -f query=" + SQ + "mutation{mergePullRequest(input:{})}" + SQ
        )

    def test_prose_naming_a_merge_endpoint_is_still_prose(self):
        # The endpoint patterns must not resurrect the false positives #649
        # removed: naming an endpoint is not calling it.
        self.assert_not_ship("echo " + SQ + "see repos/owner/repo/pulls/1/merge" + SQ)

    def test_read_only_git_is_not_a_ship_action(self):
        self.assert_not_ship("git diff --merge-base main")
        self.assert_not_ship("git status --short")


if __name__ == "__main__":
    unittest.main()
