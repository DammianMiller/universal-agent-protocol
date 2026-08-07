#!/usr/bin/env python3
"""A tool call that keeps SUCCEEDING can loop forever, and every guard missed it.

Observed live (opencode + qwen3.6, 2026-08-07): `git diff --stat` re-issued 44
times in one run, ~2.5s apart, until the operator interrupted. On screen it
reads as the final message repeating without end.

Each existing guard declined it for a defensible reason:

  STUCK-BREAK   wants self-reported "stuck" phrasing, or an `api.github.com`
                argument. The model said nothing and this is a git command.
  ERROR-LOOP    wants a repeated tool-RESULT error signature. This call works.
  LOOP BREAKER  does detect the identical fingerprint, but ANDs it with
                `no_progress_streak` — and a command that returns output every
                time never accumulates one, so the condition never held.

The blind spot is a repeatedly-SUCCESSFUL identical call: the other guards all
key off failure or self-awareness, and this loop has neither. So this guard
fires on the fingerprint alone, at 4, independent of outcome.
"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

PROXY = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"


def load_proxy(env: dict | None = None):
    """Import the proxy module with a chosen env (thresholds are read at import)."""
    saved = dict(os.environ)
    os.environ.update(env or {})
    try:
        spec = importlib.util.spec_from_file_location(f"proxy_{len(sys.modules)}", PROXY)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        os.environ.clear()
        os.environ.update(saved)


class TestRepeatCallGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proxy = load_proxy()

    def monitor(self):
        return self.proxy.SessionMonitor(context_window=100000)

    def record(self, mon, fingerprint, times):
        for _ in range(times):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint=fingerprint)

    def test_the_observed_loop_is_caught(self):
        # The real thing: same tool, same args, succeeding every time.
        mon = self.monitor()
        self.record(mon, "Bash|git diff --stat", 4)
        should, reason = mon.should_force_stuck_break()
        self.assertTrue(should, "4 identical successful calls must break the loop")
        self.assertIn("identical tool call", reason)

    def test_three_identical_calls_are_left_alone(self):
        # Repetition is not automatically a loop — a couple of retries is normal.
        mon = self.monitor()
        self.record(mon, "Bash|git diff --stat", 3)
        should, _ = mon.should_force_stuck_break()
        self.assertFalse(should)

    def test_no_progress_streak_is_NOT_required(self):
        # The precise reason the existing LOOP BREAKER never fired: a succeeding
        # command leaves no_progress_streak at 0 forever.
        mon = self.monitor()
        self.record(mon, "Bash|git diff --stat", 6)
        self.assertEqual(mon.no_progress_streak, 0)
        should, _ = mon.should_force_stuck_break()
        self.assertTrue(should)

    def test_varied_calls_do_not_trip_it(self):
        # Ordinary agentic work: different tools, different arguments.
        mon = self.monitor()
        for fp in ("Bash|ls", "Read|a.ts", "Bash|npm test", "Edit|a.ts", "Bash|git status"):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint=fp)
        should, _ = mon.should_force_stuck_break()
        self.assertFalse(should)

    def test_a_broken_streak_resets_it(self):
        # Three repeats, something else, three repeats — not a loop.
        mon = self.monitor()
        self.record(mon, "Bash|git diff --stat", 3)
        mon.record_tool_calls(tool_names=["Read"], fingerprint="Read|src/index.ts")
        self.record(mon, "Bash|git diff --stat", 3)
        should, _ = mon.should_force_stuck_break()
        self.assertFalse(should)

    def test_the_guard_can_be_disabled(self):
        proxy = load_proxy({"PROXY_REPEAT_CALL_THRESHOLD": "0"})
        mon = proxy.SessionMonitor(context_window=100000)
        for _ in range(12):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint="Bash|git diff --stat")
        should, _ = mon.should_force_stuck_break()
        self.assertFalse(should, "PROXY_REPEAT_CALL_THRESHOLD=0 must disable it")

    def test_existing_stuck_signals_still_work(self):
        # The new branch must not shadow the two guards that were already there.
        mon = self.monitor()
        for _ in range(self.proxy.PROXY_STUCK_TEXT_THRESHOLD):
            mon.note_assistant_text("I've been stuck in a loop, let me break out")
        should, reason = mon.should_force_stuck_break()
        self.assertTrue(should)
        self.assertIn("self-reported", reason)


class TestDirectiveMatchesTheFailure(unittest.TestCase):
    """A succeeding loop must not be told to stop retrying 'a failing action'."""

    @classmethod
    def setUpClass(cls):
        cls.proxy = load_proxy()

    def inject(self, mon):
        body = {"messages": [{"role": "system", "content": "base"}], "tool_choice": "required"}
        self.proxy._maybe_inject_stuck_break(body, mon)
        return body

    def test_repeat_loop_gets_the_right_words(self):
        mon = self.proxy.SessionMonitor(context_window=100000)
        for _ in range(4):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint="Bash|git diff --stat")
        text = self.inject(mon)["messages"][0]["content"]
        self.assertIn("SUCCEEDED each time", text)
        self.assertIn("will not change", text)
        # Wrong-diagnosis wording from the other branch must not appear.
        self.assertNotIn("failing action", text)
        self.assertNotIn("api.github.com", text)

    def test_tool_choice_is_released_so_a_text_turn_is_possible(self):
        # Without this the model is still coerced into calling a tool, which is
        # the loop it is being asked to leave.
        mon = self.proxy.SessionMonitor(context_window=100000)
        for _ in range(4):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint="Bash|git diff --stat")
        self.assertEqual(self.inject(mon)["tool_choice"], "auto")

    def test_failing_loop_keeps_its_original_directive(self):
        mon = self.proxy.SessionMonitor(context_window=100000)
        for _ in range(self.proxy.PROXY_STUCK_API_THRESHOLD):
            mon.note_tool_arg_hosts(["https://api.github.com/repos/x/y"])
        text = self.inject(mon)["messages"][0]["content"]
        self.assertIn("failing action", text)


if __name__ == "__main__":
    unittest.main()


class TestStreakSurvivesAFreshMonitor(unittest.TestCase):
    """The guards counted server-side state that silently resets.

    The monitor is keyed `fp:<hash of the first user message>` when the client
    sends no session header — and opencode sends none. Compaction, a re-summarised
    opening turn, or a proxy restart therefore starts a FRESH monitor with empty
    history, and every streak restarts at zero no matter how long the real loop is.

    The conversation is re-sent whole each turn, so the streak is derivable from
    the request. These tests pin that.
    """

    @classmethod
    def setUpClass(cls):
        cls.proxy = load_proxy()

    @staticmethod
    def convo(n, cmd="git diff --stat"):
        """A conversation containing `n` identical assistant tool calls."""
        msgs = [{"role": "user", "content": "check the diff"}]
        for i in range(n):
            msgs.append({"role": "assistant", "content": [
                {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {"command": cmd}}]})
            msgs.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": f"t{i}", "content": "1 file changed"}]})
        return msgs

    def test_a_fresh_monitor_still_sees_the_loop(self):
        # THE RESIDUAL: brand-new monitor, 44-turn loop already in the transcript.
        mon = self.proxy.SessionMonitor(context_window=100000)
        self.assertEqual(mon.tool_call_history, [])
        self.proxy._seed_tool_history_from_request(mon, self.convo(44))
        should, reason = mon.should_force_stuck_break()
        self.assertTrue(should, "a reset monitor must not erase a live loop")
        self.assertIn("identical tool call", reason)

    def test_it_only_extends_never_double_counts(self):
        # The incremental path appends one fingerprint per request; seeding must
        # not stack on top of that and inflate the streak.
        mon = self.proxy.SessionMonitor(context_window=100000)
        for _ in range(6):
            mon.record_tool_calls(tool_names=["Bash"], fingerprint="Bash|x")
        before = list(mon.tool_call_history)
        self.proxy._seed_tool_history_from_request(mon, self.convo(2))
        self.assertEqual(mon.tool_call_history, before)

    def test_varied_history_is_reconstructed_without_tripping(self):
        mon = self.proxy.SessionMonitor(context_window=100000)
        msgs = [{"role": "user", "content": "go"}]
        for i, cmd in enumerate(["ls", "npm test", "git status", "npm run build", "ls -la"]):
            msgs.append({"role": "assistant", "content": [
                {"type": "tool_use", "id": f"t{i}", "name": "Bash", "input": {"command": cmd}}]})
        self.proxy._seed_tool_history_from_request(mon, msgs)
        # 5 assistant turns, 4 seeded: the last is deliberately left for the
        # incremental path to append, so the current turn is not counted twice.
        self.assertEqual(len(mon.tool_call_history), 4)
        should, _ = mon.should_force_stuck_break()
        self.assertFalse(should)

    def test_it_is_bounded(self):
        mon = self.proxy.SessionMonitor(context_window=100000)
        self.proxy._seed_tool_history_from_request(mon, self.convo(200))
        self.assertLessEqual(len(mon.tool_call_history), 30)

    def test_malformed_input_is_survivable(self):
        mon = self.proxy.SessionMonitor(context_window=100000)
        for bad in (None, "not-a-list", [], [None, 3, {"role": "assistant"}],
                    [{"role": "assistant", "content": "plain text"}]):
            self.proxy._seed_tool_history_from_request(mon, bad)
        self.assertEqual(mon.tool_call_history, [])
