#!/usr/bin/env python3

import importlib.util
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


class TestStreamingReasoningFallback(unittest.TestCase):
    def test_fallback_disabled_returns_none(self):
        text = proxy._build_reasoning_fallback_text(
            ["<think>hidden</think>"], mode="off"
        )
        self.assertIsNone(text)

    def test_visible_mode_returns_raw_text(self):
        raw = '<think>internal</think> {"x":1}'
        text = proxy._build_reasoning_fallback_text([raw], mode="visible")
        self.assertEqual(text, raw)

    def test_sanitized_mode_strips_think_tags(self):
        text = proxy._build_reasoning_fallback_text(
            ["<think>plan</think>\n   user visible output"], mode="sanitized"
        )
        self.assertEqual(text, "plan user visible output")

    def test_sanitized_mode_truncates_long_text(self):
        old_limit = getattr(proxy, "PROXY_STREAM_REASONING_MAX_CHARS")
        setattr(proxy, "PROXY_STREAM_REASONING_MAX_CHARS", 12)
        try:
            text = proxy._build_reasoning_fallback_text(
                ["1234567890ABCDE"], mode="sanitized"
            )
            self.assertEqual(text, "1234567890AB...")
        finally:
            setattr(proxy, "PROXY_STREAM_REASONING_MAX_CHARS", old_limit)


if __name__ == "__main__":
    unittest.main()
