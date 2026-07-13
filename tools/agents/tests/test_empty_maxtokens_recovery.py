#!/usr/bin/env python3
"""Empty-max_tokens recovery: a thinking-runaway (finish=length, empty content,
no tool calls) is retried once with thinking OFF so the turn yields an answer
instead of an empty response the client blindly re-sends."""
import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load_proxy():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()


def empty_length_resp():
    return {"choices": [{"finish_reason": "length", "message": {"role": "assistant", "content": ""}}]}


def good_resp(text="here is the answer"):
    return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": text}}]}


class DetectTests(unittest.TestCase):
    def test_detects_empty_length(self):
        self.assertTrue(proxy._is_empty_maxtokens_response(empty_length_resp()))

    def test_ignores_length_with_content(self):
        self.assertFalse(proxy._is_empty_maxtokens_response(
            {"choices": [{"finish_reason": "length", "message": {"content": "partial answer"}}]}))

    def test_ignores_length_with_tool_calls(self):
        self.assertFalse(proxy._is_empty_maxtokens_response(
            {"choices": [{"finish_reason": "length", "message": {"content": "", "tool_calls": [{"id": "1"}]}}]}))

    def test_ignores_normal_stop(self):
        self.assertFalse(proxy._is_empty_maxtokens_response(good_resp()))


class FakeResp:
    def __init__(self, body):
        self.status_code = 200
        self._body = body
    def json(self):
        return self._body


class FakeClient:
    def __init__(self, body):
        self._body = body
        self.last_json = None
    async def post(self, url, json=None, headers=None):  # noqa: A002
        self.last_json = json
        return FakeResp(self._body)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.m = proxy.SessionMonitor()

    def _run(self, resp, client_body, body_in=None):
        client = FakeClient(client_body)
        out = asyncio.run(proxy._apply_empty_maxtokens_recovery(
            client, resp, body_in or {"max_tokens": 16384}, {}, self.m, "t"))
        return out, client

    def test_recovers_with_thinking_off(self):
        out, client = self._run(empty_length_resp(), good_resp("recovered!"))
        self.assertEqual(out["choices"][0]["message"]["content"], "recovered!")
        # retry request had thinking disabled + a bounded max_tokens
        self.assertIs(client.last_json["chat_template_kwargs"]["enable_thinking"], False)
        self.assertIs(client.last_json["enable_thinking"], False)
        self.assertLessEqual(client.last_json["max_tokens"], proxy.PROXY_EMPTY_MAXTOKENS_RETRY_MAX_TOKENS)
        self.assertEqual(self.m.empty_maxtokens_recoveries, 1)

    def test_no_retry_on_a_healthy_response(self):
        out, client = self._run(good_resp("fine"), good_resp("should-not-be-used"))
        self.assertEqual(out["choices"][0]["message"]["content"], "fine")
        self.assertIsNone(client.last_json)  # never called upstream

    def test_keeps_original_if_retry_also_empty(self):
        out, _ = self._run(empty_length_resp(), empty_length_resp())
        self.assertTrue(proxy._is_empty_maxtokens_response(out))  # unchanged
        self.assertEqual(self.m.empty_maxtokens_recoveries, 0)


if __name__ == "__main__":
    unittest.main()
