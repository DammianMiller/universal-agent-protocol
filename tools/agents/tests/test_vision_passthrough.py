#!/usr/bin/env python3
"""Vision passthrough: Anthropic image blocks → OpenAI image_url parts.

The upstream llama-server advertises vision in /props (modalities.vision) when
launched with --mmproj; the proxy autodetects and forwards images so coding
agents can visually check their outputs. Without vision the proxy leaves an
explicit placeholder instead of silently dropping (agents believed the model
saw screenshots it never received).
"""

import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


proxy = _load_proxy_module()

PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _img_block():
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG_B64}}


class VisionOnTests(unittest.TestCase):
    def setUp(self):
        self._saved = (proxy.PROXY_VISION, proxy.upstream_vision)
        proxy.PROXY_VISION = "auto"
        proxy.upstream_vision = True

    def tearDown(self):
        proxy.PROXY_VISION, proxy.upstream_vision = self._saved

    def test_user_image_becomes_typed_multimodal_content(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "text", "text": "what does this screenshot show?"},
            _img_block(),
        ]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        self.assertEqual(len(msgs), 1)
        content = msgs[0]["content"]
        self.assertIsInstance(content, list)
        kinds = [p["type"] for p in content]
        self.assertEqual(kinds, ["text", "image_url"])
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_url_source_passthrough(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}},
        ]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        self.assertEqual(msgs[0]["content"][0]["image_url"]["url"], "https://x/y.png")

    def test_tool_result_images_delivered_as_adjacent_user_turn(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_abc", "content": [
                {"type": "text", "text": "screenshot captured"},
                _img_block(),
            ]},
        ]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        self.assertEqual(msgs[0]["role"], "tool")
        self.assertIn("screenshot captured", msgs[0]["content"])
        self.assertEqual(msgs[1]["role"], "user")
        parts = msgs[1]["content"]
        self.assertEqual(parts[0]["type"], "text")
        self.assertEqual(parts[1]["type"], "image_url")

    def test_text_only_messages_stay_plain_strings(self):
        body = {"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        self.assertEqual(msgs[0]["content"], "hi")

    def test_image_token_estimate_counts(self):
        msg = {"role": "user", "content": [_img_block(), {"type": "text", "text": "x"}]}
        with_img = proxy.estimate_message_tokens(msg)
        without = proxy.estimate_message_tokens({"role": "user", "content": [{"type": "text", "text": "x"}]})
        self.assertGreaterEqual(with_img - without, proxy.PROXY_IMAGE_TOKEN_ESTIMATE)


class VisionOffTests(unittest.TestCase):
    def setUp(self):
        self._saved = (proxy.PROXY_VISION, proxy.upstream_vision)
        proxy.PROXY_VISION = "auto"
        proxy.upstream_vision = False

    def tearDown(self):
        proxy.PROXY_VISION, proxy.upstream_vision = self._saved

    def test_user_image_becomes_explicit_placeholder(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "text", "text": "see image"}, _img_block(),
        ]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        content = msgs[0]["content"]
        self.assertIsInstance(content, str)
        self.assertIn("image omitted", content)

    def test_tool_result_image_noted_in_text(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": [
                {"type": "text", "text": "shot"}, _img_block(),
            ]},
        ]}]}
        msgs = proxy.anthropic_to_openai_messages(body)
        self.assertEqual(len(msgs), 1)  # no adjacent user turn without vision
        self.assertIn("1 image(s) omitted", msgs[0]["content"])

    def test_force_on_overrides_missing_upstream(self):
        proxy.PROXY_VISION = "on"
        self.assertTrue(proxy.vision_enabled())
        proxy.PROXY_VISION = "off"
        proxy.upstream_vision = True
        self.assertFalse(proxy.vision_enabled())


if __name__ == "__main__":
    unittest.main()
