"""Tool narrowing must never strand an agent by dropping its core action tools.

Regression (hermes, 2026-08-03): _CORE_TOOL_NAMES listed only Claude Code's
canonical names, so the always-retain guard was a no-op for any other client.
Hermes sends terminal/execute_code/write_file/search_files/patch — zero overlap.
Narrowing cut 36 tools to 8, kept browser_type/clarify/cronjob and dropped
terminal AND write_file. The model tried to run `ls -la` through browser_type,
failed "no browser session" three times, CYCLE BREAK then removed browser_type
leaving 6 tools, and the session ended in 12 `clarify` calls whose text was
"I've been stuck in a loop".
"""
import importlib.util
import os
import unittest
from pathlib import Path

os.environ["PROXY_TOOL_NARROWING"] = "on"
proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


def tool(name, desc=""):
    return {"type": "function", "function": {"name": name, "description": desc}}


def body(text):
    return {"messages": [{"role": "user", "content": [{"type": "text", "text": text}]}]}


class IsCoreActionToolTest(unittest.TestCase):
    def test_claude_code_names_are_core(self):
        for n in ("Bash", "Write", "Edit", "Read", "Glob", "Grep"):
            self.assertTrue(ap._is_core_action_tool(n, ""), n)

    def test_other_clients_names_are_core(self):
        # The whole point: these are hermes/Forge names, not Claude Code's.
        for n in ("terminal", "execute_code", "write_file", "read_file",
                  "search_files", "patch", "str_replace", "run_command"):
            self.assertTrue(ap._is_core_action_tool(n, ""), n)

    def test_unknown_name_classified_from_description(self):
        # A client we have never seen still keeps the ability to act.
        self.assertTrue(ap._is_core_action_tool("zsh_exec", "Execute a shell command"))
        self.assertTrue(ap._is_core_action_tool("blob_put", "Write content to a file"))
        self.assertTrue(ap._is_core_action_tool("slurp", "Read the contents of a file"))

    def test_non_action_tools_are_not_core(self):
        # browser_type is the trap: its description says "type text", which must
        # NOT read as a file write, or the cycling tool gets pinned as core.
        self.assertFalse(ap._is_core_action_tool("browser_type", "Type text into an element on the page"))
        self.assertFalse(ap._is_core_action_tool("clarify", "Ask the user a clarifying question"))
        self.assertFalse(ap._is_core_action_tool("cronjob", "Schedule a recurring job"))
        self.assertFalse(ap._is_core_action_tool("memory", "Store or recall a memory"))
        self.assertFalse(ap._is_core_action_tool("browser_navigate", "Navigate the browser to a URL"))

    def test_empty_description_unknown_name_is_not_core(self):
        self.assertFalse(ap._is_core_action_tool("mystery", ""))


class NarrowingRetainsCoreToolsTest(unittest.TestCase):
    def hermes_surface(self):
        tools = [
            tool("terminal", "Run a shell command on the host"),
            tool("write_file", "Write content to a file at a path"),
            tool("execute_code", "Execute Python code in a sandbox"),
            tool("read_file", "Read the contents of a file"),
            tool("clarify", "Ask the user a clarifying question"),
            tool("browser_type", "Type text into an element on the page"),
            tool("cronjob", "Schedule a recurring job"),
            tool("memory", "Store or recall a memory"),
        ]
        tools += [tool(f"misc_{i}", f"Miscellaneous capability {i}") for i in range(28)]
        return tools

    def test_terminal_and_write_file_survive_narrowing(self):
        # The exact regression: a mission whose words share nothing with the
        # tool names, so lexical ranking alone promotes meta-tools.
        out = ap._narrow_tools_for_request(
            body("Build a complete vanilla JS and Canvas space shooter game"),
            self.hermes_surface(),
        )
        names = [t["function"]["name"] for t in out]
        self.assertIn("terminal", names)
        self.assertIn("write_file", names)
        self.assertIn("execute_code", names)
        self.assertLess(len(out), 36, "narrowing should still narrow")

    def test_no_recognisable_core_tool_disables_narrowing(self):
        # Fail-safe: a surface we cannot classify is one we must not prune.
        opaque = [tool(f"opaque_{i}", f"Capability {i}") for i in range(30)]
        out = ap._narrow_tools_for_request(body("do the thing"), opaque)
        self.assertEqual(len(out), len(opaque))

    def test_narrowing_still_prunes_when_core_tools_present(self):
        # The fail-safe must not become a blanket opt-out.
        out = ap._narrow_tools_for_request(body("build a game"), self.hermes_surface())
        self.assertLess(len(out), 36)


if __name__ == "__main__":
    unittest.main()
