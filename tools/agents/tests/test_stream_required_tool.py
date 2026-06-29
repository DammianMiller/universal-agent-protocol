"""Tests for A2: env-gated stream-passthrough on required-tool turns.

Default (off): a streaming required-tool turn is buffered via the guarded
non-stream path (so the tool call can be validated/repaired). When
PROXY_STREAM_REQUIRED_TOOL is on, it streams through instead. force-non-stream
and malformed-strict still buffer regardless.
"""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

TOOLS_BODY = {"tools": [{"name": "x"}], "messages": []}
REQUIRED = {"tool_choice": "required"}


class StreamRequiredToolTest(unittest.TestCase):
    def setUp(self):
        self._saved = ap.PROXY_STREAM_REQUIRED_TOOL

    def tearDown(self):
        ap.PROXY_STREAM_REQUIRED_TOOL = self._saved

    def test_default_off_buffers_required_tool_stream(self):
        ap.PROXY_STREAM_REQUIRED_TOOL = False
        self.assertTrue(
            ap._should_use_guarded_non_stream(True, TOOLS_BODY, REQUIRED),
            "default must buffer required-tool streaming turns",
        )

    def test_on_streams_required_tool_through(self):
        ap.PROXY_STREAM_REQUIRED_TOOL = True
        self.assertFalse(
            ap._should_use_guarded_non_stream(True, TOOLS_BODY, REQUIRED),
            "passthrough must NOT buffer required-tool turns when enabled",
        )

    def test_force_non_stream_still_buffers_even_when_passthrough_on(self):
        ap.PROXY_STREAM_REQUIRED_TOOL = True
        saved = ap.PROXY_FORCE_NON_STREAM
        try:
            ap.PROXY_FORCE_NON_STREAM = True
            self.assertTrue(
                ap._should_use_guarded_non_stream(True, TOOLS_BODY, REQUIRED),
                "force-non-stream overrides passthrough",
            )
        finally:
            ap.PROXY_FORCE_NON_STREAM = saved

    def test_non_stream_request_never_guarded(self):
        ap.PROXY_STREAM_REQUIRED_TOOL = False
        self.assertFalse(ap._should_use_guarded_non_stream(False, TOOLS_BODY, REQUIRED))


if __name__ == "__main__":
    unittest.main()
