#!/usr/bin/env python3
"""Precedence: the deliver mandate outranks recon convergence.

Both guards run on the same turn (mandate first) and both rewrite
tools/tool_choice, so without an explicit rule the later one -- recon -- wins
and silently releases the pin. That made the mandate's own docstring claim
("runs before the softer guards so the pin stands") untrue.

The regression is only observable now: until v1.172.2 the pin was encoded in a
form llama.cpp ignored, so recon had nothing to override.
"""

import importlib.util
import os
import unittest
from pathlib import Path


def _load_proxy(env: dict | None = None):
    """Import the proxy with `env` applied, then restore the environment.

    Module-level constants (PROXY_*) are read at import, so a knob can only be
    exercised by re-importing under a different environment.
    """
    saved = {k: os.environ.get(k) for k in (env or {})}
    try:
        for k, v in (env or {}).items():
            os.environ[k] = v
        p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
        spec = importlib.util.spec_from_file_location("anthropic_proxy_mbr", p)
        assert spec is not None and spec.loader is not None
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


proxy = _load_proxy()

DELIVER_TOOL = {"type": "function", "function": {"name": "deliver", "parameters": {}}}
READ_TOOL = {"type": "function", "function": {"name": "read", "parameters": {}}}
GREP_TOOL = {"type": "function", "function": {"name": "grep", "parameters": {}}}
BLOCK_MSG = (
    "BLOCKED: do not edit 'src/foo.ts' directly. To create or change code, call "
    "the `deliver` tool (or run: uap deliver \"...\"). Do NOT retry this edit."
)


def _blocked_body(tools):
    return {
        "tools": list(tools),
        "messages": [
            {"role": "assistant", "content": "editing",
             "tool_calls": [{"function": {"name": "edit"}}]},
            {"role": "tool", "content": BLOCK_MSG},
        ],
        "tool_choice": "auto",
    }


def _deep_recon(monitor, mod):
    """Put the monitor well past the hard recon tier, so recon would definitely
    fire and rewrite the request if it were allowed to run."""
    monitor.consecutive_no_write_turns = int(
        mod.PROXY_RECON_CONVERGENCE_THRESHOLD * mod.PROXY_RECON_HARD_MULTIPLIER
    ) + 10


class MandateBeatsReconTest(unittest.TestCase):
    def test_recon_cannot_release_a_pinned_turn(self):
        mon = proxy.SessionMonitor()
        mon.mandate_deliver_active = False
        body = _blocked_body([READ_TOOL, GREP_TOOL, DELIVER_TOOL])

        proxy._maybe_inject_mandate_deliver(body, mon)
        self.assertTrue(mon.mandate_deliver_active)
        self.assertEqual(body["tool_choice"], "required")
        self.assertEqual([t["function"]["name"] for t in body["tools"]], ["deliver"])

        _deep_recon(mon, proxy)
        proxy._maybe_inject_recon_convergence(body, mon, [READ_TOOL, GREP_TOOL, DELIVER_TOOL])

        # The pin must survive: still required, still exactly one tool.
        self.assertEqual(body["tool_choice"], "required")
        self.assertEqual([t["function"]["name"] for t in body["tools"]], ["deliver"])

    def test_recon_still_runs_when_no_mandate_is_active(self):
        """The suppression must be scoped to mandated turns -- recon is the
        read-forever deadlock breaker and must keep working otherwise."""
        mon = proxy.SessionMonitor()
        mon.mandate_deliver_active = False
        body = {"tools": [READ_TOOL, GREP_TOOL], "messages": [{"role": "user", "content": "explore"}]}
        _deep_recon(mon, proxy)

        before = mon.recon_hard_fires
        proxy._maybe_inject_recon_convergence(body, mon, [READ_TOOL, GREP_TOOL])
        self.assertGreater(mon.recon_hard_fires, before)

    def test_flag_is_per_turn_not_sticky(self):
        """A stale True would suppress recon forever after one mandate. The
        request builder clears it each turn; assert the field is not latched by
        the mandate itself."""
        mon = proxy.SessionMonitor()
        self.assertFalse(mon.mandate_deliver_active)
        body = _blocked_body([DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(body, mon)
        self.assertTrue(mon.mandate_deliver_active)

        # Simulate the next turn's reset, then a turn with no block present.
        mon.mandate_deliver_active = False
        clean = {"tools": [DELIVER_TOOL], "messages": [{"role": "user", "content": "hello"}]}
        proxy._maybe_inject_mandate_deliver(clean, mon)
        self.assertFalse(mon.mandate_deliver_active)

    def test_no_mandate_claimed_when_pin_is_impossible(self):
        """If deliver is absent the pin cannot be applied. Recording a mandate
        anyway would suppress recon while leaving the model free to hand-edit --
        strictly worse than letting recon run."""
        mon = proxy.SessionMonitor()
        body = _blocked_body([READ_TOOL])
        proxy._maybe_inject_mandate_deliver(body, mon)
        self.assertFalse(mon.mandate_deliver_active)
        self.assertEqual(mon.mandate_deliver_fires, 0)

    def test_precedence_off_reproduces_the_bug_it_fixes(self):
        """PROXY_MANDATE_BEATS_RECON=off restores the old ordering -- and pins
        down exactly what that ordering costs.

        This is the load-bearing assertion of the whole change: with the
        precedence disabled, recon's hard tier sets tool_choice back to "auto",
        releasing a mandate raised because a source edit had just been BLOCKED.
        The model is then free to do what it was blocked for. If this test ever
        stops reproducing that release, the precedence guard has become dead
        code and the suppression above is no longer protecting anything.
        """
        mod = _load_proxy({"PROXY_MANDATE_BEATS_RECON": "off"})
        self.assertFalse(mod.PROXY_MANDATE_BEATS_RECON)

        mon = mod.SessionMonitor()
        body = _blocked_body([READ_TOOL, GREP_TOOL, DELIVER_TOOL])
        mod._maybe_inject_mandate_deliver(body, mon)
        self.assertTrue(mon.mandate_deliver_active)
        self.assertEqual(body["tool_choice"], "required")

        _deep_recon(mon, mod)
        before = mon.recon_hard_fires
        mod._maybe_inject_recon_convergence(body, mon, [READ_TOOL, GREP_TOOL, DELIVER_TOOL])

        self.assertGreater(mon.recon_hard_fires, before)  # recon ran
        self.assertEqual(body["tool_choice"], "auto")     # ...and released the pin


if __name__ == "__main__":
    unittest.main()
