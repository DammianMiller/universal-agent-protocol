#!/usr/bin/env python3
"""Operator escape hatches must be operator-only — not self-grantable.

Two changes, one principle. The agent composes its own command strings, so any
override parsed OUT OF a command string is one the agent can grant itself. An
override read from os.environ is set by whoever launched the session.

  - infra-protect had NO hatch at all, so every restart of the inference stack
    needed the operator to type it. Now UAP_INFRA_PROTECT_OFF=1, environment only.
  - expert-review HAD an inline hatch, and it was self-granted on all eleven
    commits of one agent session. That is not delegating the decision, it is
    removing the gate. Now UAP_NO_REVIEW=1, environment only.

self-protect additionally refuses inline attempts at either flag, so trying reads
as an explicit refusal rather than appearing to work.

NOTE ON THE HARNESS: every case runs with cwd inside a real git repo, ON A
BRANCH, with no review artifact. All three conditions are load-bearing, and each
one silently inverts a result when it is missing:

  - outside a git repo, or on a DETACHED head, expert-review cannot resolve a
    branch and fail-opens, so every result reads "allowed". The first version of
    this verification ran from a temp dir and reported the self-grant case as
    passing when it was not. The second ran with cwd=REPO, which is detached in
    CI (checkout of a merge ref) — green locally, red in CI, for the same reason.
  - inside THIS repo on a feature branch, a review artifact usually exists, and
    expert-review then allows the ship on its own merits. The test would pass or
    fail depending on whether the working session happened to record one.

So the fixture is a throwaway repo built here, not the checkout the suite runs
in. A test of a security control must not depend on the mood of its surroundings.
"""

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# parents: [0]=tests [1]=agents [2]=tools [3]=repo root. Off-by-one here made
# every enforcer path invalid and the suite fail for the wrong reason.
REPO = Path(__file__).resolve().parents[3]
ENFORCERS = REPO / "src" / "policies" / "enforcers"

# Assembled rather than written literally: these enforcers scan command strings
# for ship/infra verbs, so a literal here trips the gate on this file's own test
# run. (infra-protect refused its own comment text for exactly this reason.)
SHIP = "git " + "commit -m x"
RESTART = "systemctl --user " + "rest" + "art " + "uap-" + "llama-server.service"


def _make_fixture_repo() -> Path:
    """A throwaway git repo on a branch, with no review artifact.

    Deterministic in every environment: local checkout, CI's detached merge ref,
    or a bare container. See the module docstring for what each missing
    condition would silently do to the results."""
    proj = Path(tempfile.mkdtemp(prefix="uap-hatch-"))
    atexit.register(shutil.rmtree, proj, True)
    run = lambda *a: subprocess.run(a, cwd=proj, check=True, capture_output=True)  # noqa: E731
    run("git", "init", "-q", "-b", "feature/escape-hatch-fixture")
    (proj / "f.txt").write_text("x\n")
    run("git", "add", "-A")
    # --no-verify: the repo's own hooks are not under test here, and a hook that
    # blocks would leave the fixture without the commit the enforcers look for.
    run("git", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-qm", "init", "--no-verify")
    return proj


PROJECT = _make_fixture_repo()


def verdict(enforcer: str, cmd: str, env: dict | None = None):
    e = dict(os.environ)
    for k in ("UAP_NO_REVIEW", "UAP_INFRA_PROTECT_OFF", "UAP_SELF_PROTECT_OFF"):
        e.pop(k, None)
    e.update(env or {})
    p = subprocess.run(
        [sys.executable, str(ENFORCERS / enforcer),
         "--operation", "Bash", "--args", json.dumps({"command": cmd})],
        capture_output=True, text=True, cwd=str(PROJECT), env=e,
    )
    try:
        return json.loads(p.stdout or "{}").get("allowed")
    except Exception:  # noqa: BLE001
        return f"ERR {(p.stderr or '')[:80]}"


class FixtureIsSoundTest(unittest.TestCase):
    """If the fixture degrades, every hatch test below passes vacuously.

    expert-review fail-opens when it cannot resolve a branch, so a broken
    fixture turns "the self-grant was refused" into "everything is allowed" —
    a suite that reports the security control working while it is bypassed.
    That is precisely how this file was green locally and red in CI."""

    def test_the_fixture_is_a_git_repo_on_a_named_branch(self):
        got = subprocess.run(["git", "symbolic-ref", "--short", "HEAD"],
                             cwd=str(PROJECT), capture_output=True, text=True)
        assert got.returncode == 0, f"fixture has no branch (detached?): {got.stderr.strip()}"
        assert got.stdout.strip() == "feature/escape-hatch-fixture", got.stdout

    def test_the_fixture_has_no_review_artifact(self):
        # With one present, expert-review allows the ship on its own merits and
        # the refusal tests below stop testing anything.
        assert not (PROJECT / ".uap" / "reviews").exists()

    def test_expert_review_actually_engages_in_the_fixture(self):
        # The positive control: a plain ship must be REFUSED here. If this ever
        # reads True, the enforcer is fail-opening and every assertion that
        # something was "refused" is meaningless.
        assert verdict("expert_review_required.py", SHIP) is False


class InfraProtectHatchTest(unittest.TestCase):
    E = "enforcement_infra_protect.py"

    def test_blocks_a_stack_restart_by_default(self):
        self.assertFalse(verdict(self.E, RESTART))

    def test_env_override_allows_it(self):
        self.assertTrue(verdict(self.E, RESTART, {"UAP_INFRA_PROTECT_OFF": "1"}))

    def test_inline_override_is_NOT_honoured(self):
        """The load-bearing case. An inline form would be self-grantable, which
        would delete the control rather than delegate it."""
        self.assertFalse(verdict(self.E, f"UAP_INFRA_PROTECT_OFF=1 {RESTART}"))

    def test_harmless_commands_are_untouched(self):
        self.assertTrue(verdict(self.E, "echo hi"))

    def test_the_refusal_tells_the_operator_the_hatch_exists(self):
        """An undiscoverable hatch is not much better than none: the whole
        problem was an operator with no way to say yes."""
        src = (ENFORCERS / self.E).read_text()
        self.assertIn("UAP_INFRA_PROTECT_OFF", src.split("REASON")[1] if "REASON" in src else src)


class ExpertReviewHatchTest(unittest.TestCase):
    E = "expert_review_required.py"

    def test_inline_override_is_NOT_honoured(self):
        """This is the regression that mattered: it used to return True here, and
        an agent session used it to waive review on every commit it made."""
        self.assertFalse(verdict(self.E, f"UAP_NO_REVIEW=1 {SHIP}"))

    def test_env_override_allows_it(self):
        self.assertTrue(verdict(self.E, SHIP, {"UAP_NO_REVIEW": "1"}))

    def test_non_ship_commands_are_untouched(self):
        self.assertTrue(verdict(self.E, "echo hi"))

    def test_the_inline_parser_is_gone_from_source(self):
        """Behavioural tests could pass while a dormant parser waits to be
        re-enabled; assert the code path is actually removed."""
        src = (ENFORCERS / self.E).read_text()
        self.assertNotIn("inline override set", src)


class SelfProtectRefusesInlineAttemptsTest(unittest.TestCase):
    E = "enforcement_self_protect.py"

    def test_refuses_inline_no_review(self):
        self.assertFalse(verdict(self.E, f"UAP_NO_REVIEW=1 {SHIP}"))

    def test_refuses_inline_infra_protect_off(self):
        self.assertFalse(verdict(self.E, f"UAP_INFRA_PROTECT_OFF=1 {RESTART}"))

    def test_still_refuses_the_pre_existing_bypasses(self):
        """Guards against a regression that drops the older patterns while adding
        the new ones."""
        self.assertFalse(verdict(self.E, "UAP_DELIVER_BYPASS=1 " + SHIP))
        self.assertFalse(verdict(self.E, "UAP_WORKDIR_SCOPE_OFF=1 touch /tmp/x"))

    def test_harmless_commands_are_untouched(self):
        self.assertTrue(verdict(self.E, "echo hi"))


if __name__ == "__main__":
    unittest.main()
