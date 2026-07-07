"""Tests for sandbox browser-tool stripping (bwrap can't reach the extension)."""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


class StripSandboxToolsTest(unittest.TestCase):
    def test_strips_browser_mcp_tools_keeps_the_rest(self):
        body = {"tools": [
            {"name": "Bash"},
            {"name": "mcp__claude-in-chrome__browser_batch"},
            {"name": "mcp__claude-in-chrome__navigate"},
            {"name": "WebFetch"},
        ]}
        removed = ap._strip_sandbox_unreachable_tools(body)
        self.assertEqual(removed, 2)
        self.assertEqual([t["name"] for t in body["tools"]], ["Bash", "WebFetch"])

    def test_keeps_all_when_no_browser_tools(self):
        body = {"tools": [{"name": "Bash"}, {"name": "WebFetch"}]}
        self.assertEqual(ap._strip_sandbox_unreachable_tools(body), 0)
        self.assertEqual(len(body["tools"]), 2)

    def test_missing_or_null_tools_is_safe(self):
        self.assertEqual(ap._strip_sandbox_unreachable_tools({}), 0)
        self.assertEqual(ap._strip_sandbox_unreachable_tools({"tools": None}), 0)
        self.assertEqual(ap._strip_sandbox_unreachable_tools({"tools": []}), 0)


if __name__ == "__main__":
    unittest.main()
