"""rtk-wrap: heavy CLIs go through rtk, but PARSED output must not.

rtk rewrites command output for token savings and does not notice when the
caller asked for machine-readable output. Measured against real git in this
repo:

    git worktree list --porcelain    46 entries  ->  rtk: 0 entries
    git branch --format='%(refname:short)'  55 refs -> rtk: 142 lines, wrong set
    git diff --name-only HEAD        3 paths     ->  rtk: 3 paths + "--- Changes ---"
    git status --porcelain           12 lines    ->  rtk: 11
    git branch -r / --merged, stash list, log --oneline : all differ

`rtk proxy` runs the command unfiltered and was byte-exact on all eight.

This matters because the policy makes rtk mandatory, so the mangled output is
what every agent in this repo reads. Parsing `^worktree ` out of
`rtk git worktree list --porcelain` yields NOTHING, and an agent pruning
worktrees on that basis concludes there are none to protect.

The enforcer had no tests before this file, which is how `rtk git
<machine-readable>` -- the corrupting combination -- stayed invisible: every
statement led by `rtk` was skipped without looking at what followed.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENFORCER = REPO / "src" / "policies" / "enforcers" / "rtk_wrap.py"


def gate(command: str) -> tuple[bool, str]:
    r = subprocess.run(
        [sys.executable, str(ENFORCER), "--operation", "Bash",
         "--args", json.dumps({"command": command})],
        capture_output=True, text=True, timeout=60,
    )
    try:
        payload = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return True, f"unparseable: {r.stdout[:120]}"
    return payload.get("allowed", True), payload.get("reason", "")


class MachineReadableGitMustBypassTheFilter(unittest.TestCase):
    """The verdicts that stop an agent reading prose as records."""

    MACHINE = [
        "git worktree list --porcelain",
        "git status --porcelain",
        "git branch --format='%(refname:short)'",
        "git diff --name-only HEAD",
        "git log --pretty=%H",
        # NOT `log --oneline`: a reading convenience, not a parse signal.
        # test/rtk-wrap.test.ts contracts it as accepted, and anything that
        # means to parse log output uses --format or --pretty.
        "git diff --numstat HEAD",
        "git ls-files -z",
        "git branch -r",
        "git branch --merged origin/master",
        "git stash list",
    ]

    def test_bare_git_asking_for_records_is_sent_to_rtk_proxy(self):
        for cmd in self.MACHINE:
            with self.subTest(cmd=cmd):
                allowed, reason = gate(cmd)
                self.assertFalse(allowed, cmd)
                self.assertIn("rtk proxy", reason, f"{cmd}: must name the unfiltered form")

    def test_rtk_git_asking_for_records_is_refused(self):
        """The combination that used to sail through.

        Statements led by `rtk` were skipped without inspecting the rest, so
        the one form that actually corrupts data was the one the gate ignored.
        """
        for cmd in self.MACHINE:
            with self.subTest(cmd=cmd):
                allowed, reason = gate("rtk " + cmd)
                self.assertFalse(allowed, f"rtk {cmd} returns mangled output")
                self.assertIn("rtk proxy", reason)

    def test_rtk_proxy_is_accepted(self):
        for cmd in self.MACHINE:
            with self.subTest(cmd=cmd):
                allowed, _ = gate("rtk proxy " + cmd)
                self.assertTrue(allowed, f"rtk proxy {cmd} is the correct form")


class HumanReadableGitIsUnaffected(unittest.TestCase):
    """rtk's entire purpose is these, and the rule must not tax them."""

    def test_ordinary_git_still_wants_plain_rtk(self):
        for cmd in ("git status", "git log -5", "git diff", "git branch", "git show HEAD"):
            with self.subTest(cmd=cmd):
                allowed, reason = gate(cmd)
                self.assertFalse(allowed, cmd)
                self.assertIn("rtk", reason)
                self.assertNotIn(
                    "rtk proxy", reason,
                    f"{cmd} is human-readable; sending it to proxy forfeits the token saving",
                )

    def test_already_wrapped_human_forms_pass(self):
        for cmd in ("rtk git status", "rtk git log -5", "rtk git diff", "rtk git branch"):
            with self.subTest(cmd=cmd):
                allowed, _ = gate(cmd)
                self.assertTrue(allowed, cmd)


class ExistingBehaviourIsPreserved(unittest.TestCase):
    """The regressions this enforcer already carries scars from."""

    def test_a_wrapped_cli_behind_a_cd_is_still_caught(self):
        allowed, _ = gate("cd /srv/app && git log")
        self.assertFalse(allowed, "a bare invocation hidden behind cd is a bypass")

    def test_an_already_wrapped_statement_behind_a_cd_passes(self):
        allowed, _ = gate("cd /srv/app && rtk git log")
        self.assertTrue(allowed)

    def test_npm_builtins_still_route_to_proxy(self):
        allowed, reason = gate("npm view lodash")
        self.assertFalse(allowed)
        self.assertIn("rtk proxy", reason, "rtk npm view would mangle to `npm run view`")

    def test_npm_scripts_still_route_to_plain_rtk(self):
        allowed, reason = gate("npm test")
        self.assertFalse(allowed)
        self.assertNotIn("rtk proxy", reason)

    def test_a_wrapped_cli_as_an_argument_is_not_an_invocation(self):
        allowed, _ = gate("echo git status")
        self.assertTrue(allowed, "git here is an argument to echo, not a command")

    def test_non_bash_operations_are_ignored(self):
        r = subprocess.run(
            [sys.executable, str(ENFORCER), "--operation", "Edit",
             "--args", json.dumps({"command": "git status --porcelain"})],
            capture_output=True, text=True, timeout=60,
        )
        self.assertTrue(json.loads(r.stdout)["allowed"])


if __name__ == "__main__":
    unittest.main()
