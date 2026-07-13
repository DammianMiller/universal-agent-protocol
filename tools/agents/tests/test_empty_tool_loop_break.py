#!/usr/bin/env python3
"""Empty-tool-loop breaker: after N consecutive fully-empty responses under a
forced tool_choice, release the force + inject a plain-text directive so a stuck
model can report the blocker (e.g. a deleted deliverable) instead of spinning."""
import importlib.util
import os
import unittest
from pathlib import Path


def _load_proxy():
    os.environ.setdefault("PROXY_EMPTY_TOOL_LOOP_BREAK", "3")
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()


def forced_body():
    return {"tool_choice": "required", "messages": [{"role": "user", "content": "go"}]}


class EmptyToolLoopBreakTests(unittest.TestCase):
    def setUp(self):
        self.m = proxy.SessionMonitor()

    def test_no_op_below_threshold(self):
        body = forced_body()
        self.m.consecutive_empty_tool_turns = proxy.PROXY_EMPTY_TOOL_LOOP_BREAK - 1
        proxy._maybe_break_empty_tool_loop(body, self.m)
        self.assertEqual(body["tool_choice"], "required")  # force intact
        self.assertEqual(len(body["messages"]), 1)  # no directive injected

    def test_releases_and_directs_at_threshold(self):
        body = forced_body()
        self.m.consecutive_empty_tool_turns = proxy.PROXY_EMPTY_TOOL_LOOP_BREAK
        proxy._maybe_break_empty_tool_loop(body, self.m)
        self.assertEqual(body["tool_choice"], "auto")  # force released → prose possible
        self.assertEqual(len(body["messages"]), 2)  # plain-text directive appended
        self.assertIn("PLAIN TEXT", body["messages"][-1]["content"])
        self.assertEqual(self.m.consecutive_empty_tool_turns, 0)  # one-shot per window

    def test_disabled_when_threshold_zero(self):
        body = forced_body()
        old = proxy.PROXY_EMPTY_TOOL_LOOP_BREAK
        try:
            proxy.PROXY_EMPTY_TOOL_LOOP_BREAK = 0
            self.m.consecutive_empty_tool_turns = 99
            proxy._maybe_break_empty_tool_loop(body, self.m)
            self.assertEqual(body["tool_choice"], "required")  # disabled → no-op
        finally:
            proxy.PROXY_EMPTY_TOOL_LOOP_BREAK = old

    def test_leaves_unforced_tool_choice_alone_but_still_directs(self):
        # If tool_choice isn't 'required' (already auto), don't clobber it, but
        # still surface the directive so the model breaks the empty streak.
        body = {"tool_choice": "auto", "messages": [{"role": "user", "content": "go"}]}
        self.m.consecutive_empty_tool_turns = proxy.PROXY_EMPTY_TOOL_LOOP_BREAK
        proxy._maybe_break_empty_tool_loop(body, self.m)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(len(body["messages"]), 2)


if __name__ == "__main__":
    unittest.main()
