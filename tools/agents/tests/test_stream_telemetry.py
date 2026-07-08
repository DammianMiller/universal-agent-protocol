"""The TRUE streaming path must record per-project telemetry.

Regression for the frozen-dashboard incident (2026-07-08): the only
_record_project_telemetry call sites were on the non-stream / guarded
non-stream paths, so streaming sessions (the client default) wrote no
task_outcomes rows and per-project dashboards showed static data forever.
"""
import asyncio
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


class FakeOpenAIStream:
    """Minimal httpx.Response stand-in: yields OpenAI SSE lines."""

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        pass


OPENAI_LINES = [
    'data: {"choices": [{"delta": {"content": "hello"}, "finish_reason": null}]}',
    'data: {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 456, "completion_tokens": 5}}',
    "data: [DONE]",
]


class StreamTelemetryTest(unittest.TestCase):
    def _drive(self, body):
        monitor = ap.SessionMonitor()
        monitor.last_input_tokens = 123
        recorded = []
        saved = ap._record_project_telemetry
        ap._record_project_telemetry = lambda b, m, u: recorded.append((b, m, u))
        try:
            gen = ap.stream_anthropic_response(
                FakeOpenAIStream(OPENAI_LINES), "test-model", monitor, body
            )

            async def consume():
                return [frame async for frame in gen]

            frames = asyncio.run(consume())
        finally:
            ap._record_project_telemetry = saved
        return frames, recorded

    def test_streaming_response_records_project_telemetry(self):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        frames, recorded = self._drive(body)
        self.assertTrue(any("message_stop" in f for f in frames))
        self.assertEqual(len(recorded), 1)
        recorded_body, model, usage = recorded[0]
        self.assertIs(recorded_body, body)
        self.assertEqual(model, "test-model")
        # Upstream's final usage chunk wins over the request-side estimate and
        # the per-delta chunk counter (which misses tool-call turns).
        self.assertEqual(usage.get("input_tokens"), 456)
        self.assertEqual(usage.get("output_tokens"), 5)

    def test_telemetry_recorded_after_client_visible_stream_end(self):
        # The recorder must not delay or reorder client frames: message_stop is
        # emitted before the telemetry write happens.
        frames, recorded = self._drive({"messages": []})
        self.assertIn("message_stop", frames[-1])
        self.assertEqual(len(recorded), 1)


if __name__ == "__main__":
    unittest.main()
