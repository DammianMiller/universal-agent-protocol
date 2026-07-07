#!/usr/bin/env python3
"""Regression: the STUCK-BREAK injector built `msgs = openai_body.get("messages")
or []`, which returns a DETACHED empty list when messages is [], so the injected
directive never landed in the outbound request. Real requests always carry
messages, but the injector must be robust — it now reattaches the list.
Mirrors the fix already applied to _maybe_inject_deferral_break.
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


def _firing_monitor():
    mon = proxy.SessionMonitor()
    # Trip the self-reported-stuck signal so the injector fires.
    mon.self_stuck_streak = proxy.PROXY_STUCK_TEXT_THRESHOLD + 1
    return mon


class TestStuckBreakReattach(unittest.TestCase):
    def test_empty_messages_list_still_receives_directive(self):
        mon = _firing_monitor()
        body = {"tool_choice": "required", "messages": []}
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertTrue(body["messages"], "directive must land in the request")
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertIn("STOP", body["messages"][0]["content"])
        self.assertEqual(body["tool_choice"], "auto")  # coercion released

    def test_absent_messages_key_is_created(self):
        mon = _firing_monitor()
        body = {"tool_choice": "required"}  # no "messages" key at all
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertIn("messages", body)
        self.assertIn("STOP", body["messages"][0]["content"])

    def test_existing_system_message_is_appended(self):
        mon = _firing_monitor()
        body = {"messages": [{"role": "system", "content": "SYS"}]}
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(len(body["messages"]), 1)
        self.assertTrue(body["messages"][0]["content"].startswith("SYS"))
        self.assertIn("STOP", body["messages"][0]["content"])

    def test_does_not_fire_when_not_stuck(self):
        mon = proxy.SessionMonitor()  # no streak
        body = {"tool_choice": "required", "messages": []}
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(body["messages"], [])
        self.assertEqual(body["tool_choice"], "required")


if __name__ == "__main__":
    unittest.main()
