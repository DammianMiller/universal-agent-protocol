"""Tests for R4: early coordination-loop ban (independent of active-loop)."""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


class EarlyCoordinationBanTest(unittest.TestCase):
    def test_config_default(self):
        self.assertEqual(ap.PROXY_COORDINATION_EARLY_BAN, 3)

    def test_identical_coordination_repeats_get_banned(self):
        m = ap.SessionMonitor(context_window=132096)
        fp = "TaskCreate:deadbeef"
        for _ in range(3):
            m.record_tool_calls(["TaskCreate"], fingerprint=fp)
        self.assertIn("TaskCreate", m.session_banned_tools)

    def test_two_repeats_not_yet_banned(self):
        m = ap.SessionMonitor(context_window=132096)
        for _ in range(2):
            m.record_tool_calls(["TaskCreate"], fingerprint="TaskCreate:x")
        self.assertNotIn("TaskCreate", m.session_banned_tools)

    def test_non_coordination_tool_not_banned(self):
        m = ap.SessionMonitor(context_window=132096)
        for _ in range(5):
            m.record_tool_calls(["Bash"], fingerprint="Bash:same")
        self.assertNotIn("Bash", m.session_banned_tools)

    def test_varying_args_reset_streak(self):
        m = ap.SessionMonitor(context_window=132096)
        for i in range(5):
            m.record_tool_calls(["TaskCreate"], fingerprint=f"TaskCreate:{i}")
        self.assertNotIn("TaskCreate", m.session_banned_tools)


if __name__ == "__main__":
    unittest.main()
