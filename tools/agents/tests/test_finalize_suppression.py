#!/usr/bin/env python3
"""Tests for the gated finalize-suppression fix.

When a hard finalize breaker (TURN-COUNT FINALIZE BREAKER or SESSION
CONTAMINATION LOOP) deliberately strips tools to force a terminal text-only
``end_turn``, the response-side prose->tool_call resurrection must be suppressed.
Otherwise a contaminated model that emits ``<function=...>`` / ``<tool_call>``
prose has it promoted back into a structured ``tool_use``, the client executes
it, and the very loop the breaker meant to end continues.

The suppression is carried per-turn on the SessionMonitor
(``suppress_text_tool_extraction``): the breakers set it True; the extractor and
the post-stream recovery honor it; the request handler clears it at the start of
every turn so a finalize turn never bleeds into the next turn's normal flow.
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


def _prose_tool_resp():
    """OpenAI response: message has NO structured tool_calls but DOES contain a
    Hermes ``<function=...>`` prose tool call (the contamination output)."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "<function=Bash>\n<parameter=command>ls</parameter>\n</function>",
                },
                "finish_reason": "stop",
            }
        ]
    }


class _FakeOpenAIStream:
    """Minimal stand-in for an httpx streaming response: yields the queued
    ``data: {...}`` SSE lines that stream_anthropic_response consumes."""

    def __init__(self, lines):
        self._lines = list(lines)

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        pass


def _tool_call_text_stream():
    """An upstream stream whose text delta embeds a ``<tool_call>`` payload and
    that carries NO structured tool_calls — the prose the post-stream recovery
    would otherwise resurrect."""
    text_delta = {
        "choices": [
            {
                "delta": {
                    "content": '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>'
                },
                "finish_reason": None,
            }
        ]
    }
    final = {"choices": [{"delta": {}, "finish_reason": "stop"}]}
    return _FakeOpenAIStream(
        [f"data: {json.dumps(text_delta)}", f"data: {json.dumps(final)}", "data: [DONE]"]
    )


async def _drain(agen):
    return [chunk async for chunk in agen]


class TestFinalizeSuppressionExtractor(unittest.TestCase):
    def test_baseline_promotes_prose_tool_call(self):
        """suppress=False: the load-bearing parser still resurrects the prose
        tool call (guards against the fix over-suppressing normal turns)."""
        resp = _prose_tool_resp()
        proxy._maybe_extract_text_tool_calls(resp)
        msg = resp["choices"][0]["message"]
        self.assertTrue(msg.get("tool_calls"), "expected prose call to be promoted")
        self.assertEqual(msg["tool_calls"][0]["function"]["name"], "Bash")
        self.assertEqual(resp["choices"][0]["finish_reason"], "tool_calls")

    def test_suppressed_leaves_prose_as_text(self):
        """suppress=True: prose stays text -> the client sees a clean end_turn
        with no action, so the agentic loop terminates."""
        resp = _prose_tool_resp()
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        msg = resp["choices"][0]["message"]
        self.assertFalse(msg.get("tool_calls"), "must NOT resurrect tool call on finalize")
        self.assertIn("<function=Bash>", msg["content"])
        self.assertEqual(resp["choices"][0]["finish_reason"], "stop")

    def test_conversion_respects_suppression(self):
        """openai_to_anthropic_response forwards suppression to its internal
        extraction call (the 7444 site that lacks a monitor argument)."""
        anthro = proxy.openai_to_anthropic_response(
            _prose_tool_resp(), "m", suppress_text_tool_extraction=True
        )
        self.assertFalse(
            any(b.get("type") == "tool_use" for b in anthro.get("content", [])),
            "conversion must not resurrect a tool_use when suppressed",
        )


class TestStreamingRecoverySuppression(unittest.TestCase):
    def _run(self, suppress):
        monitor = proxy.SessionMonitor(context_window=100000)
        monitor.suppress_text_tool_extraction = suppress
        agen = proxy.stream_anthropic_response(_tool_call_text_stream(), "test-model", monitor, {})
        return "".join(asyncio.run(_drain(agen)))

    def test_baseline_streaming_recovers_tool_use(self):
        self.assertIn(
            '"type": "tool_use"', self._run(False),
            "post-stream recovery should fire when not suppressed",
        )

    def test_suppressed_streaming_does_not_recover_tool_use(self):
        self.assertNotIn(
            '"type": "tool_use"', self._run(True),
            "must NOT recover tool_use on finalize",
        )


class TestContaminationBreakerSetsSuppression(unittest.TestCase):
    def _monitor(self):
        return proxy.SessionMonitor(context_window=100000)

    def test_forcing_finalize_sets_suppression_and_strips_tools(self):
        """The terminal forcing-finalize branch (resets >= max) strips tools AND
        sets the per-turn suppression flag on the monitor."""
        m = self._monitor()
        m.malformed_tool_streak = proxy.PROXY_SESSION_CONTAMINATION_THRESHOLD
        m.contamination_resets = 3  # >= max (3) -> forcing-finalize branch
        body = {
            "messages": [{"role": "user", "content": "go"}],
            "tools": [{"name": "Bash"}],
            "tool_choice": "auto",
        }
        out = proxy._maybe_apply_session_contamination_breaker(body, m, "sess-finalize")
        self.assertNotIn("tools", out)
        self.assertNotIn("tool_choice", out)
        self.assertTrue(m.suppress_text_tool_extraction, "forcing-finalize must set suppression")

    def test_standard_reset_does_not_suppress(self):
        """A normal (non-terminal) contamination reset keeps tools and must NOT
        suppress extraction — the model should still be able to recover."""
        m = self._monitor()
        m.malformed_tool_streak = proxy.PROXY_SESSION_CONTAMINATION_THRESHOLD
        m.contamination_resets = 0  # below max -> standard reset path
        msgs = [{"role": "user", "content": "go"}]
        msgs += [{"role": "assistant", "content": f"turn {i}"} for i in range(12)]
        body = {"messages": msgs, "tools": [{"name": "Bash"}]}
        proxy._maybe_apply_session_contamination_breaker(body, m, "sess-standard")
        self.assertFalse(m.suppress_text_tool_extraction, "standard reset must NOT suppress")


if __name__ == "__main__":
    unittest.main()
