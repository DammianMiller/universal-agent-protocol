#!/usr/bin/env python3
"""A toolless degenerate turn must be RETRIED, not just truncated.

Live-observed 3x (2026-11-22 22:04, 2026-11-23 11:20, 2026-11-23 19:26):
the evaluator-verdict turn (JSON-RESPONSE grammar, thinking off, no tools)
loops inside a JSON string field, and the non-guarded path's degenerate retry
was gated on `openai_body.get("tools")` — so the verdict shape was truncated
and handed downstream mid-string: 9744 -> 348 chars, unparseable, silent.

These tests pin:
  * the detector catches the exact observed verdict-loop shape (repeats
    inside a JSON "reason" value) and marks the cut finish_reason=length
    so consumers CAN see the incompleteness
  * the retry wiring: the toolless branch retries text-only (2048 wall,
    temp 0.1, non-stream, grammar carried by the body copy) and accepts
    only clean text > 50 chars
  * honesty: both retry-failure paths say LOUDLY that the consumer is
    holding a truncated, likely-unparseable verdict
  * the guarded path's own toolless retry remains (regression pin)
"""

import importlib.util
import re
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()

# The 2026-11-23 11:20 shape: a verdict JSON whose "reason" value loops.
VERDICT_PREFIX = (
    '{"criteria":[{"requirement":"S1 Voxel engine: sparse grid, greedy mesher '
    'per material id, per-face AO bake, vertex colours + tint noise",'
    '"met":true,"reason":"src/three/voxel.js implements a Map-based sparse '
    'grid, a greedy mesher that merges runs within material groups (and '
    'cross-material if colors m'
)
LOOP_UNIT = "atch the same material ramp key, so the greedy mesher pools them, "


def openai_resp_with_text(text, finish="length"):
    return {
        "choices": [
            {"message": {"content": text}, "finish_reason": finish}
        ],
        "usage": {"completion_tokens": 2648},
    }


class DetectorCatchesTheVerdictLoop(unittest.TestCase):
    def test_detects_repeats_inside_a_json_string_field(self):
        text = VERDICT_PREFIX + LOOP_UNIT * 16
        resp, was = proxy._detect_and_truncate_degenerate_repetition(
            openai_resp_with_text(text)
        )
        self.assertTrue(was)
        served = resp["choices"][0]["message"]["content"]
        self.assertLess(len(served), len(text))
        self.assertLessEqual(len(served), len(VERDICT_PREFIX) + len(LOOP_UNIT) + 80)

    def test_truncation_marks_finish_reason_length_not_stop(self):
        # The consumer's only honest signal that the verdict is incomplete.
        text = VERDICT_PREFIX + LOOP_UNIT * 35
        resp, was = proxy._detect_and_truncate_degenerate_repetition(
            openai_resp_with_text(text)
        )
        self.assertTrue(was)
        self.assertEqual(resp["choices"][0]["finish_reason"], "length")

    def test_a_clean_verdict_is_untouched(self):
        text = (
            '{"criteria":[{"requirement":"sparse grid","met":true,'
            '"reason":"src/three/voxel.js uses a Map-based grid"}],'
            '"verdict":"accepted"}'
        )
        resp, was = proxy._detect_and_truncate_degenerate_repetition(
            openai_resp_with_text(text, finish="stop")
        )
        self.assertFalse(was)
        self.assertEqual(
            resp["choices"][0]["message"]["content"], text
        )


class ToollessRetryWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src_path = Path(proxy.__file__)
        cls.source = src_path.read_text(encoding="utf-8")

    def _block(self, marker):
        i = self.source.index(marker)
        j = self.source.index("\n        anthropic_resp = openai_to_anthropic_response(", i)
        return self.source[i:j]

    def test_the_toolless_elif_exists_after_the_tools_retry(self):
        # The 3x live failure: the retry was gated on tools; the verdict
        # shape has none. The elif must sit on the non-guarded path, after
        # the tools branch.
        block = self._block("        # Degenerate retry for non-guarded stream path")
        self.assertIn("elif was_degenerate:", block)
        self.assertLess(block.index("if was_degenerate and"), block.index("elif was_degenerate:"))

    def test_the_retry_is_text_only_with_capped_wall_and_cold_temp(self):
        block = self._block("        # Degenerate retry for non-guarded stream path")
        self.assertIn('retry_body["max_tokens"] = 2048', block)
        self.assertIn('retry_body["temperature"] = 0.1', block)
        self.assertIn('retry_body["stream"] = False', block)

    def test_the_retry_accepts_only_clean_text_over_50_chars(self):
        block = self._block("        # Degenerate retry for non-guarded stream path")
        self.assertRegex(block, r"elif retry_text and len\(retry_text\) > 50")
        self.assertIn("retry_degenerate", block)  # the retry itself is re-checked

    def test_failure_paths_are_loud_about_truncated_verdicts(self):
        # Honesty: when the consumer receives a truncated (unparseable)
        # verdict anyway, the log says so — no silent corruption.
        block = self._block("        # Degenerate retry for non-guarded stream path")
        self.assertGreaterEqual(
            len(re.findall(r"TRUNCATED \(likely unparseable\)", block)), 2
        )

    def test_guarded_path_keeps_its_own_toolless_retry(self):
        # The guarded non-stream site already retried toolless degenerate
        # turns ("retrying text-only with max_tokens=2048 temp=0.1") —
        # pin it so this fix never regresses there either.
        self.assertIn(
            "DEGENERATE RETRY: retrying text-only with max_tokens=2048 temp=0.1",
            self.source,
        )


if __name__ == "__main__":
    unittest.main()
