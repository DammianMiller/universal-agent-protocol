#!/usr/bin/env python3
"""Unit tests for the DEFERRAL-BREAK guardrail (Fix A) and the no-tool-turn
recon-convergence counting (Fix B).

Regression: a model could end a turn with plain prose that DEFERS the work --
"I need more exploration cycles to complete the plan" -- with no tool call. That
stall was invisible to STUCK-BREAK (not a loop-admission phrase) and to
recon-convergence (a no-tool turn never advanced its streak), so it silently
halted a hands-free build. The deferral-break detects the no-tool capitulation
and forces the next turn to take a concrete action; Fix B makes prose-only turns
count toward convergence so prolonged stalls also escalate.
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


class TestDeferralPhraseRegex(unittest.TestCase):
    def test_matches_the_reported_stall(self):
        self.assertTrue(
            proxy._DEFERRAL_PHRASE_RE.search(
                "I need more exploration cycles to complete the plan. "
            )
        )

    def test_matches_close_kin(self):
        for s in (
            "Let me continue exploring the codebase before I proceed.",
            "I'll need a few more passes to complete the plan.",
            "I need to gather more research before writing anything.",
            "Once I have explored more, I can start.",
        ):
            self.assertTrue(proxy._DEFERRAL_PHRASE_RE.search(s), s)

    def test_does_not_match_progress_narration(self):
        for s in (
            "Done. I created src/index.ts and wired the routes.",
            "Here is the summary of what I built.",
            "Running the tests now.",
            "The build passes and all items are complete.",
        ):
            self.assertIsNone(proxy._DEFERRAL_PHRASE_RE.search(s), s)

    def test_does_not_match_generic_time_or_steps_question(self):
        # A legitimate clarifying question must not trip the guard (was a false
        # positive when bare "time"/"steps" were object tokens).
        for s in (
            "I need more time to review your requirements — could you clarify X?",
            "There are a few more steps, let me know which environment to target.",
        ):
            self.assertIsNone(proxy._DEFERRAL_PHRASE_RE.search(s), s)


class TestDeferralStreak(unittest.TestCase):
    def test_no_tool_deferral_increments_and_fires(self):
        mon = proxy.SessionMonitor()
        mon.note_deferral_signal(
            "I need more exploration cycles to complete the plan.", had_tool_call=False
        )
        self.assertEqual(mon.deferral_streak, 1)
        should, reason = mon.should_force_deferral_break()
        self.assertTrue(should)
        self.assertIn("deferral", reason)

    def test_tool_call_turn_resets_streak(self):
        mon = proxy.SessionMonitor()
        mon.note_deferral_signal("let me continue exploring", had_tool_call=False)
        self.assertEqual(mon.deferral_streak, 1)
        # Model actually acted this turn -> not deferring anymore.
        mon.note_deferral_signal("let me continue exploring", had_tool_call=True)
        self.assertEqual(mon.deferral_streak, 0)
        self.assertFalse(mon.should_force_deferral_break()[0])

    def test_non_matching_text_resets_streak(self):
        mon = proxy.SessionMonitor()
        mon.note_deferral_signal("I need more cycles", had_tool_call=False)
        self.assertEqual(mon.deferral_streak, 1)
        mon.note_deferral_signal("All done, files written.", had_tool_call=False)
        self.assertEqual(mon.deferral_streak, 0)


class TestDeferralInjection(unittest.TestCase):
    def test_forces_tool_choice_and_directive(self):
        mon = proxy.SessionMonitor()
        mon.note_deferral_signal("I need more exploration cycles", had_tool_call=False)
        body = {
            "tools": [{"function": {"name": "Write"}}],
            "tool_choice": "auto",
            "messages": [{"role": "system", "content": "sys"}],
        }
        proxy._maybe_inject_deferral_break(body, mon)
        self.assertEqual(body["tool_choice"], "required")
        self.assertIn("CONTINUE AUTONOMOUSLY", body["messages"][0]["content"])
        self.assertEqual(mon.deferral_break_fires, 1)

    def test_does_not_fire_below_threshold(self):
        mon = proxy.SessionMonitor()  # streak 0
        body = {"tools": [{"function": {"name": "Write"}}], "tool_choice": "auto", "messages": []}
        proxy._maybe_inject_deferral_break(body, mon)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(mon.deferral_break_fires, 0)

    def test_yields_to_stuck_break(self):
        mon = proxy.SessionMonitor()
        mon.deferral_streak = 5
        mon.self_stuck_streak = 99  # stuck-break will fire this turn
        body = {"tools": [{"function": {"name": "Write"}}], "tool_choice": "auto", "messages": []}
        proxy._maybe_inject_deferral_break(body, mon)
        # deferral defers to the more-urgent stuck-break (prose exit).
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(mon.deferral_break_fires, 0)

    def test_disabled_when_off(self):
        mon = proxy.SessionMonitor()
        # Simulate the phrase but with the guard disabled.
        original = proxy.PROXY_DEFERRAL_BREAK
        try:
            proxy.PROXY_DEFERRAL_BREAK = False
            mon.note_deferral_signal("I need more exploration cycles", had_tool_call=False)
            self.assertEqual(mon.deferral_streak, 0)
            self.assertFalse(mon.should_force_deferral_break()[0])
        finally:
            proxy.PROXY_DEFERRAL_BREAK = original


class TestDeferralYieldsAndToolAbsence(unittest.TestCase):
    def test_yields_to_recon_convergence(self):
        mon = proxy.SessionMonitor()
        mon.deferral_streak = 5
        # Push the no-write streak into recon-convergence territory.
        mon.consecutive_no_write_turns = proxy.PROXY_RECON_CONVERGENCE_THRESHOLD
        body = {
            "tools": [{"function": {"name": "Write"}}],
            "tool_choice": "auto",
            "messages": [],
        }
        proxy._maybe_inject_deferral_break(body, mon)
        # recon owns the turn -> deferral must not fire or touch tool_choice.
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(mon.deferral_break_fires, 0)

    def test_no_tools_injects_directive_but_leaves_tool_choice(self):
        mon = proxy.SessionMonitor()
        mon.deferral_streak = 1  # recon NOT pending (streak stays 0)
        body = {"tools": [], "tool_choice": "auto", "messages": []}
        proxy._maybe_inject_deferral_break(body, mon)
        # No tools to force, so tool_choice is left as-is, but the directive and
        # the telemetry counter still apply (the nudge is still worth sending).
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(mon.deferral_break_fires, 1)
        self.assertIn("CONTINUE AUTONOMOUSLY", body["messages"][0]["content"])


class TestNoToolTurnConvergence(unittest.TestCase):
    def test_no_tool_turn_advances_convergence_streak(self):
        mon = proxy.SessionMonitor()
        before = mon.consecutive_no_write_turns
        mon.note_no_tool_turn()
        mon.note_no_tool_turn()
        self.assertEqual(mon.consecutive_no_write_turns, before + 2)


if __name__ == "__main__":
    unittest.main()
