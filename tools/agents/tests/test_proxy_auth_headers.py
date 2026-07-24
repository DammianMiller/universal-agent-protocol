"""Tests for the shared-secret auth middleware header sources.

The proxy emulates the Anthropic Messages API. Its clients authenticate in one
of three ways depending on the SDK: `X-Uap-Proxy-Token`, `Authorization: Bearer`,
or — for Anthropic-native SDKs like opencode's @ai-sdk/anthropic and claude-code
— `x-api-key`. All three must be accepted; a wrong or missing token must 401.
"""
import asyncio
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

_TOKEN = "proxy-secret-token"
_SENTINEL = object()


class _FakeURL:
    def __init__(self, path):
        self.path = path


class _FakeReq:
    def __init__(self, headers, path="/v1/messages", method="POST"):
        self.headers = headers
        self.url = _FakeURL(path)
        self.method = method


async def _call_next(_request):
    return _SENTINEL


def _run_auth(headers):
    """Drive the async middleware; return _SENTINEL when auth passes, else the 401 Response."""
    req = _FakeReq(headers)
    return asyncio.run(proxy._shared_secret_auth(req, _call_next))


class ProxyAuthHeaderTest(unittest.TestCase):
    def setUp(self):
        self._prev = proxy.PROXY_AUTH_TOKEN
        proxy.PROXY_AUTH_TOKEN = _TOKEN

    def tearDown(self):
        proxy.PROXY_AUTH_TOKEN = self._prev

    def test_x_api_key_accepted(self):
        # NEW behavior: Anthropic-native SDKs send the token as x-api-key.
        self.assertIs(_run_auth({"x-api-key": _TOKEN}), _SENTINEL)

    def test_x_api_key_wrong_token_rejected(self):
        resp = _run_auth({"x-api-key": "not-the-token"})
        self.assertEqual(getattr(resp, "status_code", None), 401)

    def test_x_uap_proxy_token_still_accepted(self):
        self.assertIs(_run_auth({"x-uap-proxy-token": _TOKEN}), _SENTINEL)

    def test_authorization_bearer_still_accepted(self):
        self.assertIs(_run_auth({"authorization": f"Bearer {_TOKEN}"}), _SENTINEL)

    def test_no_credentials_rejected(self):
        resp = _run_auth({})
        self.assertEqual(getattr(resp, "status_code", None), 401)

    def test_no_op_when_token_unset(self):
        proxy.PROXY_AUTH_TOKEN = ""
        self.assertIs(_run_auth({}), _SENTINEL)


if __name__ == "__main__":
    unittest.main()
