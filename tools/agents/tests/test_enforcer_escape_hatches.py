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

NOTE ON THE HARNESS: every case runs with cwd inside a real git repo. Outside
one, expert-review fail-opens on an unresolvable branch and EVERY result reads
"allowed" — the first version of this verification was run from a temp dir and
reported the self-grant case as passing when it was not.
"""

import json
import os
import subprocess
import sys
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


def verdict(enforcer: str, cmd: str, env: dict | None = None):
    e = dict(os.environ)
    for k in ("UAP_NO_REVIEW", "UAP_INFRA_PROTECT_OFF", "UAP_SELF_PROTECT_OFF"):
        e.pop(k, None)
    e.update(env or {})
    p = subprocess.run(
        [sys.executable, str(ENFORCERS / enforcer),
         "--operation", "Bash", "--args", json.dumps({"command": cmd})],
        capture_output=True, text=True, cwd=str(REPO), env=e,
    )
    try:
        return json.loads(p.stdout or "{}").get("allowed")
    except Exception:  # noqa: BLE001
        return f"ERR {(p.stderr or '')[:80]}"


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
