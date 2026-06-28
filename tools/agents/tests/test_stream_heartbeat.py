#!/usr/bin/env python3
"""Streaming keep-alive heartbeat for the guarded-non-stream path.

The guarded-non-stream path buffers the ENTIRE upstream generation before
emitting any SSE bytes, so a long generation sends the client nothing for the
whole wait and the client's streaming idle-timeout fires -> "API Error".

`_heartbeat_then_buffered` wraps the buffered produce coroutine: it emits an
immediate `message_start`, then `ping` events every PROXY_STREAM_HEARTBEAT_SECS
while the produce runs, then streams the buffered content (without a second
message_start). On an error it re-emits the guarded path's error Response as an
SSE `error` event (the stream has already committed to HTTP 200).
"""

import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()


async def _collect(produce_coro, model="test-model"):
    return [chunk async for chunk in proxy._heartbeat_then_buffered(produce_coro, model)]


class TestStreamHeartbeat(unittest.TestCase):
    def setUp(self):
        # small interval so the slow-produce test emits pings quickly
        self._orig = proxy.PROXY_STREAM_HEARTBEAT_SECS
        proxy.PROXY_STREAM_HEARTBEAT_SECS = 0.05

    def tearDown(self):
        proxy.PROXY_STREAM_HEARTBEAT_SECS = self._orig

    def test_fast_produce_no_pings_single_message_start(self):
        async def produce():
            return {
                "id": "msg_x",
                "model": "m",
                "content": [{"type": "text", "text": "hi"}],
                "stop_reason": "end_turn",
                "usage": {"output_tokens": 1},
            }

        out = "".join(asyncio.run(_collect(produce())))
        # exactly one message_start (heartbeat's own; converter skips its own)
        self.assertEqual(out.count("event: message_start"), 1)
        self.assertNotIn("event: ping", out)
        self.assertIn("hi", out)
        self.assertIn("event: message_stop", out)
        self.assertNotIn("event: error", out)

    def test_slow_produce_emits_pings_then_content(self):
        async def produce():
            await asyncio.sleep(0.18)  # > 3 intervals
            return {
                "id": "msg_y",
                "model": "m",
                "content": [{"type": "text", "text": "done"}],
                "stop_reason": "end_turn",
                "usage": {"output_tokens": 1},
            }

        chunks = asyncio.run(_collect(produce()))
        out = "".join(chunks)
        self.assertEqual(out.count("event: message_start"), 1)
        self.assertGreaterEqual(out.count("event: ping"), 1)
        self.assertIn("done", out)
        # message_start precedes the first ping, ping precedes content
        self.assertLess(out.index("event: message_start"), out.index("event: ping"))
        self.assertLess(out.index("event: ping"), out.index("done"))

    def test_error_response_becomes_sse_error_event(self):
        import json

        async def produce():
            return proxy.Response(
                content=json.dumps(
                    {"type": "error", "error": {"type": "overloaded_error", "message": "boom"}}
                ),
                status_code=529,
                media_type="application/json",
            )

        out = "".join(asyncio.run(_collect(produce())))
        self.assertEqual(out.count("event: message_start"), 1)
        self.assertIn("event: error", out)
        self.assertIn("boom", out)
        self.assertNotIn("event: message_stop", out)

    def test_produce_raises_becomes_sse_error_event(self):
        async def produce():
            raise RuntimeError("kaboom")

        out = "".join(asyncio.run(_collect(produce())))
        self.assertIn("event: error", out)
        self.assertIn("kaboom", out)


if __name__ == "__main__":
    unittest.main()
