#!/usr/bin/env python3
"""Unit tests for the DOUBLING-DOWN guardrail ("never go full").

Regression class: the model re-issues the EXACT same tool call while it keeps
failing -- going all-in on one approach. ERROR-LOOP only catches the inverse
shape (varied edits, same error signature) and the identical-call cycle
detector ignores results entirely, so a same-call run whose error text VARIES
turn to turn (rate limits, timeouts, flaky tests) slipped through every
guardrail (observed live: a rate-limited GitHub API hammered in a loop). The
doubling-down breaker pairs the call fingerprint with its result and, after N
consecutive failed retries of the same call, injects a pivot directive.
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

FAIL = "Error: rate limit exceeded for url"
FAIL_OTHER = "TypeError: cannot read properties of undefined"
OK = "all files written successfully"


class TestDoublingStreakAccounting(unittest.TestCase):
    def test_same_failing_call_increments(self):
        mon = proxy.SessionMonitor()
        for expected in (1, 2, 3):
            mon.note_doubling_signal("Bash:abcd1234", FAIL)
            self.assertEqual(mon.doubling_streak, expected)

    def test_varied_error_text_still_counts(self):
        # THE gap this guard closes: same call, different error each time.
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("Bash:abcd1234", FAIL_OTHER)
        mon.note_doubling_signal("Bash:abcd1234", "fatal: connection timed out")
        self.assertEqual(mon.doubling_streak, 3)

    def test_different_call_resets(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("Bash:ffff0000", FAIL)
        self.assertEqual(mon.doubling_streak, 1)
        self.assertEqual(mon.doubling_fp, "Bash:ffff0000")

    def test_success_resets(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("Bash:abcd1234", OK)
        self.assertEqual(mon.doubling_streak, 0)

    def test_no_tool_turn_resets(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("", FAIL)
        self.assertEqual(mon.doubling_streak, 0)

    def test_should_force_at_threshold(self):
        mon = proxy.SessionMonitor()
        for _ in range(proxy.PROXY_DOUBLING_THRESHOLD):
            mon.note_doubling_signal("Bash:abcd1234", FAIL)
        should, reason = mon.should_force_doubling_break()
        self.assertTrue(should)
        self.assertIn("retried", reason)

    def test_below_threshold_does_not_force(self):
        mon = proxy.SessionMonitor()
        for _ in range(proxy.PROXY_DOUBLING_THRESHOLD - 1):
            mon.note_doubling_signal("Bash:abcd1234", FAIL)
        should, _ = mon.should_force_doubling_break()
        self.assertFalse(should)

    def test_resent_transcript_does_not_inflate(self):
        # A client retry (5xx / stream abort) re-sends the same trailing
        # (call, result) pair without the conversation growing.
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL, msg_count=10)
        mon.note_doubling_signal("Bash:abcd1234", FAIL, msg_count=10)
        mon.note_doubling_signal("Bash:abcd1234", FAIL, msg_count=10)
        self.assertEqual(mon.doubling_streak, 1)
        mon.note_doubling_signal("Bash:abcd1234", FAIL, msg_count=12)
        self.assertEqual(mon.doubling_streak, 2)

    def test_is_error_flag_counts_without_keywords(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", "done", result_error=True)
        mon.note_doubling_signal("Bash:abcd1234", "done", result_error=True)
        self.assertEqual(mon.doubling_streak, 2)

    def test_is_error_false_beats_error_looking_text(self):
        # grep output legitimately containing "undefined" is a SUCCESS when the
        # client says so -- the explicit flag wins over keyword heuristics.
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.note_doubling_signal("Bash:abcd1234", "undefined symbol listing", result_error=False)
        self.assertEqual(mon.doubling_streak, 0)

    def test_raw_rate_limit_body_counts_as_failure(self):
        # The motivating incident: GitHub's raw body has none of the generic
        # error keywords.
        mon = proxy.SessionMonitor()
        body = '{"message": "API rate limit exceeded for 1.2.3.4"}'
        mon.note_doubling_signal("Bash:abcd1234", body)
        mon.note_doubling_signal("Bash:abcd1234", body)
        self.assertEqual(mon.doubling_streak, 2)

    def test_reset_doubling_clears_state(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        mon.reset_doubling()
        self.assertEqual(mon.doubling_streak, 0)
        self.assertEqual(mon.doubling_fp, "")


def _body():
    return {
        "tools": [{"type": "function", "function": {"name": "run_bash"}}],
        "tool_choice": "auto",
        "messages": [{"role": "system", "content": "base"}],
    }


def _saturated_monitor():
    mon = proxy.SessionMonitor()
    for _ in range(proxy.PROXY_DOUBLING_THRESHOLD):
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
    return mon


class TestDoublingInjection(unittest.TestCase):
    def test_fires_past_threshold(self):
        mon = _saturated_monitor()
        body = _body()
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(mon.doubling_break_fires, 1)
        self.assertIn("PIVOT", body["messages"][0]["content"])
        # Advisory: never touches tool_choice (unlike deferral-break).
        self.assertEqual(body["tool_choice"], "auto")

    def test_no_fire_below_threshold(self):
        mon = proxy.SessionMonitor()
        mon.note_doubling_signal("Bash:abcd1234", FAIL)
        body = _body()
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(mon.doubling_break_fires, 0)
        self.assertEqual(body["messages"][0]["content"], "base")

    def test_yields_to_stuck_break(self):
        mon = _saturated_monitor()
        mon.self_stuck_streak = 99
        body = _body()
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(mon.doubling_break_fires, 0)

    def test_yields_to_recon_convergence(self):
        mon = _saturated_monitor()
        if proxy.PROXY_RECON_CONVERGENCE_THRESHOLD <= 0:
            self.skipTest("recon-convergence disabled in this environment")
        mon.consecutive_no_write_turns = proxy.PROXY_RECON_CONVERGENCE_THRESHOLD
        body = _body()
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(mon.doubling_break_fires, 0)

    def test_yields_to_error_loop(self):
        # Lockstep case: identical call AND identical error -- ERROR-LOOP owns it.
        mon = _saturated_monitor()
        mon.error_signature_streak = proxy.PROXY_ERROR_LOOP_THRESHOLD
        body = _body()
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(mon.doubling_break_fires, 0)

    def test_inserts_system_message_when_absent(self):
        mon = _saturated_monitor()
        body = {"tools": [], "messages": [{"role": "user", "content": "hi"}]}
        proxy._maybe_inject_doubling_break(body, mon)
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertIn("PIVOT", body["messages"][0]["content"])


class TestRecordingWiring(unittest.TestCase):
    def _turn(self, command: str, result_text: str) -> dict:
        return {
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "t1",
                            "name": "run_bash",
                            "input": {"command": command},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "t1", "content": result_text}
                    ],
                },
            ]
        }

    def test_identical_failing_turns_accumulate_via_recording(self):
        mon = proxy.SessionMonitor()
        history: list = []
        for _ in range(3):
            history.extend(self._turn("curl https://api.example.com/rate-limited", FAIL)["messages"])
            proxy._record_last_assistant_tool_calls({"messages": list(history)}, mon)
        self.assertEqual(mon.doubling_streak, 3)

    def test_resent_identical_request_via_recording_counts_once(self):
        mon = proxy.SessionMonitor()
        body = self._turn("curl https://api.example.com/rate-limited", FAIL)
        proxy._record_last_assistant_tool_calls(body, mon)
        proxy._record_last_assistant_tool_calls(body, mon)  # client resend
        self.assertEqual(mon.doubling_streak, 1)

    def test_different_commands_do_not_accumulate(self):
        mon = proxy.SessionMonitor()
        proxy._record_last_assistant_tool_calls(self._turn("cmd one", FAIL), mon)
        proxy._record_last_assistant_tool_calls(self._turn("cmd two", FAIL), mon)
        self.assertEqual(mon.doubling_streak, 1)


if __name__ == "__main__":
    unittest.main()
