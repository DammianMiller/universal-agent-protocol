#!/usr/bin/env python3
"""Unit tests for cycle-break tool narrowing preserving the exploration escape hatch.

Regression: the CYCLE BREAK narrowing removed every cycling tool by name (and the
whole read-only class if any cycling tool was read-only). Because Bash can be a
cycling tool, the agent lost the Bash tool entirely and could no longer run any
bash command to explore the filesystem. The narrowing must keep the open-ended
exploration escape hatch (Bash/WebFetch/Agent) available so the agent can make a
DIFFERENT move — the cycle *hint* handles "vary the command".
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


def _tools(*names):
    return [{"function": {"name": n}} for n in names]


def _names(tools):
    return sorted(t["function"]["name"] for t in tools)


class TestCycleBreakExploration(unittest.TestCase):
    def test_cycling_bash_keeps_bash(self):
        """The core bug: cycling on Bash must NOT remove the Bash tool."""
        tools = _tools("Bash", "Read", "Write")
        narrowed, expanded = proxy._narrow_tools_for_cycle_break(tools, {"Bash"}, set())
        self.assertIn("Bash", _names(narrowed))
        self.assertFalse(expanded)  # Bash is not read-only, so no class expansion

    def test_read_only_cycle_expands_class_but_keeps_exploration(self):
        """Cycling a read-only tool drops the whole read-only class, yet the
        exploration escape hatch (Bash/WebFetch/Agent) survives."""
        tools = _tools("Read", "Grep", "Glob", "Bash", "WebFetch", "Agent", "Write")
        narrowed, expanded = proxy._narrow_tools_for_cycle_break(tools, {"Grep"}, set())
        self.assertTrue(expanded)
        kept = _names(narrowed)
        # read-only class dropped
        for n in ("Read", "Grep", "Glob"):
            self.assertNotIn(n, kept)
        # exploration escape hatch + writes preserved
        for n in ("Bash", "WebFetch", "Agent", "Write"):
            self.assertIn(n, kept)

    def test_session_ban_is_honored_even_for_exploration_tools(self):
        """An explicit session ban is a stronger, deliberate signal than cycling
        and IS honored — even for an exploration tool. (Only the cycling path
        preserves the escape hatch.)"""
        tools = _tools("Bash", "Read", "Write")
        narrowed, _ = proxy._narrow_tools_for_cycle_break(tools, set(), {"Bash"})
        self.assertNotIn("Bash", _names(narrowed))

    def test_cycling_bash_kept_even_when_another_tool_is_banned(self):
        """A cycling Bash is preserved even while an unrelated tool is banned."""
        tools = _tools("Bash", "Read", "Task")
        narrowed, _ = proxy._narrow_tools_for_cycle_break(tools, {"Bash"}, {"Task"})
        kept = _names(narrowed)
        self.assertIn("Bash", kept)       # cycling exploration hatch preserved
        self.assertNotIn("Task", kept)    # explicit ban honored

    def test_case_insensitive_matching(self):
        """Lowercase 'bash' in the cycling set must still match a 'Bash' tool
        (and keep it), and 'read' must drop a 'Read' tool."""
        tools = _tools("Bash", "Read")
        narrowed, expanded = proxy._narrow_tools_for_cycle_break(
            tools, {"bash", "read"}, set()
        )
        kept = _names(narrowed)
        self.assertIn("Bash", kept)      # exploration hatch kept despite cycling
        self.assertNotIn("Read", kept)   # read-only dropped
        self.assertTrue(expanded)

    def test_floor_keeps_last_action_tool_when_ban_would_strip_it(self):
        """Floor invariant: if honoring a ban would leave NO exploration tool and
        NO write tool, keep the original set — a loop-breaker must never strand
        the agent with no way to make a different move."""
        tools = _tools("Bash", "Read")  # Read is read-only, not an action path
        narrowed, _ = proxy._narrow_tools_for_cycle_break(tools, set(), {"Bash"})
        self.assertIn("Bash", _names(narrowed))  # floor restored the escape hatch

    def test_floor_not_triggered_when_a_write_tool_survives(self):
        """The ban IS honored when another action path (a write tool) remains."""
        tools = _tools("Bash", "Read", "Write")
        narrowed, _ = proxy._narrow_tools_for_cycle_break(tools, set(), {"Bash"})
        kept = _names(narrowed)
        self.assertNotIn("Bash", kept)  # honored: Write still gives an action path
        self.assertIn("Write", kept)

    def test_tool_class_taxonomy_is_pairwise_disjoint(self):
        """Regression insurance: the three tool-class sets must never overlap, or
        convergence accounting / cycle-break scope would silently change."""
        ro = {c.lower() for c in proxy._READ_ONLY_TOOL_CLASS}
        wr = {c.lower() for c in proxy._WRITE_TOOL_CLASS}
        ex = {c.lower() for c in proxy._EXPLORATION_ESCAPE_TOOLS}
        self.assertEqual(ro & wr, set())
        self.assertEqual(ro & ex, set())
        self.assertEqual(wr & ex, set())

    def test_non_exploration_non_readonly_tool_dropped(self):
        """A cycling tool that is neither read-only nor an exploration hatch is
        dropped, and the read-only class is NOT expanded."""
        tools = _tools("SomeTool", "Read", "Bash")
        narrowed, expanded = proxy._narrow_tools_for_cycle_break(
            tools, {"SomeTool"}, set()
        )
        kept = _names(narrowed)
        self.assertNotIn("SomeTool", kept)
        self.assertIn("Read", kept)      # class not expanded, Read survives
        self.assertIn("Bash", kept)
        self.assertFalse(expanded)


class TestAutoBanExemption(unittest.TestCase):
    """The session-ban accumulator is cycling-derived (ban after N detections).
    Exploration escape-hatch tools must never be auto-banned, or the 'cannot
    explore the filesystem' bug reappears on the Nth cycle."""

    def test_bash_never_auto_banned_even_far_past_threshold(self):
        self.assertFalse(proxy._should_auto_ban("bash", cycle_count=99, ban_at=3))
        self.assertFalse(proxy._should_auto_ban("Bash", cycle_count=3, ban_at=3))

    def test_other_exploration_tools_never_auto_banned(self):
        for name in ("webfetch", "WebSearch", "agent", "task"):
            self.assertFalse(proxy._should_auto_ban(name, cycle_count=10, ban_at=3))

    def test_non_exploration_tool_banned_at_threshold(self):
        self.assertTrue(proxy._should_auto_ban("edit", cycle_count=3, ban_at=3))
        self.assertTrue(proxy._should_auto_ban("read", cycle_count=3, ban_at=3))

    def test_non_exploration_tool_not_banned_below_threshold(self):
        self.assertFalse(proxy._should_auto_ban("edit", cycle_count=2, ban_at=3))


if __name__ == "__main__":
    unittest.main()
