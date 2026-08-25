#!/usr/bin/env python3
"""Mid-stream degenerate-repetition guard.

Regression cover for the 2026-08-25 runaway: a rail running
--repeat-penalty 1.0 with DRY disabled emitted ONE sentence 640 times
(151,628 chars) until it hit the 32,768-token n-predict cap, ~11 minutes of
GPU for a turn that produced nothing. The post-hoc detector
(_detect_and_truncate_degenerate_repetition) only repairs NON-streaming
responses, so a streaming client like opencode was never protected.

The false-positive tests are the load-bearing half: a guard that aborts real
answers is worse than the runaway it prevents.
"""

import asyncio
import importlib.util
import json
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

# The exact sentence captured from the live runaway.
RUNAWAY_LINE = (
    "The Docker build fails because the workspace root `Cargo.toml` doesn't "
    "include the `pg-server` bin target. Let me check the workspace structure:"
)


class TestDetectDegenerateRepeat(unittest.TestCase):
    def test_detects_the_captured_runaway_shape(self):
        """One sentence + blank line, over and over — the real failure."""
        tail = (RUNAWAY_LINE + "\n\n") * 20
        self.assertEqual(proxy._detect_degenerate_repeat(tail), RUNAWAY_LINE)

    def test_detects_loop_with_no_newlines(self):
        """Block mode: a loop inside one long line is invisible to line mode."""
        unit = "and then the value is recomputed again, "
        tail = "prefix text. " + unit * 12
        found = proxy._detect_degenerate_repeat(tail)
        self.assertIsNotNone(found)
        # Whatever period it locks onto must itself be the repeating unit.
        self.assertTrue(unit.strip(", ") in found or found in unit * 2)

    def test_ignores_repetition_that_has_stopped(self):
        """Anchored at the END: a repetitive passage the model moved on from
        is not a runaway, and aborting there would truncate a real answer."""
        tail = (RUNAWAY_LINE + "\n\n") * 20 + (
            "\n\nRight — the bin target is missing from the workspace members "
            "list. Adding it to Cargo.toml now, then rebuilding to confirm the "
            "image picks up the new binary.\n"
        )
        self.assertIsNone(proxy._detect_degenerate_repeat(tail))

    def test_ignores_short_and_punctuation_only_runs(self):
        """Rules, fences and bracket runs legitimately repeat in real output."""
        for tail in (
            "----\n" * 30,
            "```\n" * 30,
            "}\n" * 30,
            "    \n" * 30,
            ("ok\n") * 30,  # non-blank but under MIN_UNIT
        ):
            with self.subTest(tail=tail[:12]):
                self.assertIsNone(proxy._detect_degenerate_repeat(tail))

    def test_ignores_similar_but_distinct_lines(self):
        """Generated code repeats structure, not whole identical lines."""
        tail = "".join(
            f'    assert_eq!(rows[{i}].get::<_, i64>("id"), {i} as i64);\n'
            for i in range(30)
        )
        self.assertIsNone(proxy._detect_degenerate_repeat(tail))

    def test_ignores_empty_input(self):
        self.assertIsNone(proxy._detect_degenerate_repeat(""))


class _FakeUpstreamStream:
    """Minimal streamed httpx.Response: yields OpenAI SSE lines."""

    def __init__(self, contents, finish_reason="stop"):
        self._contents = list(contents)
        self._finish_reason = finish_reason
        self.closed = False
        self.lines_served = 0

    async def aiter_lines(self):
        for chunk in self._contents:
            self.lines_served += 1
            payload = {"choices": [{"delta": {"content": chunk}, "index": 0}]}
            yield "data: " + json.dumps(payload)
        final = {"choices": [{"delta": {}, "finish_reason": self._finish_reason}]}
        yield "data: " + json.dumps(final)
        yield "data: [DONE]"

    async def aclose(self):
        self.closed = True


def _drain(upstream):
    monitor = proxy.SessionMonitor(context_window=131072)

    async def run():
        out = []
        async for frame in proxy.stream_anthropic_response(
            upstream, "test-model", monitor, {"messages": [], "tools": []}
        ):
            out.append(frame)
        return out

    return asyncio.run(run())


def _text_deltas(frames):
    texts = []
    for frame in frames:
        for line in frame.splitlines():
            if not line.startswith("data: "):
                continue
            try:
                obj = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "content_block_delta":
                delta = obj.get("delta", {})
                if delta.get("type") == "text_delta":
                    texts.append(delta["text"])
    return texts


def _stop_reason(frames):
    for frame in frames:
        for line in frame.splitlines():
            if not line.startswith("data: "):
                continue
            try:
                obj = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "message_delta":
                return (obj.get("delta") or {}).get("stop_reason")
    return None


class TestStreamRepeatGuard(unittest.TestCase):
    def test_aborts_runaway_before_the_budget_is_spent(self):
        """The whole point: stop generating, not just clean up afterwards."""
        chunks = [RUNAWAY_LINE + "\n\n"] * 400
        upstream = _FakeUpstreamStream(chunks)
        frames = _drain(upstream)

        served = upstream.lines_served
        self.assertLess(
            served, 100, f"guard did not abort early: {served}/400 chunks consumed"
        )
        self.assertEqual(
            _stop_reason(frames),
            "max_tokens",
            "an aborted runaway must not be reported as a complete answer",
        )

    def test_normal_response_streams_through_untouched(self):
        """No false abort, and every delta still reaches the client."""
        chunks = [
            "Checking the workspace layout.\n\n",
            "The `pg-server` crate is present but not listed under "
            "`[workspace] members`, so `cargo build --workspace` never "
            "builds its binary.\n\n",
            "Adding it to the members list and rebuilding.\n",
        ]
        upstream = _FakeUpstreamStream(chunks)
        frames = _drain(upstream)

        self.assertEqual(_text_deltas(frames), chunks)
        self.assertEqual(_stop_reason(frames), "end_turn")

    def test_long_legitimate_answer_is_not_aborted(self):
        """Well past the guard's minimum length, with repeated structure."""
        chunks = [
            f"Step {i}: verify that migration {i:03d} applies cleanly and the "
            f"resulting schema matches the fixture checked in at "
            f"tests/fixtures/schema_{i:03d}.sql.\n\n"
            for i in range(80)
        ]
        upstream = _FakeUpstreamStream(chunks)
        frames = _drain(upstream)

        self.assertEqual(len(_text_deltas(frames)), 80)
        self.assertEqual(_stop_reason(frames), "end_turn")

    def test_guard_can_be_disabled(self):
        chunks = [RUNAWAY_LINE + "\n\n"] * 60
        original = proxy.PROXY_REPEAT_GUARD
        proxy.PROXY_REPEAT_GUARD = False
        try:
            upstream = _FakeUpstreamStream(chunks)
            frames = _drain(upstream)
            self.assertEqual(len(_text_deltas(frames)), 60)
            self.assertEqual(_stop_reason(frames), "end_turn")
        finally:
            proxy.PROXY_REPEAT_GUARD = original


if __name__ == "__main__":
    unittest.main()
