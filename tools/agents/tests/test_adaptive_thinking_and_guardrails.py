"""Tests for Option A1 (selective/adaptive thinking), B2 (compute budget guardrails),
and A4 (multi-backend vision recheck) in anthropic_proxy.py.
"""
import asyncio
import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"

_PRIOR_ENV = {}
_TRACKED_KEYS = (
    "UAP_PROXY_ENV_AUTOLOAD",
    "PROXY_DISABLE_THINKING_ALWAYS",
    "PROXY_DISABLE_THINKING_ON_TOOL_TURNS",
    "PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT",
    "PROXY_THINKING_ON_OBSERVATION_TURNS",
    "PROXY_THINKING_OBSERVATION_MIN_MAX_TOKENS",
    "PROXY_TOOL_CALL_GRAMMAR",
    "PROXY_ARCHAEOLOGY_CAP",
    "PROXY_SINGLE_FILE_REFLECT_THRESHOLD",
    "PROXY_HARD_FINALIZE_TURNS",
    "PROXY_VISION",
)


def setUpModule():
    for k in _TRACKED_KEYS:
        _PRIOR_ENV[k] = os.environ.get(k)


def tearDownModule():
    for k, v in _PRIOR_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def load_proxy(**env):
    os.environ["UAP_PROXY_ENV_AUTOLOAD"] = "0"
    for k in _TRACKED_KEYS:
        if k != "UAP_PROXY_ENV_AUTOLOAD":
            os.environ.pop(k, None)
    os.environ.update({k: str(v) for k, v in env.items()})
    spec = importlib.util.spec_from_file_location("anthropic_proxy_adaptive_test", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _sample_tools():
    return [
        {
            "name": "Edit",
            "description": "Edit a file",
            "input_schema": {
                "type": "object",
                "properties": {"file_path": {"type": "string"}},
                "required": ["file_path"],
            },
        }
    ]


class AdaptiveThinkingAndGuardrailsTest(unittest.TestCase):
    def tearDown(self):
        for k in _TRACKED_KEYS:
            if k != "UAP_PROXY_ENV_AUTOLOAD":
                os.environ.pop(k, None)

    def test_multimodal_observation_restores_thinking_auto_choice_and_skips_tool_grammar(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
            PROXY_TOOL_CALL_GRAMMAR="on",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap.TOOL_CALL_GBNF = "root ::= ws"
        ap.TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE = True

        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "tools": _sample_tools(),
            "messages": [
                {"role": "user", "content": "Inspect the screenshot"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"file_path": "shot.png"}}
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tu_1",
                            "content": [
                                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
                            ],
                        }
                    ],
                },
            ],
        }
        self.assertEqual(ap._latest_turn_cognitive_signal(body), "multimodal_observation")

        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        self.assertEqual(openai_body.get("tool_choice"), "auto")
        self.assertGreaterEqual(openai_body.get("max_tokens", 0), 16384)

        # Tool-call GBNF must be skipped whenever thinking is ON
        ap._apply_tool_call_grammar(openai_body)
        self.assertNotIn("grammar", openai_body)

    def test_verification_failure_restores_thinking(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "tools": _sample_tools(),
            "messages": [
                {"role": "user", "content": "Fix the bug"},
                {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "tu_2", "name": "Execute", "input": {"command": "uap verify"}}],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tu_2",
                            "is_error": True,
                            "content": "VISION REVIEW FAILED — score 3/10",
                        }
                    ],
                },
            ],
        }
        self.assertEqual(ap._latest_turn_cognitive_signal(body), "verification_failure")
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        self.assertEqual(openai_body.get("tool_choice"), "auto")

    def test_explicit_reasoning_header_keeps_thinking_and_skips_json_grammar(self):
        ap = load_proxy(PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on")
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap.JSON_RESPONSE_GBNF = "root ::= object"

        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "_uap_reasoning": True,
            "_uap_json_response": True,
            "messages": [{"role": "user", "content": "Critique this deliverable"}],
        }
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        ap._apply_json_response_grammar(openai_body, body)
        self.assertNotIn("grammar", openai_body)
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))

    def test_disable_thinking_always_still_wins(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ALWAYS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "_uap_reasoning": True,
            "tools": _sample_tools(),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
                    ],
                }
            ],
        }
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertFalse(ap._thinking_enabled_on_body(openai_body))

    def test_vendor_archaeology_cap_fires_and_restores_thinking(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_ARCHAEOLOGY_CAP="4",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        msgs = [{"role": "user", "content": "Build app"}]
        for i in range(4):
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": f"r_{i}",
                            "name": "Read",
                            "input": {"file_path": f"node_modules/pkg/file{i}.js"},
                        }
                    ],
                }
            )
            msgs.append(
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": f"r_{i}", "content": "ok"}],
                }
            )
        body = {"model": "qwen3.8-flash-next", "max_tokens": 4096, "tools": _sample_tools(), "messages": msgs}
        hit = ap._detect_compute_budget_guardrail(body)
        self.assertIsNotNone(hit)
        self.assertEqual(hit[0], "vendor_archaeology_cap")

        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        self.assertEqual(openai_body.get("tool_choice"), "auto")

    def test_single_file_churn_guardrail_fires_with_thinking_on(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_SINGLE_FILE_REFLECT_THRESHOLD="3",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        msgs = [{"role": "user", "content": "Build app"}]
        for i in range(3):
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": f"e_{i}",
                            "name": "Create",
                            "input": {"file_path": "src/Scene.jsx", "content": f"// v{i}"},
                        }
                    ],
                }
            )
            msgs.append(
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": f"e_{i}", "content": "written"}],
                }
            )
        body = {"model": "qwen3.8-flash-next", "max_tokens": 4096, "tools": _sample_tools(), "messages": msgs}
        hit = ap._detect_compute_budget_guardrail(body)
        self.assertIsNotNone(hit)
        self.assertEqual(hit[0], "single_file_churn_reflect")

        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        self.assertEqual(openai_body.get("tool_choice"), "auto")

    def test_openai_to_anthropic_preserves_images_and_enable_thinking(self):
        ap = load_proxy()
        oai_req = {
            "model": "local-auto",
            "max_tokens": 8192,
            "chat_template_kwargs": {"enable_thinking": True},
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Inspect"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                    ],
                }
            ],
        }
        anth = ap.openai_to_anthropic_request(oai_req)
        self.assertEqual(anth.get("thinking"), {"type": "enabled"})
        blocks = anth["messages"][0]["content"]
        self.assertEqual(blocks[0]["type"], "text")
        self.assertEqual(blocks[1]["type"], "image")
        self.assertEqual(blocks[1]["source"]["data"], "AAAA")

    def test_maybe_recheck_vision_detects_health_and_v1_models(self):
        ap = load_proxy(PROXY_VISION="auto")
        ap._last_vision_recheck_ts = 0.0
        ap.upstream_vision = False

        # Case 1: Basalt /health -> {"images": true} while /props returns 404
        def mk_resp(status, payload):
            r = MagicMock()
            r.status_code = status
            r.json.return_value = payload
            return r

        async def fake_get_basalt(url, **kwargs):
            if url.endswith("/props"):
                return mk_resp(404, {})
            if url.endswith("/health"):
                return mk_resp(200, {"status": "ok", "images": True})
            return mk_resp(404, {})

        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=fake_get_basalt)
        with patch.object(ap, "http_client", mock_client):
            asyncio.run(ap._maybe_recheck_vision())
        self.assertTrue(ap.upstream_vision)

        # Case 2: Infernix/vLLM /v1/models -> architecture.input_modalities includes "image"
        ap._last_vision_recheck_ts = 0.0
        ap.upstream_vision = False

        async def fake_get_infernix(url, **kwargs):
            if url.endswith("/props"):
                return mk_resp(404, {})
            if url.endswith("/health"):
                return mk_resp(200, {"status": "ok"})
            if url.endswith("/v1/models"):
                return mk_resp(200, {"data": [{"id": "qwen-vl", "architecture": {"input_modalities": ["text", "image"]}}]})
            return mk_resp(404, {})

        mock_client2 = MagicMock()
        mock_client2.get = AsyncMock(side_effect=fake_get_infernix)
        with patch.object(ap, "http_client", mock_client2):
            asyncio.run(ap._maybe_recheck_vision())
        self.assertTrue(ap.upstream_vision)

    def test_turn_count_finalize_breaker_keeps_thinking_on_with_holistic_audit(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_HARD_FINALIZE_TURNS="3",
            PROXY_ARCHAEOLOGY_CAP="0",
            PROXY_SINGLE_FILE_REFLECT_THRESHOLD="0",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        msgs = [{"role": "user", "content": "Deliver the feature"}]
        for i in range(3):
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": f"t_{i}", "name": "Read", "input": {"file_path": f"src/f{i}.ts"}}
                    ],
                }
            )
            msgs.append(
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": f"t_{i}", "content": "ok"}],
                }
            )
        body = {"model": "qwen3.8-flash-next", "max_tokens": 4096, "tools": _sample_tools(), "messages": msgs}
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertNotIn("tools", openai_body)
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        tail = openai_body["messages"][-1]["content"]
        self.assertIn("Holistic Outcome Audit", tail)


if __name__ == "__main__":
    unittest.main()
