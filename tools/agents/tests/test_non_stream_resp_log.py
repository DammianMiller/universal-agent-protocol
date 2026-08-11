#!/usr/bin/env python3
"""A monitor that cannot see the answers cannot tell working from looping.

`RESP:` was logged only from `stream_anthropic_response`. `uap deliver`'s
agentic executor is entirely non-streaming, so during a three-hour run on
2026-08-11 the journal held 431 requests and ONE response — and every one of
those 431 turns was invisible. Diagnosing that run meant reconstructing the
model's behaviour from the delivery log's tool counts instead of reading what
it actually returned.

These pin that a non-streaming turn now logs its outcome, in the same shape as
the streaming one so a single parser reads both.
"""

import importlib.util
import json
import logging
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


def _resp(message, finish="stop", usage=None):
    return {
        "choices": [{"message": message, "finish_reason": finish}],
        "usage": usage or {"prompt_tokens": 10, "completion_tokens": 7},
    }


class NonStreamRespLog(unittest.TestCase):
    def _convert(self, openai_resp):
        with self.assertLogs("uap.anthropic_proxy", level="INFO") as captured:
            out = proxy.openai_to_anthropic_response(openai_resp, "qwen")
        return out, [r for r in captured.output if "RESP: finish=" in r]

    def test_text_turn_logs_its_outcome(self):
        _, lines = self._convert(_resp({"role": "assistant", "content": "hello world"}))
        self.assertEqual(len(lines), 1, "a non-streaming turn must log exactly one RESP")
        line = lines[0]
        self.assertIn("finish=stop", line)
        self.assertIn("output_tokens=7", line)
        self.assertIn("text_len=11", line)
        self.assertIn("hello world", line)

    def test_tool_turn_names_the_tool_and_its_args(self):
        # The whole point: "what did it DO this round" has to be readable.
        _, lines = self._convert(
            _resp(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": json.dumps({"path": "setup.sql", "offset": 607}),
                            },
                        }
                    ],
                },
                finish="tool_calls",
            )
        )
        self.assertEqual(len(lines), 1)
        self.assertIn("read_file", lines[0])
        self.assertIn("setup.sql", lines[0])
        self.assertIn("607", lines[0], "the args are what distinguish paging from a re-read")

    def test_empty_completion_is_visible_as_empty(self):
        # An empty completion is a failure mode with its own history here
        # (decode-compliance/budget truncation). It must not read as silence.
        _, lines = self._convert(
            _resp({"role": "assistant", "content": ""}, finish="length",
                  usage={"prompt_tokens": 5, "completion_tokens": 0})
        )
        self.assertEqual(len(lines), 1)
        self.assertIn("text_len=0", lines[0])
        self.assertIn("finish=length", lines[0])

    def test_shape_matches_the_streaming_line_so_one_parser_reads_both(self):
        _, lines = self._convert(_resp({"role": "assistant", "content": "x"}))
        for field in ("RESP: finish=", "output_tokens=", "text_len=", "text=", "tool_calls=", "args="):
            self.assertIn(field, lines[0], field)
        self.assertIn("path=json", lines[0], "…while still being distinguishable")

    def test_logging_never_breaks_the_conversion(self):
        # Fail-soft: the response is the product, the log line is not. A
        # malformed content block must not cost the client its answer.
        out, _ = self._convert(_resp({"role": "assistant", "content": "fine"}))
        self.assertEqual(out["role"], "assistant")
        self.assertEqual(out["content"][0]["text"], "fine")
        self.assertEqual(out["stop_reason"], "end_turn")


class RespLogSurvivesOddContent(unittest.TestCase):
    def test_non_dict_content_blocks_do_not_raise(self):
        logging.getLogger("uap.anthropic_proxy").setLevel(logging.INFO)
        # Defensive: content is assembled upstream and has been non-uniform
        # before (thinking promotion, text-tool extraction).
        proxy._log_non_stream_resp(["not a dict", {"type": "text", "text": "ok"}], "stop", {})


if __name__ == "__main__":
    unittest.main()
