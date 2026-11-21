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
    "PROXY_MULTIMODAL_CRITIQUE_PROMPT",
    "PROXY_HARD_FINALIZE_CTX_THRESHOLD",
    "PROXY_CTK_SKIP_PROBE_WHEN_WARM",
    "PROXY_CHAT_TEMPLATE_KWARGS",
    "PROXY_TOOL_CALL_GRAMMAR",
    "PROXY_ARCHAEOLOGY_CAP",
    "PROXY_SINGLE_FILE_REFLECT_THRESHOLD",
    "PROXY_HARD_FINALIZE_TURNS",
    "PROXY_VISION",
    "PROXY_SLOT_SAVE_RESTORE",
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

        # Case A (Item 6): Actively progressing session (<85% ctx, not stalled)
        # runs a NON-DISRUPTIVE periodic Holistic Outcome Audit: tools stay
        # attached, tool_choice="auto", Thinking ON, no text-tool suppression.
        active_monitor = ap.SessionMonitor()
        openai_active = ap.build_openai_request(body, active_monitor)
        self.assertIn("tools", openai_active)
        self.assertEqual(openai_active.get("tool_choice"), "auto")
        self.assertTrue(ap._thinking_enabled_on_body(openai_active))
        self.assertFalse(active_monitor.suppress_text_tool_extraction)
        tail_active = openai_active["messages"][-1]["content"]
        self.assertIn("Holistic Outcome Audit", tail_active)

        # Case B (Item 6): High context utilization (>= 85%) or genuine stall
        # still hard-strips tools to force finalization safely.
        high_ctx_monitor = ap.SessionMonitor(context_window=200000)
        high_ctx_monitor.last_input_tokens = 180000
        openai_high_ctx = ap.build_openai_request(body, high_ctx_monitor)
        self.assertNotIn("tools", openai_high_ctx)
        self.assertTrue(ap._thinking_enabled_on_body(openai_high_ctx))
        self.assertTrue(high_ctx_monitor.suppress_text_tool_extraction)
        self.assertIn("Holistic Outcome Audit", openai_high_ctx["messages"][-1]["content"])

    # --- Item 1: System-prompt KV-prefix invariance ---
    def test_system_prompt_is_byte_identical_across_thinking_toggle(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
            PROXY_CHAT_TEMPLATE_KWARGS="auto",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap._ctk_supported = True

        routine_body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "system": "You are a helpful engineering agent.",
            "tools": _sample_tools(),
            "messages": [
                {"role": "user", "content": "Inspect files"},
                {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.ts"}}],
                },
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
            ],
        }
        error_body = {
            **routine_body,
            "messages": [
                {"role": "user", "content": "Inspect files"},
                {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "t1", "name": "Execute", "input": {"command": "npm test"}}],
                },
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": "FAIL: assertion failed"}],
                },
            ],
        }
        oai_off = ap.build_openai_request(routine_body, ap.SessionMonitor())
        oai_on = ap.build_openai_request(error_body, ap.SessionMonitor())

        self.assertFalse(ap._thinking_enabled_on_body(oai_off))
        self.assertTrue(ap._thinking_enabled_on_body(oai_on))
        # messages[0] (system prompt) MUST remain byte-identical across turns
        self.assertEqual(oai_off["messages"][0]["content"], oai_on["messages"][0]["content"])
        self.assertNotIn(ap._NO_THINKING_DIRECTIVE, oai_off["messages"][0]["content"])

        # Even when chat_template_kwargs is unsupported (_ctk_supported=False),
        # _NO_THINKING_DIRECTIVE goes to trailing user turn, NEVER messages[0].
        ap._ctk_supported = False
        oai_off_no_ctk = ap.build_openai_request(routine_body, ap.SessionMonitor())
        oai_on_no_ctk = ap.build_openai_request(error_body, ap.SessionMonitor())
        self.assertEqual(oai_off_no_ctk["messages"][0]["content"], oai_on_no_ctk["messages"][0]["content"])
        self.assertNotIn(ap._NO_THINKING_DIRECTIVE.strip(), oai_off_no_ctk["messages"][0]["content"])
        # The tail-append helper strips the directive's leading \n\n separator.
        self.assertIn(ap._NO_THINKING_DIRECTIVE.strip(), str(oai_off_no_ctk["messages"][-1]["content"]))
        self.assertNotIn(ap._NO_THINKING_DIRECTIVE.strip(), str(oai_on_no_ctk["messages"][-1]["content"]))

    # --- Item 2: Idempotent placement refresh + skip warm CTK "hi" probe ---
    def test_idempotent_placement_refresh_preserves_state_when_model_unchanged(self):
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="auto")
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap._ctk_supported = True
        ap._ctk_probed = True
        # _admitted_sessions is an OrderedDict (session_id -> last-seen ts).
        ap._admitted_sessions["sess-1"] = 1234.5

        # Live /v1/models reports the same model -> no-op, caches intact
        with patch.object(ap, "_fetch_live_upstream_model_ids", AsyncMock(return_value=["Qwen3.8-Flash-Next"])):
            cleared, unchanged = asyncio.run(ap.refresh_upstream_caches_if_changed(force=False))
        self.assertTrue(unchanged)
        self.assertEqual(cleared, [])
        self.assertEqual(ap._upstream_model_ids, ["Qwen3.8-Flash-Next"])
        self.assertTrue(ap._ctk_probed)
        self.assertTrue(ap._ctk_supported)
        self.assertIn("sess-1", ap._admitted_sessions)

        # Live /v1/models reports a different model -> real swap invalidates caches
        with patch.object(ap, "_fetch_live_upstream_model_ids", AsyncMock(return_value=["Qwen3.8-Different"])):
            cleared2, unchanged2 = asyncio.run(ap.refresh_upstream_caches_if_changed(force=False))
        self.assertFalse(unchanged2)
        # Labels match invalidate_upstream_caches(); CTK probe state re-arms
        # only in 'auto' mode, which is why this test loads with it.
        self.assertIn("upstream_model_ids", cleared2)
        self.assertIn("chat_template_kwargs_probe", cleared2)
        self.assertIn("admitted_sessions", cleared2)
        self.assertIsNone(ap._upstream_model_ids)
        self.assertIsNone(ap._ctk_supported)
        self.assertFalse(ap._ctk_probed)
        self.assertNotIn("sess-1", ap._admitted_sessions)

    def test_ctk_probe_skips_synthetic_completion_when_session_is_warm(self):
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="auto", PROXY_CTK_SKIP_PROBE_WHEN_WARM="on")
        ap._ctk_probed = False
        ap._ctk_supported = None
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap._slot_owner_session = "active-session-1"

        mock_client = MagicMock()
        mock_client.post = AsyncMock()
        with patch.object(ap, "http_client", mock_client):
            asyncio.run(ap._probe_chat_template_kwargs())

        # Zero synthetic "hi" completion requests hit the warm backend
        mock_client.post.assert_not_called()
        self.assertTrue(ap._ctk_probed)
        self.assertIsNone(ap._ctk_supported)
        self.assertTrue(ap._ctk_allowed())

    # --- Item 3: Basalt-safe slot save/restore latch ---
    def test_slot_save_404_latches_unsupported_and_skips_future_probes(self):
        ap = load_proxy(PROXY_SLOT_SAVE_RESTORE="on")
        ap._slot_owner_session = "sess-a"
        ap._slot_save_supported = None

        r404 = MagicMock()
        r404.status_code = 404
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=r404)

        with patch.object(ap, "http_client", mock_client):
            # Session switch sess-a -> sess-b: _save_slot POSTs once, gets 404,
            # and latches unsupported.
            asyncio.run(ap._ensure_slot_for_session(mock_client, "sess-b"))
            self.assertIs(ap._slot_save_supported, False)
            first_calls = mock_client.post.call_count
            self.assertGreaterEqual(first_calls, 1)

            # Subsequent session switch must make ZERO /slots HTTP calls
            asyncio.run(ap._ensure_slot_for_session(mock_client, "sess-c"))
            self.assertEqual(mock_client.post.call_count, first_calls)

        # Actual model swap resets the latch for re-detection
        ap.invalidate_upstream_caches()
        self.assertIsNone(ap._slot_save_supported)

    # --- Item 4: Multi-user trailing scan & benign autoroute exclusion ---
    def test_multimodal_signal_survives_trailing_system_reminder_user_message(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
            PROXY_MULTIMODAL_CRITIQUE_PROMPT="on",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "tools": _sample_tools(),
            "messages": [
                {"role": "user", "content": "Inspect the rendered output"},
                {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "shot.png"}}],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "r1",
                            "content": [
                                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
                            ],
                        }
                    ],
                },
                # Harness appends a trailing system-reminder as a second user message
                {"role": "user", "content": "<system-reminder>Continue working.</system-reminder>"},
            ],
        }
        self.assertEqual(ap._latest_turn_cognitive_signal(body), "multimodal_observation")
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertTrue(ap._thinking_enabled_on_body(openai_body))
        # Item 5: Visual & Systemic Critique micro-prompt injected on trailing user turn, NOT messages[0]
        self.assertNotIn("shared upstream root causes", openai_body["messages"][0]["content"])
        self.assertIn("shared upstream root causes", str(openai_body["messages"][-1]["content"]))

    def test_benign_autoroute_replay_notice_does_not_trigger_verification_failure(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_THINKING_ON_OBSERVATION_TURNS="on",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        benign_body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "tools": _sample_tools(),
            "messages": [
                {"role": "user", "content": "Update App.jsx"},
                {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "e1", "name": "Edit", "input": {"file_path": "src/App.jsx"}}],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "e1",
                            "is_error": True,
                            "content": (
                                "[UAP policy blocked: delivery-enforcement] Direct edit recorded; "
                                "auto-applying to disk via deterministic `uap deliver --pending` replay."
                            ),
                        }
                    ],
                },
            ],
        }
        self.assertIsNone(ap._latest_turn_cognitive_signal(benign_body))
        openai_benign = ap.build_openai_request(benign_body, ap.SessionMonitor())
        self.assertFalse(ap._thinking_enabled_on_body(openai_benign))

        # A real policy block (no deterministic-replay marker) STILL triggers thinking ON
        real_block_body = {
            **benign_body,
            "messages": [
                benign_body["messages"][0],
                benign_body["messages"][1],
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "e1",
                            "is_error": True,
                            "content": "[UAP policy blocked: worktree-required] Run `uap worktree create` first.",
                        }
                    ],
                },
            ],
        }
        self.assertEqual(ap._latest_turn_cognitive_signal(real_block_body), "verification_failure")

    # --- Item 7 (proxy side): Fast JSON verdict keeps thinking OFF and bounded max_tokens ---
    def test_json_response_verdict_keeps_thinking_off_and_bounded_max_tokens(self):
        ap = load_proxy(PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on")
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]
        ap.JSON_RESPONSE_GBNF = ""  # Even without GBNF grammar file

        body = {
            "model": "qwen3.8-flash-next",
            "max_tokens": 4096,
            "_uap_json_response": True,
            "messages": [{"role": "user", "content": "Return JSON verdict"}],
        }
        openai_body = ap.build_openai_request(body, ap.SessionMonitor())
        self.assertFalse(ap._thinking_enabled_on_body(openai_body))
        self.assertEqual(openai_body["max_tokens"], 4096)

    # --- Item 8: Script-Mode B2 guardrail parsing ---
    def test_script_wrapper_calls_feed_archaeology_and_single_file_churn_guardrails(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_ARCHAEOLOGY_CAP="4",
            PROXY_SINGLE_FILE_REFLECT_THRESHOLD="3",
            PROXY_HARD_FINALIZE_TURNS="0",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next"]

        # 1) 4 consecutive vendor reads inside Script tool -> vendor_archaeology_cap
        arch_msgs = [{"role": "user", "content": "Build app"}]
        for i in range(4):
            arch_msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": f"s_{i}",
                            "name": "Script",
                            "input": {
                                "code": (
                                    f'const r = await tools.Read({{ file_path: "node_modules/three/build/chunk{i}.js" }});\n'
                                    "return r;"
                                )
                            },
                        }
                    ],
                }
            )
            arch_msgs.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"s_{i}", "content": "ok"}]}
            )
        arch_body = {"model": "qwen3.8-flash-next", "max_tokens": 4096, "tools": _sample_tools(), "messages": arch_msgs}
        hit_arch = ap._detect_compute_budget_guardrail(arch_body)
        self.assertIsNotNone(hit_arch)
        self.assertEqual(hit_arch[0], "vendor_archaeology_cap")

        # 2) 3 edits to the same file inside Script tool -> single_file_churn_reflect
        churn_msgs = [{"role": "user", "content": "Fix scene"}]
        for i in range(3):
            churn_msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": f"c_{i}",
                            "name": "Script",
                            "input": {
                                "code": (
                                    f'await tools.Edit({{ file_path: "src/App.jsx", old_str: "v{i}", new_str: "v{i+1}" }});'
                                )
                            },
                        }
                    ],
                }
            )
            churn_msgs.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"c_{i}", "content": "ok"}]}
            )
        churn_body = {"model": "qwen3.8-flash-next", "max_tokens": 4096, "tools": _sample_tools(), "messages": churn_msgs}
        hit_churn = ap._detect_compute_budget_guardrail(churn_body)
        self.assertIsNotNone(hit_churn)
        self.assertEqual(hit_churn[0], "single_file_churn_reflect")

        # 3) A behavioral Execute verification inside Script resets the churn streak
        churn_msgs.append(
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "c_test",
                        "name": "Script",
                        "input": {"code": 'await tools.Execute({ command: "npm test" });'},
                    }
                ],
            }
        )
        churn_msgs.append(
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c_test", "content": "PASS"}]}
        )
        self.assertIsNone(ap._detect_compute_budget_guardrail(churn_body))


if __name__ == "__main__":
    unittest.main()
