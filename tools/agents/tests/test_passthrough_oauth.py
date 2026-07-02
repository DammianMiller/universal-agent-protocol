"""Tests for OAuth-aware Anthropic passthrough (Claude Max) + passthrough model match."""
import importlib.util
import os
import unittest
from pathlib import Path
from types import SimpleNamespace


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


def req(headers):
    # FastAPI Request.headers exposes a case-insensitive .get; the proxy only
    # reads lowercase keys, so a plain dict is a faithful stand-in.
    return SimpleNamespace(headers=headers)


class PassthroughOAuthTest(unittest.TestCase):
    def test_oauth_bearer_forwarded_without_api_key(self):
        h = proxy._build_passthrough_headers(
            req({"authorization": "Bearer sk-ant-oat-abc", "anthropic-version": "2023-06-01"})
        )
        self.assertEqual(h["Authorization"], "Bearer sk-ant-oat-abc")
        self.assertNotIn("x-api-key", h)  # must NOT mix credentials

    def test_oauth_takes_precedence_over_api_key(self):
        h = proxy._build_passthrough_headers(
            req({"authorization": "Bearer sk-ant-oat-abc", "x-api-key": "sk-ant-api-xyz"})
        )
        self.assertEqual(h["Authorization"], "Bearer sk-ant-oat-abc")
        self.assertNotIn("x-api-key", h)

    def test_api_key_path_still_works(self):
        h = proxy._build_passthrough_headers(req({"x-api-key": "sk-ant-api-xyz"}))
        self.assertEqual(h["x-api-key"], "sk-ant-api-xyz")
        self.assertNotIn("Authorization", h)

    def test_beta_header_forwarded(self):
        h = proxy._build_passthrough_headers(
            req({"authorization": "Bearer t", "anthropic-beta": "oauth-2025-04-20"})
        )
        self.assertEqual(h["anthropic-beta"], "oauth-2025-04-20")

    def test_no_credentials_returns_none(self):
        old = proxy.ANTHROPIC_API_KEY
        proxy.ANTHROPIC_API_KEY = ""
        try:
            self.assertIsNone(proxy._build_passthrough_headers(req({})))
        finally:
            proxy.ANTHROPIC_API_KEY = old


class PassthroughModelMatchTest(unittest.TestCase):
    def test_new_anthropic_models_passthrough(self):
        for m in ("claude-opus-4-8", "claude-fable-5", "claude-haiku-4-5-20251001",
                  "claude-opus-4-6", "claude-sonnet-4-6"):
            self.assertTrue(proxy._should_passthrough_model(m), m)

    def test_local_model_not_passthrough(self):
        self.assertFalse(proxy._should_passthrough_model("qwen36-35b-a3b-iq4xs"))
        self.assertFalse(proxy._should_passthrough_model(""))


if __name__ == "__main__":
    unittest.main()
