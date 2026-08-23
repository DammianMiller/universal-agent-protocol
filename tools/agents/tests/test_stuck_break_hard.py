#!/usr/bin/env python3
"""STUCK-BREAK hard tier.

The advisory STUCK-BREAK (directive + tool_choice released to 'auto') leaves
every tool on the table, and a weak local model just issues the same call
again: observed live 2026-08-23 16:46-17:45, the identical bash call 13+ turns
in a row with fires=33 and never a prose reply. After
PROXY_STUCK_BREAK_HARD_FIRES fires the break must be HARD -- tools removed for
that turn, XML tool-call resurrection suppressed -- so the turn can only end in
prose and the client's agent loop actually terminates.
"""

import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


def _looping_monitor(fires_so_far: int):
    mon = proxy.SessionMonitor()
    mon.self_stuck_streak = proxy.PROXY_STUCK_TEXT_THRESHOLD + 1
    mon.stuck_break_fires = fires_so_far
    return mon


def _body():
    return {
        "tool_choice": "required",
        "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}],
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "go"}],
    }


class TestStuckBreakHard(unittest.TestCase):
    def test_below_hard_threshold_stays_advisory(self):
        mon = _looping_monitor(fires_so_far=0)
        body = _body()
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(mon.stuck_break_fires, 1)
        self.assertIn("tools", body, "advisory tier keeps the tools")
        self.assertEqual(body["tool_choice"], "auto")
        self.assertFalse(mon.suppress_text_tool_extraction)
        self.assertIn("STOP", body["messages"][0]["content"])

    def test_hard_threshold_strips_tools_and_suppresses_xml_resurrection(self):
        mon = _looping_monitor(fires_so_far=proxy.PROXY_STUCK_BREAK_HARD_FIRES - 1)
        body = _body()
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(mon.stuck_break_fires, proxy.PROXY_STUCK_BREAK_HARD_FIRES)
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertTrue(mon.suppress_text_tool_extraction)
        self.assertIn("plain text", body["messages"][0]["content"])
        self.assertIn("STOP", body["messages"][0]["content"])  # the advisory text still travels

    def test_hard_tier_can_be_disabled(self):
        saved = proxy.PROXY_STUCK_BREAK_HARD_FIRES
        try:
            proxy.PROXY_STUCK_BREAK_HARD_FIRES = 0
            mon = _looping_monitor(fires_so_far=50)
            body = _body()
            proxy._maybe_inject_stuck_break(body, mon)
            self.assertIn("tools", body)
            self.assertFalse(mon.suppress_text_tool_extraction)
        finally:
            proxy.PROXY_STUCK_BREAK_HARD_FIRES = saved

    def test_default_threshold_is_small(self):
        # Three ignored breaks is already ~8 minutes of identical calls on the
        # local executor; the default must not let a loop run for an hour.
        self.assertGreater(proxy.PROXY_STUCK_BREAK_HARD_FIRES, 0)
        self.assertLessEqual(proxy.PROXY_STUCK_BREAK_HARD_FIRES, 5)


if __name__ == "__main__":
    unittest.main()
