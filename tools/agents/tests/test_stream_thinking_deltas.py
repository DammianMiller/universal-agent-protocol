#!/usr/bin/env python3
"""PROXY_STREAM_THINKING_DELTAS: stream reasoning_content as thinking blocks.

Regression cover for the 2026-09-05 retry livelock residue: Qwen3.8-27B on
exllamav3 reasons for 4+ minutes on some tool turns. The relay collected
`reasoning_content` but never yielded it, so the client (Factory Droid, ~300 s
stream watchdog) saw `content_block_start` then total silence, disconnected,
and retried — each retry regenerating the turn from scratch. With the flag on,
leading reasoning streams as Anthropic `thinking` blocks so the client sees
continuous activity.

The load-bearing half is block discipline: Anthropic SSE requires blocks to
open/close in index order with no deltas addressed to an unopened block, in
every layout (thinking->text, thinking->tool, text-only, reasoning-only).
"""

import asyncio
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy_think", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


class _FakeUpstreamStream:
    """Minimal streamed httpx.Response: yields pre-built OpenAI SSE deltas."""

    def __init__(self, deltas, finish_reason="stop"):
        self._deltas = list(deltas)
        self._finish_reason = finish_reason
        self.closed = False

    async def aiter_lines(self):
        for delta in self._deltas:
            yield "data: " + json.dumps({"choices": [{"delta": delta, "index": 0}]})
        yield "data: " + json.dumps(
            {"choices": [{"delta": {}, "finish_reason": self._finish_reason}]}
        )
        yield "data: [DONE]"

    async def aclose(self):
        self.closed = True


class _SlowUpstreamStream(_FakeUpstreamStream):
    """_FakeUpstreamStream with real async delays before each delta, so the
    relay's prefill-heartbeat wait (asyncio.wait timeout) actually elapses."""

    def __init__(self, deltas, finish_reason="stop", delay=0.2):
        super().__init__(deltas, finish_reason)
        self._delay = delay

    async def aiter_lines(self):
        for delta in self._deltas:
            await asyncio.sleep(self._delay)
            yield "data: " + json.dumps({"choices": [{"delta": delta, "index": 0}]})
        yield "data: " + json.dumps(
            {"choices": [{"delta": {}, "finish_reason": self._finish_reason}]}
        )
        yield "data: [DONE]"


def _drain(upstream, stream_thinking=True, heartbeat_secs=0.0):
    monitor = proxy.SessionMonitor(context_window=131072)
    body = {
        "messages": [{"role": "user", "content": "go"}],
        "tools": [
            {"name": "Bash", "description": "run", "input_schema": {"type": "object"}}
        ],
    }

    async def run():
        out = []
        with mock.patch.object(
            proxy, "PROXY_STREAM_THINKING_DELTAS", stream_thinking
        ), mock.patch.object(
            proxy, "PROXY_PREFILL_HEARTBEAT_SECS", heartbeat_secs
        ):
            async for frame in proxy.stream_anthropic_response(
                upstream, "test-model", monitor, body
            ):
                out.append(frame)
        return out

    return asyncio.run(run())


def _events(frames):
    """Parse SSE frames into a flat list of Anthropic event dicts."""
    out = []
    for frame in frames:
        for line in frame.splitlines():
            if not line.startswith("data: "):
                continue
            try:
                out.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                continue
    return out


def _assert_block_discipline(testcase, events):
    """Every opened block closes exactly once, in order, and no delta or stop
    addresses a block that is not open."""
    expected_next = 0
    open_index = None
    for ev in events:
        etype = ev.get("type")
        if etype == "content_block_start":
            testcase.assertIsNone(open_index, f"block {ev['index']} opened while {open_index} still open")
            testcase.assertEqual(ev["index"], expected_next, "blocks must open in index order")
            open_index = ev["index"]
            expected_next += 1
        elif etype == "content_block_delta":
            testcase.assertIsNotNone(open_index, "delta with no open block")
            testcase.assertEqual(ev["index"], open_index, "delta addressed to a non-open block")
        elif etype == "content_block_stop":
            testcase.assertEqual(ev["index"], open_index, "stop addressed to a non-open block")
            open_index = None
        elif etype == "message_stop":
            testcase.assertIsNone(open_index, f"block {open_index} never closed")
    return events


_DELTA_PAYLOAD_KEY = {
    "text_delta": "text",
    "thinking_delta": "thinking",
    "input_json_delta": "partial_json",
}


def _deltas_of(events, delta_type):
    key = _DELTA_PAYLOAD_KEY[delta_type]
    return [
        ev["delta"][key]
        for ev in events
        if ev.get("type") == "content_block_delta"
        and ev.get("delta", {}).get("type") == delta_type
    ]


def _block_kinds(events):
    return [
        ev["content_block"]["type"]
        for ev in events
        if ev.get("type") == "content_block_start"
    ]


class TestStreamThinkingDeltas(unittest.TestCase):
    def test_leading_reasoning_streams_as_thinking_block_then_text(self):
        upstream = _FakeUpstreamStream(
            [
                {"reasoning_content": "Let me check "},
                {"reasoning_content": "the workspace first."},
                {"content": "Looking at the workspace."},
            ]
        )
        events = _assert_block_discipline(self, _events(_drain(upstream)))

        self.assertEqual(_block_kinds(events), ["thinking", "text"])
        self.assertEqual(
            _deltas_of(events, "thinking_delta"),
            ["Let me check ", "the workspace first."],
        )
        self.assertEqual(
            _deltas_of(events, "text_delta"), ["Looking at the workspace."]
        )
        # Thinking block must be index 0, text block index 1.
        starts = [ev for ev in events if ev.get("type") == "content_block_start"]
        self.assertEqual(
            [(s["index"], s["content_block"]["type"]) for s in starts],
            [(0, "thinking"), (1, "text")],
        )

    def test_reasoning_then_tool_call_closes_thinking_first(self):
        upstream = _FakeUpstreamStream(
            [
                {"reasoning_content": "I should run pwd."},
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "toolu_abc",
                            "function": {"name": "Bash", "arguments": '{"command":'},
                        }
                    ]
                },
                {
                    "tool_calls": [
                        {"index": 0, "function": {"arguments": ' "pwd"}'}}
                    ]
                },
            ],
            finish_reason="tool_calls",
        )
        events = _assert_block_discipline(self, _events(_drain(upstream)))

        self.assertEqual(_block_kinds(events), ["thinking", "tool_use"])
        self.assertEqual(
            _deltas_of(events, "thinking_delta"), ["I should run pwd."]
        )
        args = "".join(_deltas_of(events, "input_json_delta"))
        self.assertEqual(json.loads(args), {"command": "pwd"})
        stops = [ev for ev in events if ev.get("type") == "message_delta"]
        self.assertEqual(stops[-1]["delta"]["stop_reason"], "tool_use")

    def test_flag_off_keeps_legacy_layout_and_hides_reasoning(self):
        upstream = _FakeUpstreamStream(
            [
                {"reasoning_content": "secret chain of thought"},
                {"content": "Visible answer."},
            ]
        )
        events = _assert_block_discipline(
            self, _events(_drain(upstream, stream_thinking=False))
        )

        self.assertEqual(_block_kinds(events), ["text"])
        self.assertEqual(_deltas_of(events, "thinking_delta"), [])
        self.assertEqual(_deltas_of(events, "text_delta"), ["Visible answer."])
        starts = [ev for ev in events if ev.get("type") == "content_block_start"]
        self.assertEqual(starts[0]["index"], 0)

    def test_text_only_turn_keeps_simple_layout_under_flag(self):
        upstream = _FakeUpstreamStream([{"content": "Just text."}])
        events = _assert_block_discipline(self, _events(_drain(upstream)))

        self.assertEqual(_block_kinds(events), ["text"])
        self.assertEqual(_deltas_of(events, "text_delta"), ["Just text."])
        starts = [ev for ev in events if ev.get("type") == "content_block_start"]
        self.assertEqual(starts[0]["index"], 0)

    def test_reasoning_only_turn_closes_thinking_block(self):
        """A turn that is all reasoning must still end well-formed: the
        thinking block closes (and the reasoning-fallback contract decides
        what text, if any, follows) before message_stop."""
        upstream = _FakeUpstreamStream([{"reasoning_content": "hmm"}])
        events = _assert_block_discipline(self, _events(_drain(upstream)))

        self.assertEqual(_block_kinds(events)[0], "thinking")
        self.assertEqual(_deltas_of(events, "thinking_delta"), ["hmm"])
        # Well-formed stream ends with message_delta then message_stop.
        self.assertEqual(events[-2]["type"], "message_delta")
        self.assertEqual(events[-1]["type"], "message_stop")


class TestPrefillHeartbeat(unittest.TestCase):
    """PROXY_PREFILL_HEARTBEAT_SECS: one-space thinking_deltas while the
    upstream stream is silent in the leading phase (prompt prefill).

    Regression cover for the 2026-09-09 livelock: Qwen3.8-Flash-Next on a
    single RTX 3090 prefills a 64k-token session turn in 170-400 s, past the
    Factory Droid ~242 s stream watchdog. message_start and ping events do
    not reset that watchdog; each kill landed mid-prefill and the retry
    re-prefilled from token 0. The heartbeat keeps content deltas flowing
    without changing visible output.
    """

    def test_heartbeat_streams_thinking_spaces_before_text(self):
        upstream = _SlowUpstreamStream([{"content": "answer"}], delay=0.22)
        events = _assert_block_discipline(
            self, _events(_drain(upstream, heartbeat_secs=0.05))
        )

        self.assertEqual(_block_kinds(events), ["thinking", "text"])
        thinking = _deltas_of(events, "thinking_delta")
        self.assertGreaterEqual(len(thinking), 2)
        self.assertTrue(all(t == " " for t in thinking))
        self.assertEqual(_deltas_of(events, "text_delta"), ["answer"])

    def test_heartbeat_shares_block_with_real_reasoning(self):
        upstream = _SlowUpstreamStream(
            [{"reasoning_content": "real thought"}, {"content": "answer"}],
            delay=0.12,
        )
        events = _assert_block_discipline(
            self, _events(_drain(upstream, heartbeat_secs=0.05))
        )

        self.assertEqual(_block_kinds(events), ["thinking", "text"])
        thinking = _deltas_of(events, "thinking_delta")
        # Heartbeat spaces and the real reasoning share ONE thinking block.
        self.assertEqual(thinking.count("real thought"), 1)
        self.assertGreaterEqual(len(thinking), 3)
        self.assertTrue(all(t in (" ", "real thought") for t in thinking))

    def test_heartbeat_off_by_default_keeps_plain_text_layout(self):
        upstream = _SlowUpstreamStream([{"content": "answer"}], delay=0.2)
        events = _assert_block_discipline(self, _events(_drain(upstream)))

        self.assertEqual(_block_kinds(events), ["text"])
        self.assertEqual(_deltas_of(events, "thinking_delta"), [])
        self.assertEqual(_deltas_of(events, "text_delta"), ["answer"])


if __name__ == "__main__":
    unittest.main()
