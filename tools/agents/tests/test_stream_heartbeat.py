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


class TestGuardedWaitProgressLog(unittest.TestCase):
    """Journal progress during the buffered wait (2026-10-04 incident).

    A no-tool streaming turn served via the guarded path can buffer for
    minutes (live: an 11,099-token client-compaction summary over 281 s) with
    the journal silent from REQ to RESP — the proxy read as hung and the only
    evidence was the RESP timestamp. `_heartbeat_then_buffered` now logs one
    INFO line per PROXY_GUARDED_WAIT_LOG_SECS of waiting so a long buffered
    generation is legible while it happens.
    """

    def setUp(self):
        self._hb = proxy.PROXY_STREAM_HEARTBEAT_SECS
        self._log_secs = proxy.PROXY_GUARDED_WAIT_LOG_SECS
        proxy.PROXY_STREAM_HEARTBEAT_SECS = 0.05
        proxy.PROXY_GUARDED_WAIT_LOG_SECS = 0.06

    def tearDown(self):
        proxy.PROXY_STREAM_HEARTBEAT_SECS = self._hb
        proxy.PROXY_GUARDED_WAIT_LOG_SECS = self._log_secs

    @staticmethod
    def _response():
        return {
            "id": "msg_z",
            "model": "m",
            "content": [{"type": "text", "text": "done"}],
            "stop_reason": "end_turn",
            "usage": {"output_tokens": 1},
        }

    def test_slow_produce_logs_wait_progress(self):
        async def produce():
            await asyncio.sleep(0.2)  # > 2 log boundaries at 0.06s
            return self._response()

        with self.assertLogs("uap.anthropic_proxy", level="INFO") as cm:
            out = "".join(asyncio.run(_collect(produce())))
        self.assertIn("done", out)  # stream still completes normally
        wait_logs = [l for l in cm.output if "GUARDED-BUFFER WAIT" in l]
        self.assertGreaterEqual(len(wait_logs), 2)
        self.assertIn("still generating after", wait_logs[0])
        self.assertIn("test-model", wait_logs[0])

    def test_progress_logs_once_per_boundary_not_per_heartbeat(self):
        async def produce():
            await asyncio.sleep(0.22)  # ~4 heartbeats, ~3 boundaries
            return self._response()

        with self.assertLogs("uap.anthropic_proxy", level="INFO") as cm:
            asyncio.run(_collect(produce()))
        wait_logs = [l for l in cm.output if "GUARDED-BUFFER WAIT" in l]
        # 0.22s of waiting at 0.06s boundaries: 2-4 lines, one per boundary
        # crossed — NOT one per 0.05s heartbeat.
        self.assertGreaterEqual(len(wait_logs), 2)
        self.assertLessEqual(len(wait_logs), 4)

    def test_fast_produce_logs_no_wait_progress(self):
        async def produce():
            return self._response()

        with self.assertNoLogs("uap.anthropic_proxy", level="INFO"):
            out = "".join(asyncio.run(_collect(produce())))
        self.assertIn("done", out)

    def test_wait_progress_log_disabled(self):
        proxy.PROXY_GUARDED_WAIT_LOG_SECS = 0.0

        async def produce():
            await asyncio.sleep(0.15)
            return self._response()

        with self.assertNoLogs("uap.anthropic_proxy", level="INFO"):
            out = "".join(asyncio.run(_collect(produce())))
        self.assertIn("done", out)


if __name__ == "__main__":
    unittest.main()
