#!/usr/bin/env python3
"""An UNCLOSED <think> block must NOT be classified as a malformed tool payload.

Under llama-server `--reasoning auto`, Qwen3.6 emits <think> reasoning. When it
runs out of its token budget mid-thought it produces an *unclosed* block, e.g.

    "<think> The sandbox works. Now write the remaining files via multiple
     sandbox calls... args="

with no </think>. That is TRUNCATED reasoning, not a malformed tool call — but
the prior detector only stripped *balanced* <think>...</think>, so the meta-tool
talk inside the unclosed block tripped the structural-marker branch and the proxy
rejected/retried the turn (observed: ~11 false rejections in 40 min stalling the
Octopus Invaders agentic build). `_looks_malformed_tool_payload` now also strips a
trailing unclosed <think> (keeping any text BEFORE the opener so a genuine
malformed payload preceding the reasoning is still caught).
"""

import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()
_malformed = proxy._looks_malformed_tool_payload


class TestUnclosedThinkNotMalformed(unittest.TestCase):
    def test_unclosed_think_with_meta_tool_talk_is_not_malformed(self):
        # The exact failure shape that stalled the Octopus build.
        text = (
            "<think> The sandbox approach works. Now I need to write all the "
            "remaining files. Let me write them efficiently using multiple "
            "sandbox calls in parallel. I'll write the files in dependency "
            "order: 1. config.js (done) 2. args="
        )
        self.assertFalse(_malformed(text))

    def test_unclosed_think_with_function_words_is_not_malformed(self):
        # meta-tool talk that mentions <function= / <parameter inside reasoning
        text = "<think> I should call <function=Write> with <parameter=path>..."
        self.assertFalse(_malformed(text))

    def test_balanced_think_still_not_malformed(self):
        text = "<think> planning... </think>"
        self.assertFalse(_malformed(text))

    def test_genuine_malformed_payload_without_think_still_detected(self):
        # No <think> at all — a real leaked tool-call fragment must still trip.
        self.assertTrue(_malformed("<function=Write><parameter=path>x</parameter>"))

    def test_malformed_payload_BEFORE_unclosed_think_still_detected(self):
        # Keep text before the opener: a real malformed payload preceding the
        # reasoning must still be caught.
        text = "<function=Write><parameter=p>v</parameter> <think> now reasoning..."
        self.assertTrue(_malformed(text))

    def test_clean_prose_with_no_tool_markup_is_not_malformed(self):
        self.assertFalse(_malformed("Here is the summary of what I did."))


if __name__ == "__main__":
    unittest.main()
