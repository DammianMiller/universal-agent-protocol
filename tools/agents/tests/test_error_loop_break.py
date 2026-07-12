#!/usr/bin/env python3
"""ERROR-LOOP guardrail: detect a repeated tool_result error signature across
varied edits and nudge the model to re-read the failing file.

The identical-tool-call loop detectors miss this because each edit differs; this
keys on the normalized ERROR, which is edit-invariant.
"""
import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


proxy = _load_proxy_module()


class ErrorSignatureTests(unittest.TestCase):
    def test_same_error_different_paths_lines_shares_signature(self):
        a = proxy._error_signature("SyntaxError: Identifier 'testPageLoads' has already been declared\n  at /home/x/test.js:75:1")
        b = proxy._error_signature("SyntaxError: Identifier 'testPageLoads' has already been declared\n  at /other/path/test.js:128:9")
        self.assertTrue(a)
        self.assertEqual(a, b)  # edit-invariant

    def test_distinct_errors_differ(self):
        a = proxy._error_signature("TypeError: cannot read property 'x' of undefined")
        b = proxy._error_signature("SyntaxError: unexpected token")
        self.assertNotEqual(a, b)

    def test_clean_output_has_no_signature(self):
        self.assertEqual(proxy._error_signature("ok\nall 12 tests passed"), "")
        self.assertEqual(proxy._error_signature(""), "")


class MonitorStreakTests(unittest.TestCase):
    def setUp(self):
        self.m = proxy.SessionMonitor()

    def test_streak_accumulates_on_repeat_and_resets_on_pass(self):
        err = "TypeError: cannot find module 'foo'\n at a.js:1"
        for _ in range(3):
            self.m.note_tool_result_error(err)
        self.assertGreaterEqual(self.m.error_signature_streak, 3)
        # a passing result resets
        self.m.note_tool_result_error("ok, 5 passed")
        self.assertEqual(self.m.error_signature_streak, 0)

    def test_new_error_resets_streak_to_one(self):
        self.m.note_tool_result_error("Error: A\n at a:1")
        self.m.note_tool_result_error("Error: A\n at a:2")
        self.assertEqual(self.m.error_signature_streak, 2)
        self.m.note_tool_result_error("Error: B different\n at b:1")
        self.assertEqual(self.m.error_signature_streak, 1)


class InjectionTests(unittest.TestCase):
    def setUp(self):
        self.m = proxy.SessionMonitor()

    def test_nudge_injected_past_threshold(self):
        for _ in range(proxy.PROXY_ERROR_LOOP_THRESHOLD):
            self.m.note_tool_result_error("SyntaxError: already declared\n at x:1")
        body = {"messages": [{"role": "user", "content": "go"}], "tool_choice": "required"}
        proxy._maybe_inject_error_loop_break(body, self.m)
        sysmsg = body["messages"][0]
        self.assertEqual(sysmsg["role"], "system")
        self.assertIn("SAME failure", sysmsg["content"])
        self.assertIn("re-read", sysmsg["content"].lower())
        # advisory: does NOT release tool_choice
        self.assertEqual(body["tool_choice"], "required")
        self.assertEqual(self.m.error_loop_fires, 1)

    def test_no_nudge_below_threshold(self):
        self.m.note_tool_result_error("Error: once\n at x:1")
        body = {"messages": [{"role": "user", "content": "go"}]}
        proxy._maybe_inject_error_loop_break(body, self.m)
        self.assertEqual(len(body["messages"]), 1)  # unchanged
        self.assertEqual(self.m.error_loop_fires, 0)


if __name__ == "__main__":
    unittest.main()
