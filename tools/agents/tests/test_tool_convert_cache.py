"""Tests for A3: per-session tool-conversion cache."""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

TOOLS = [
    {"name": "Read", "description": "read", "input_schema": {"type": "object",
        "properties": {"p": {"type": "string", "pattern": "^/.*"}}, "required": ["p"]}},
    {"name": "Bash", "description": "run", "input_schema": {"type": "object",
        "properties": {"cmd": {"type": "string"}}}},
]


class ToolConvertCacheTest(unittest.TestCase):
    def setUp(self):
        ap._TOOL_CONVERT_CACHE.clear()

    def test_correct_conversion_and_sanitize(self):
        out = ap._convert_anthropic_tools_to_openai(TOOLS)
        self.assertEqual(out[0]["function"]["name"], "Read")
        # regex pattern field stripped by sanitize
        self.assertNotIn("pattern", out[0]["function"]["parameters"]["properties"]["p"])

    def test_second_call_is_cache_hit_same_object(self):
        a = ap._convert_anthropic_tools_to_openai(TOOLS)
        self.assertEqual(len(ap._TOOL_CONVERT_CACHE), 1)
        b = ap._convert_anthropic_tools_to_openai([dict(t) for t in TOOLS])  # equal-by-value
        self.assertIs(a, b, "identical tool set must return the cached object")

    def test_different_tools_miss(self):
        ap._convert_anthropic_tools_to_openai(TOOLS)
        ap._convert_anthropic_tools_to_openai(TOOLS[:1])
        self.assertEqual(len(ap._TOOL_CONVERT_CACHE), 2)

    def test_cache_bounded(self):
        for i in range(ap._TOOL_CONVERT_CACHE_MAX + 5):
            ap._convert_anthropic_tools_to_openai(
                [{"name": f"T{i}", "description": "", "input_schema": {"type": "object"}}]
            )
        self.assertLessEqual(len(ap._TOOL_CONVERT_CACHE), ap._TOOL_CONVERT_CACHE_MAX)


if __name__ == "__main__":
    unittest.main()
