#!/usr/bin/env python3
"""Every SSE event the proxy emits must satisfy the Anthropic wire schema.

2026-09-13. The proxy emitted `content_block_start` for a tool_use WITHOUT the
`input` field:

    {"type":"content_block_start","index":1,
     "content_block":{"type":"tool_use","id":"...","name":"Read"}}

That is not valid per the Anthropic API, whose SDKs are generated from the same
schema — so Factory Droid (TypeScript SDK) rejected one event per tool-use turn
with "[DroidClient] Dropping malformed event" (measured: 42 drops against 45
tool-call responses). The client still recovered the call from the following
input_json_delta, but the start event — carrying the tool id and name — was lost.

These tests validate against the installed `anthropic` SDK's own pydantic models
rather than a hand-written expectation, so they track the real schema.
"""

import json
import re
import unittest

try:
    from anthropic.types.raw_content_block_start_event import RawContentBlockStartEvent
    _HAVE_SDK = True
except Exception:  # pragma: no cover - SDK not installed in this environment
    _HAVE_SDK = False


TOOL_USE_START_RE = re.compile(
    r"'content_block': \{'type': 'tool_use'[^}]*\}", re.S
)


def _proxy_source() -> str:
    from pathlib import Path

    return (
        Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    ).read_text()


class TestToolUseStartEventShape(unittest.TestCase):
    def test_every_tool_use_start_site_sets_input(self):
        """Static guard: a new emission site must not reintroduce the omission."""
        src = _proxy_source()
        sites = [
            m.group(0)
            for m in re.finditer(r"\{'type': 'tool_use',[^}]*\}", src)
            if "content_block_start" in src[max(0, m.start() - 400):m.start()]
        ]
        self.assertGreater(len(sites), 0, "no tool_use content_block_start sites found")
        missing = [s for s in sites if "'input'" not in s]
        self.assertEqual(
            missing,
            [],
            "tool_use content_block_start without `input` (clients drop it): "
            f"{missing}",
        )

    @unittest.skipUnless(_HAVE_SDK, "anthropic SDK not installed")
    def test_payload_without_input_is_rejected_by_the_real_schema(self):
        """Documents *why* the field is required — this is the observed bug."""
        bad = {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "abc", "name": "Read"},
        }
        with self.assertRaises(Exception):
            RawContentBlockStartEvent.model_validate(bad)

    @unittest.skipUnless(_HAVE_SDK, "anthropic SDK not installed")
    def test_payload_with_input_validates(self):
        good = {
            "type": "content_block_start",
            "index": 1,
            "content_block": {
                "type": "tool_use",
                "id": "abc",
                "name": "Read",
                "input": {},
            },
        }
        ev = RawContentBlockStartEvent.model_validate(good)
        self.assertEqual(ev.content_block.type, "tool_use")

    @unittest.skipUnless(_HAVE_SDK, "anthropic SDK not installed")
    def test_thinking_and_text_start_events_validate(self):
        """The other two block kinds the proxy opens must stay valid too."""
        for cb in (
            {"type": "thinking", "thinking": "", "signature": ""},
            {"type": "text", "text": ""},
        ):
            with self.subTest(block=cb["type"]):
                RawContentBlockStartEvent.model_validate(
                    {"type": "content_block_start", "index": 0, "content_block": cb}
                )


if __name__ == "__main__":
    unittest.main()
