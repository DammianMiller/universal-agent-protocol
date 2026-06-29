"""Tests for #4: coordination-tool no-op loop suppression (faster ban).

A pure-bookkeeping tool that cycles (e.g. TaskUpdate) is banned after
PROXY_COORDINATION_BAN_THRESHOLD (2) cycle detections, while a generic tool
keeps the original threshold of 3. Banning removes the tool from the offered
set, physically breaking the "update the task instead of doing the work" loop.
"""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


def _cycling_body(tool="TaskUpdate"):
    # >= PROXY_TOOL_STATE_MIN_MESSAGES (6) messages, last user message carries a
    # tool_result -> active agentic loop.
    msgs = [{"role": "user", "content": "do the task"}]
    for i in range(3):
        msgs.append({"role": "assistant", "content": [
            {"type": "tool_use", "id": f"t{i}", "name": tool, "input": {}}]})
        msgs.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{i}", "content": "ok"}]})
    return {"messages": msgs}


def _drive_one_cycle(monitor, tool):
    """Put the monitor in act-phase with a detected cycle of `tool` and run the
    state-machine resolver once (which runs the ban loop)."""
    fp = f"{tool}:deadbeef"
    monitor.tool_turn_phase = "act"
    monitor.tool_state_forced_budget_remaining = 5
    monitor.tool_state_review_cycles = 0
    win = max(2, ap.PROXY_TOOL_STATE_CYCLE_WINDOW)
    monitor.tool_call_history = [fp] * (win + 2)
    monitor.last_tool_fingerprint = fp
    monitor.tool_state_stagnation_streak = max(1, ap.PROXY_TOOL_STATE_STAGNATION_THRESHOLD)
    ap._resolve_state_machine_tool_choice(
        _cycling_body(tool), monitor, has_tool_results=True, last_user_has_tool_result=True
    )


class CoordinationBanTest(unittest.TestCase):
    def test_config_defaults(self):
        self.assertIn("TaskUpdate", ap.PROXY_COORDINATION_TOOLS)
        self.assertEqual(ap.PROXY_COORDINATION_BAN_THRESHOLD, 2)

    def test_coordination_tool_banned_after_two_cycles(self):
        m = ap.SessionMonitor(context_window=132096)
        _drive_one_cycle(m, "TaskUpdate")
        self.assertNotIn("TaskUpdate", m.session_banned_tools, "should not ban after 1 cycle")
        _drive_one_cycle(m, "TaskUpdate")
        self.assertIn("TaskUpdate", m.session_banned_tools, "should ban after 2 cycles (coordination)")

    def test_generic_tool_needs_three_cycles(self):
        m = ap.SessionMonitor(context_window=132096)
        for _ in range(2):
            _drive_one_cycle(m, "glob")
        self.assertNotIn("glob", m.session_banned_tools, "generic tool must NOT ban at 2")
        _drive_one_cycle(m, "glob")
        self.assertIn("glob", m.session_banned_tools, "generic tool bans at 3")


if __name__ == "__main__":
    unittest.main()
