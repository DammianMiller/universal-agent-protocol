#!/usr/bin/env python3
"""Single-oversized-message overflow wedge + count_tokens.

Claude Code's auto-compact sends a single `<transcript>` message that can be
LARGER than the whole context window. The pruner reduces context by DROPPING
messages, so with one giant undroppable message it can't get under the window
and thrashes (prune -> still >100% -> retry). Two fixes:

1. `_truncate_oversized_message_content` truncates the largest content in-place
   (head+tail keep) so pruning always converges — covers plain-string / `text`
   / `tool_result` content, not just tool_result (the old gap).
2. `POST /v1/messages/count_tokens` returns `{"input_tokens": N}` (was 404) so
   the client can size its auto-compact to the real window in the first place.
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


class _FakeReq:
    def __init__(self, payload):
        self._p = payload

    async def json(self):
        return self._p


class _BadReq:
    async def json(self):
        raise ValueError("bad json")


class TestTruncateOversized(unittest.TestCase):
    def test_giant_string_message_truncated_to_budget(self):
        msgs = [{"role": "user", "content": "HEAD" + ("x" * 700_000) + "TAIL"}]
        budget = 50_000  # tokens
        fit = proxy._truncate_oversized_message_content(msgs, budget)
        total = sum(proxy.estimate_message_tokens(m) for m in msgs)
        self.assertTrue(fit)
        self.assertLessEqual(total, budget)
        content = msgs[0]["content"]
        self.assertIn("[TRUNCATED FOR CONTEXT WINDOW]", content)
        self.assertTrue(content.startswith("HEAD"))   # head preserved
        self.assertTrue(content.rstrip().endswith("TAIL"))  # tail preserved

    def test_text_block_and_tool_result_truncated(self):
        msgs = [
            {"role": "user", "content": [{"type": "text", "text": "A" * 400_000}]},
            {"role": "user", "content": [{"type": "tool_result", "content": "B" * 400_000}]},
        ]
        budget = 30_000
        fit = proxy._truncate_oversized_message_content(msgs, budget)
        total = sum(proxy.estimate_message_tokens(m) for m in msgs)
        self.assertTrue(fit)
        self.assertLessEqual(total, budget)

    def test_small_messages_untouched(self):
        msgs = [{"role": "user", "content": "hello"}]
        before = msgs[0]["content"]
        fit = proxy._truncate_oversized_message_content(msgs, 50_000)
        self.assertTrue(fit)
        self.assertEqual(msgs[0]["content"], before)  # nothing truncated

    def test_prune_conversation_converges_on_transcript_over_window(self):
        # 2-message request, one is a transcript LARGER than the whole window —
        # message-dropping can't help; must converge via content truncation.
        window = 100_000
        body = {
            "system": "You are a summarizer.",
            "messages": [
                {"role": "user", "content": "Summarize this transcript:"},
                {"role": "user", "content": "<transcript>" + ("t" * 500_000) + "</transcript>"},
            ],
            "max_tokens": 2048,
        }
        out = proxy.prune_conversation(body, window, target_fraction=0.5, keep_last=8)
        total = proxy.estimate_total_tokens(out)
        self.assertLessEqual(total, window)  # fits — no wedge


class TestCountTokens(unittest.TestCase):
    def test_returns_input_tokens_matching_estimator(self):
        payload = {
            "model": "m",
            "system": "sys prompt here",
            "messages": [{"role": "user", "content": "hello world, count me"}],
            "max_tokens": 10,
        }
        res = asyncio.run(proxy.count_tokens(_FakeReq(payload)))
        self.assertEqual(res, {"input_tokens": proxy.estimate_total_tokens(payload)})
        self.assertGreater(res["input_tokens"], 0)

    def test_invalid_json_returns_400(self):
        res = asyncio.run(proxy.count_tokens(_BadReq()))
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
