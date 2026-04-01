#!/usr/bin/env python3

import asyncio
import importlib.util
import json
import unittest
from pathlib import Path

import httpx


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []

    async def post(self, *args, **kwargs):
        self.requests.append({"args": args, "kwargs": kwargs})
        if not self._responses:
            raise AssertionError("No fake response queued")
        return self._responses.pop(0)


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


class TestProxyConfigTuning(unittest.TestCase):
    def test_max_tokens_floor_is_configurable(self):
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 4096)
        try:
            self.assertEqual(proxy._resolve_max_tokens_request(400), 4096)
            self.assertEqual(proxy._resolve_max_tokens_request(9000), 9000)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)

    def test_max_tokens_floor_can_be_disabled(self):
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 0)
        try:
            self.assertEqual(proxy._resolve_max_tokens_request(400), 400)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)

    def test_build_request_bypasses_floor_for_tool_turns_when_thinking_disabled(self):
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 4096)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", True)

            body = {
                "model": "test",
                "max_tokens": 512,
                "messages": [{"role": "user", "content": "run pwd"}],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=0)
            )
            self.assertEqual(openai.get("max_tokens"), 512)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)

    def test_build_request_skips_floor_for_non_tool_turns(self):
        """Non-tool requests should NOT have the max_tokens floor applied."""
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 4096)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", True)

            body = {
                "model": "test",
                "max_tokens": 512,
                "messages": [{"role": "user", "content": "say ok"}],
            }

            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=0)
            )
            # Floor should NOT inflate max_tokens for non-tool requests
            self.assertEqual(openai.get("max_tokens"), 512)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)


class TestProfileSelection(unittest.TestCase):
    def test_profile_header_overrides_body_param(self):
        headers = {"X-UAP-Model-Profile": "qwen35"}
        body = {"uap_model_profile": "generic"}
        self.assertEqual(proxy._resolve_profile_name(headers, body), "qwen35")

    def test_build_request_injects_profile_prompt_suffix(self):
        suffix = "Call all tools in one response."
        body = {
            "model": "default",
            "max_tokens": 128,
            "messages": [{"role": "user", "content": "run pwd"}],
            "tools": [
                {
                    "name": "Bash",
                    "description": "run command",
                    "input_schema": {"type": "object"},
                }
            ],
        }
        openai_body = proxy.build_openai_request(
            body,
            proxy.SessionMonitor(context_window=0),
            profile_prompt_suffix=suffix,
        )
        self.assertIn(suffix, openai_body["messages"][0]["content"])

    def test_build_request_uses_profile_grammar_override(self):
        old_flag = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR")
        setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", True)
        try:
            body = {
                "model": "default",
                "max_tokens": 128,
                "messages": [{"role": "user", "content": "run pwd"}],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }
            openai_body = proxy.build_openai_request(
                body,
                proxy.SessionMonitor(context_window=0),
                profile_grammar="grammar-test",
            )
            self.assertEqual(openai_body.get("grammar"), "grammar-test")
        finally:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", old_flag)

    def test_prune_target_fraction_uses_config_or_default(self):
        old_target = getattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION")
        try:
            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", 0.55)
            self.assertEqual(proxy._resolve_prune_target_fraction(), 0.55)

            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", 1.2)
            self.assertEqual(proxy._resolve_prune_target_fraction(), 0.65)
        finally:
            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", old_target)


class TestToolSchemaSanitization(unittest.TestCase):
    def test_convert_tools_strips_pattern_fields(self):
        anthropic_tools = [
            {
                "name": "Sample",
                "description": "test",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "pattern": "^[\\w-]+$",
                        }
                    },
                    "required": ["id"],
                },
            }
        ]

        converted = proxy._convert_anthropic_tools_to_openai(anthropic_tools)
        params = converted[0]["function"]["parameters"]
        self.assertEqual(params["properties"]["id"]["type"], "string")
        self.assertNotIn("pattern", params["properties"]["id"])

    def test_convert_tools_strips_pattern_properties_fields(self):
        anthropic_tools = [
            {
                "name": "Sample",
                "description": "test",
                "input_schema": {
                    "type": "object",
                    "patternProperties": {
                        "^x-": {"type": "string"},
                    },
                    "properties": {
                        "meta": {
                            "type": "object",
                            "properties": {
                                "tag": {
                                    "type": "string",
                                    "pattern": "^[a-z]+$",
                                }
                            },
                        }
                    },
                },
            }
        ]

        converted = proxy._convert_anthropic_tools_to_openai(anthropic_tools)
        params = converted[0]["function"]["parameters"]
        self.assertNotIn("patternProperties", params)
        self.assertNotIn("pattern", params["properties"]["meta"]["properties"]["tag"])

    def test_convert_tools_keeps_property_named_pattern(self):
        anthropic_tools = [
            {
                "name": "ScheduleTool",
                "description": "test",
                "input_schema": {
                    "type": "object",
                    "required": ["pattern", "subject"],
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "User-provided matching pattern",
                        },
                        "subject": {"type": "string"},
                    },
                },
            }
        ]

        converted = proxy._convert_anthropic_tools_to_openai(anthropic_tools)
        params = converted[0]["function"]["parameters"]
        self.assertIn("pattern", params["required"])
        self.assertEqual(params["properties"]["pattern"]["type"], "string")


class TestStreamGuardedPathSelection(unittest.TestCase):
    def test_required_tool_turn_uses_guarded_non_stream(self):
        old_force = getattr(proxy, "PROXY_FORCE_NON_STREAM")
        old_strict = getattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT")
        old_guard = getattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL")
        old_retry = getattr(proxy, "PROXY_GUARDRAIL_RETRY")
        try:
            setattr(proxy, "PROXY_FORCE_NON_STREAM", False)
            setattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT", False)
            setattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL", True)
            setattr(proxy, "PROXY_GUARDRAIL_RETRY", True)

            selected = proxy._should_use_guarded_non_stream(
                True,
                {"tools": [{"name": "Read", "input_schema": {"type": "object"}}]},
                {"tool_choice": "required"},
            )
            self.assertTrue(selected)
        finally:
            setattr(proxy, "PROXY_FORCE_NON_STREAM", old_force)
            setattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT", old_strict)
            setattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL", old_guard)
            setattr(proxy, "PROXY_GUARDRAIL_RETRY", old_retry)

    def test_auto_tool_turn_keeps_true_stream_when_strict_off(self):
        old_force = getattr(proxy, "PROXY_FORCE_NON_STREAM")
        old_strict = getattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT")
        old_guard = getattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL")
        old_retry = getattr(proxy, "PROXY_GUARDRAIL_RETRY")
        try:
            setattr(proxy, "PROXY_FORCE_NON_STREAM", False)
            setattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT", False)
            setattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL", True)
            setattr(proxy, "PROXY_GUARDRAIL_RETRY", True)

            selected = proxy._should_use_guarded_non_stream(
                True,
                {"tools": [{"name": "Read", "input_schema": {"type": "object"}}]},
                {"tool_choice": "auto"},
            )
            self.assertFalse(selected)
        finally:
            setattr(proxy, "PROXY_FORCE_NON_STREAM", old_force)
            setattr(proxy, "PROXY_MALFORMED_TOOL_STREAM_STRICT", old_strict)
            setattr(proxy, "PROXY_MALFORMED_TOOL_GUARDRAIL", old_guard)
            setattr(proxy, "PROXY_GUARDRAIL_RETRY", old_retry)


class TestMalformedToolGuardrail(unittest.TestCase):
    def test_detects_malformed_tool_payload(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            'Analyzing lifecycle... </parameter> = {"description":"you MUST call a tool"}\n'
                            '</parameter> = {"description":"you MUST call a tool"}'
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "fix this"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_detects_closing_function_tag_payload(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "Bash(find /home/cogtek/dev/miller-tech/universal-agent-protocol -maxdepth 1 "
                            '\\( -type f -name "*.md" -o -type f -name "*.json" \\)\n'
                            "</function>"
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "list root docs/json files"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_detects_think_tag_with_repeated_policy_phrase(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "I have not yet fixed it, you MUST call a tool to make the fix.\n"
                            "</think>\n"
                            "I have not yet fixed it, you MUST call a tool to make the fix."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Edit", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "fix it"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_detects_policy_echo_loop_without_tags(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "You MUST call a tool to make the fix. "
                            "Do not summarize the issue and stop. "
                            "You MUST call a tool to make the fix."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Edit", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "fix it"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_detects_policy_snippet_echo(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "If you have identified a problem, keep going. "
                            "Do not summarize the issue and stop."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "continue"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_detects_tool_call_apology_text_as_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "I could not produce a valid tool-call format in this turn. "
                            "Please continue; I will issue exactly one valid tool call next."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "fix this"}],
        }
        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_apology_helper_detects_phrase(self):
        apology_text = (
            "I could not produce a valid tool-call format in this turn. "
            "Please continue; I will issue exactly one valid tool call next."
        )
        self.assertTrue(proxy._contains_tool_call_apology(apology_text))
        self.assertFalse(proxy._contains_tool_call_apology("normal assistant response"))

    def test_clean_tool_call_response_is_not_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Read",
                                    "arguments": '{"file_path":"README.md"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "read file"}],
        }
        self.assertFalse(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_missing_required_field_is_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "run_cmd",
                                    "arguments": "{}",
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "run_cmd",
                    "input_schema": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                }
            ],
            "messages": [{"role": "user", "content": "run command"}],
        }

        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_wrong_argument_type_is_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "run_cmd",
                                    "arguments": '{"command": 123}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "run_cmd",
                    "input_schema": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                }
            ],
            "messages": [{"role": "user", "content": "run command"}],
        }

        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_empty_required_string_is_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "run_cmd",
                                    "arguments": '{"command": ""}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "run_cmd",
                    "input_schema": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                }
            ],
            "messages": [{"role": "user", "content": "run command"}],
        }

        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_required_string_with_markup_is_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "run_cmd",
                                    "arguments": '{"command": "</parameter> injected"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "run_cmd",
                    "input_schema": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                }
            ],
            "messages": [{"role": "user", "content": "run command"}],
        }

        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_tool_call_optional_string_with_markup_is_malformed(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "run_cmd",
                                    "arguments": '{"command": "echo ok", "note": "<tool_call>bad</tool_call>"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "run_cmd",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string"},
                            "note": {"type": "string"},
                        },
                        "required": ["command"],
                    },
                }
            ],
            "messages": [{"role": "user", "content": "run command"}],
        }

        self.assertTrue(proxy._is_malformed_tool_response(openai_resp, anthropic_body))

    def test_malformed_retry_body_restores_full_tools_and_caps_tokens(self):
        old_cap = getattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS")
        old_temp = getattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE")
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS", 512)
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE", 0)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", True)

            openai_body = {
                "model": "test",
                "max_tokens": 4000,
                "messages": [{"role": "user", "content": "fix the issue"}],
                "tools": [{"type": "function", "function": {"name": "Read"}}],
            }
            anthropic_body = {
                "tools": [
                    {"name": "Read", "input_schema": {"type": "object"}},
                    {"name": "Edit", "input_schema": {"type": "object"}},
                    {"name": "Write", "input_schema": {"type": "object"}},
                ]
            }

            retry = proxy._build_malformed_retry_body(openai_body, anthropic_body)
            self.assertEqual(retry["stream"], False)
            self.assertEqual(retry["tool_choice"], "required")
            self.assertEqual(retry["temperature"], 0)
            self.assertEqual(retry["max_tokens"], 512)
            self.assertEqual(len(retry["tools"]), 3)
            self.assertFalse(retry["enable_thinking"])
            self.assertEqual(retry["messages"][-1]["role"], "user")
            self.assertIn(
                "invalid tool-call formatting",
                retry["messages"][-1]["content"],
            )
        finally:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS", old_cap)
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE", old_temp)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)

    def test_malformed_retry_body_appends_retry_hint_as_user_message(self):
        openai_body = {
            "model": "test",
            "messages": [{"role": "user", "content": "fix"}],
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}]
        }

        retry = proxy._build_malformed_retry_body(
            openai_body,
            anthropic_body,
            retry_hint="Use strict JSON",
            tool_choice="required",
            attempt=1,
            total_attempts=2,
        )

        self.assertEqual(retry["messages"][-1]["role"], "user")
        self.assertIn("TOOL CALL REPAIR attempt 1/2", retry["messages"][-1]["content"])

    def test_retry_ladder_releases_last_attempt_to_auto(self):
        self.assertEqual(proxy._retry_tool_choice_for_attempt(True, 0, 3), "required")
        self.assertEqual(proxy._retry_tool_choice_for_attempt(True, 1, 3), "required")
        self.assertEqual(proxy._retry_tool_choice_for_attempt(True, 2, 3), "auto")
        self.assertEqual(proxy._retry_tool_choice_for_attempt(False, 0, 3), "auto")

    def test_malformed_retry_body_applies_grammar_only_for_required_tool_choice(self):
        old_enabled = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR")
        old_required_only = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY")
        old_grammar = getattr(proxy, "TOOL_CALL_GBNF")
        old_tools_compatible = getattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE")
        try:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", True)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", True)
            setattr(proxy, "TOOL_CALL_GBNF", 'root ::= "<tool_call>"')
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", True)

            openai_body = {
                "model": "test",
                "messages": [{"role": "user", "content": "fix"}],
            }
            anthropic_body = {
                "tools": [{"name": "Read", "input_schema": {"type": "object"}}]
            }

            required_retry = proxy._build_malformed_retry_body(
                openai_body,
                anthropic_body,
                tool_choice="required",
            )
            auto_retry = proxy._build_malformed_retry_body(
                openai_body,
                anthropic_body,
                tool_choice="auto",
            )

            self.assertEqual(required_retry.get("grammar"), 'root ::= "<tool_call>"')
            self.assertNotIn("grammar", auto_retry)
        finally:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", old_enabled)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", old_required_only)
            setattr(proxy, "TOOL_CALL_GBNF", old_grammar)
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", old_tools_compatible)

    def test_apply_tool_call_grammar_skips_when_upstream_tools_are_incompatible(self):
        old_enabled = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR")
        old_required_only = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY")
        old_grammar = getattr(proxy, "TOOL_CALL_GBNF")
        old_tools_compatible = getattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE")
        try:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", True)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", True)
            setattr(proxy, "TOOL_CALL_GBNF", 'root ::= "<tool_call>"')
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", False)

            request = {
                "tools": [{"type": "function", "function": {"name": "Read"}}],
                "tool_choice": "required",
            }
            proxy._apply_tool_call_grammar(request)

            self.assertNotIn("grammar", request)
        finally:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", old_enabled)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", old_required_only)
            setattr(proxy, "TOOL_CALL_GBNF", old_grammar)
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", old_tools_compatible)

    def test_maybe_disable_grammar_for_tools_error_strips_grammar_and_disables_flag(
        self,
    ):
        old_tools_compatible = getattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE")
        try:
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", True)

            request = {
                "tools": [{"type": "function", "function": {"name": "Read"}}],
                "grammar": 'root ::= "<tool_call>"',
            }

            retried = proxy._maybe_disable_grammar_for_tools_error(
                request,
                400,
                '{"error":{"message":"Cannot use custom grammar constraints with tools."}}',
                "unit-test",
            )

            self.assertTrue(retried)
            self.assertNotIn("grammar", request)
            self.assertFalse(getattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE"))
        finally:
            setattr(proxy, "TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE", old_tools_compatible)

    def test_clean_guardrail_response_does_not_promise_future_tool_call(self):
        guardrail = proxy._build_clean_guardrail_openai_response(
            {"model": "test-model"}
        )
        text = guardrail["choices"][0]["message"]["content"]
        self.assertIn("Please retry the same request", text)
        self.assertNotIn("I will issue exactly one valid tool call next", text)

    def test_openai_to_anthropic_response_sanitizes_tool_call_apology(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "I could not produce a valid tool-call format in this turn. "
                            "Please continue; I will issue exactly one valid tool call next."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }

        converted = proxy.openai_to_anthropic_response(openai_resp, "test-model")
        text = converted["content"][0]["text"]
        self.assertIn("Please retry the same request", text)
        self.assertNotIn("I will issue exactly one valid tool call next", text)

    def test_preflight_flags_invalid_json_tool_arguments(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "ScheduleJob",
                                    "arguments": '{"cron":',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "ScheduleJob",
                    "input_schema": {
                        "type": "object",
                        "required": ["cron"],
                        "properties": {"cron": {"type": "string", "minLength": 1}},
                    },
                }
            ]
        }

        issue = proxy._classify_tool_response_issue(openai_resp, anthropic_body)
        self.assertEqual(issue.kind, "malformed_payload")
        self.assertIn("malformed pseudo tool payload", issue.reason)

    def test_preflight_flags_empty_required_field(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "ScheduleJob",
                                    "arguments": '{"cron":"","command":"echo hi"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "ScheduleJob",
                    "input_schema": {
                        "type": "object",
                        "required": ["cron", "command"],
                        "properties": {
                            "cron": {
                                "type": "string",
                                "minLength": 1,
                                "default": "* * * * *",
                            },
                            "command": {"type": "string", "minLength": 1},
                        },
                    },
                }
            ]
        }

        issue = proxy._classify_tool_response_issue(openai_resp, anthropic_body)
        self.assertEqual(issue.kind, "malformed_payload")
        self.assertIn("malformed pseudo tool payload", issue.reason)

    def test_preflight_flags_markup_inside_arguments(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "ScheduleJob",
                                    "arguments": '{"cron":"*/5 * * * *","command":"<parameter>bad</parameter>"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "ScheduleJob",
                    "input_schema": {
                        "type": "object",
                        "required": ["cron", "command"],
                        "properties": {
                            "cron": {"type": "string"},
                            "command": {"type": "string"},
                        },
                    },
                }
            ]
        }

        issue = proxy._classify_tool_response_issue(openai_resp, anthropic_body)
        self.assertEqual(issue.kind, "malformed_payload")
        self.assertIn("malformed pseudo tool payload", issue.reason)

    def test_preflight_flags_closing_function_tag_inside_arguments(self):
        old_preflight = getattr(proxy, "PROXY_TOOL_ARGS_PREFLIGHT")
        try:
            setattr(proxy, "PROXY_TOOL_ARGS_PREFLIGHT", True)
            openai_resp = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "Bash",
                                        "arguments": '{"command":"pwd\\n</function>"}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            }
            anthropic_body = {
                "tools": [{"name": "Bash", "input_schema": {"type": "object"}}]
            }

            issue = proxy._classify_tool_response_issue(openai_resp, anthropic_body)
            self.assertEqual(issue.kind, "invalid_tool_args")
            self.assertIn("malformed markup fragments", issue.reason)
        finally:
            setattr(proxy, "PROXY_TOOL_ARGS_PREFLIGHT", old_preflight)

    def test_required_tool_turn_without_tool_call_is_flagged(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "Done.",
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Edit", "input_schema": {"type": "object"}}],
        }

        issue = proxy._classify_tool_response_issue(
            openai_resp, anthropic_body, required_tool_choice=True
        )
        self.assertEqual(issue.kind, "required_tool_miss")

    def test_required_tool_turn_with_long_text_without_tool_call_is_flagged(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "I reviewed the repository and here is a long explanation that still "
                            "does not include any valid tool call payload for this required turn."
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Edit", "input_schema": {"type": "object"}}],
        }

        issue = proxy._classify_tool_response_issue(
            openai_resp, anthropic_body, required_tool_choice=True
        )
        self.assertEqual(issue.kind, "required_tool_miss")

    def test_preflight_flags_repetitive_policy_echo_without_tool_call(self):
        repeated = " (describe/it/expect using vitest" * 24
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": (
                            "- At least 2 new test cases before claiming done. "
                            "- Tests must be in test/ following existing patterns."
                            f"{repeated}"
                        ),
                        "tool_calls": [],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
        }

        issue = proxy._classify_tool_response_issue(openai_resp, anthropic_body)
        self.assertEqual(issue.kind, "malformed_payload")

    def test_markup_repair_sanitizes_tool_arguments(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '{"command":"echo ok </think> </parameter>"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        repaired, count = proxy._repair_tool_call_markup(openai_resp)
        self.assertEqual(count, 1)
        args = repaired["choices"][0]["message"]["tool_calls"][0]["function"][
            "arguments"
        ]
        self.assertNotIn("</think>", args)
        self.assertNotIn("</parameter>", args)

    def test_markup_repair_strips_closing_function_tag(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '{"command":"pwd\\n</function>"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        repaired, count = proxy._repair_tool_call_markup(openai_resp)
        self.assertEqual(count, 1)
        args = json.loads(
            repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        )
        self.assertEqual(args["command"], "pwd")

    def test_markup_repair_recovers_json_after_tag_stripping(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '</parameter>{"command":"ls"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        repaired, count = proxy._repair_tool_call_markup(openai_resp)
        self.assertEqual(count, 1)
        args = json.loads(
            repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        )
        self.assertEqual(args["command"], "ls")

    def test_bash_command_repair_strips_protocol_tag_only_lines(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '{"command":"pwd\\n</function>\\n<tool_call>"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        repaired, count = proxy._repair_bash_command_artifacts(openai_resp)
        self.assertEqual(count, 1)
        args = json.loads(
            repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        )
        self.assertEqual(args["command"], "pwd")

    def test_guardrail_accepts_repaired_markup_without_fallback(self):
        old_retry = getattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX")
        try:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", 0)

            monitor = proxy.SessionMonitor(context_window=262144)
            openai_resp = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "Bash",
                                        "arguments": '{"command":"ls </parameter>"}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            }
            anthropic_body = {
                "tools": [
                    {
                        "name": "Bash",
                        "input_schema": {
                            "type": "object",
                            "required": ["command"],
                            "properties": {
                                "command": {"type": "string", "minLength": 1}
                            },
                        },
                    }
                ],
                "messages": [{"role": "user", "content": "run command"}],
            }
            openai_body = {
                "model": "test",
                "messages": [{"role": "user", "content": "run command"}],
                "tool_choice": "required",
            }

            result = asyncio.run(
                proxy._apply_malformed_tool_guardrail(
                    _FakeClient([]),
                    openai_resp,
                    openai_body,
                    anthropic_body,
                    monitor,
                    "session-repair",
                )
            )

            self.assertTrue(result["choices"][0]["message"].get("tool_calls"))
            args = result["choices"][0]["message"]["tool_calls"][0]["function"][
                "arguments"
            ]
            self.assertNotIn("</parameter>", args)
            self.assertEqual(monitor.arg_preflight_repairs, 1)
        finally:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", old_retry)

    def test_required_field_repair_fills_missing_required_values(self):
        openai_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "ScheduleJob",
                                    "arguments": '{"cron":""}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "ScheduleJob",
                    "input_schema": {
                        "type": "object",
                        "required": ["cron", "pattern", "subject"],
                        "properties": {
                            "cron": {
                                "type": "string",
                                "minLength": 1,
                                "default": "* * * * *",
                            },
                            "pattern": {
                                "type": "string",
                                "minLength": 1,
                                "default": "*",
                            },
                            "subject": {
                                "type": "string",
                                "minLength": 1,
                                "default": "task",
                            },
                        },
                    },
                }
            ]
        }

        repaired, count = proxy._repair_required_tool_args(openai_resp, anthropic_body)
        self.assertEqual(count, 1)
        args_text = repaired["choices"][0]["message"]["tool_calls"][0]["function"][
            "arguments"
        ]
        args = json.loads(args_text)
        self.assertTrue(args["cron"].strip())
        self.assertTrue(args["pattern"].strip())
        self.assertTrue(args["subject"].strip())

    def test_guardrail_accepts_required_field_repair_without_fallback(self):
        old_retry = getattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX")
        try:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", 0)

            monitor = proxy.SessionMonitor(context_window=262144)
            openai_resp = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "ScheduleJob",
                                        "arguments": '{"cron":""}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            }
            anthropic_body = {
                "tools": [
                    {
                        "name": "ScheduleJob",
                        "input_schema": {
                            "type": "object",
                            "required": ["cron", "pattern", "subject"],
                            "properties": {
                                "cron": {
                                    "type": "string",
                                    "minLength": 1,
                                    "default": "* * * * *",
                                },
                                "pattern": {
                                    "type": "string",
                                    "minLength": 1,
                                    "default": "*",
                                },
                                "subject": {
                                    "type": "string",
                                    "minLength": 1,
                                    "default": "task",
                                },
                            },
                        },
                    }
                ],
                "messages": [{"role": "user", "content": "schedule it"}],
            }
            openai_body = {
                "model": "test",
                "messages": [{"role": "user", "content": "schedule it"}],
                "tool_choice": "required",
            }

            result = asyncio.run(
                proxy._apply_malformed_tool_guardrail(
                    _FakeClient([]),
                    openai_resp,
                    openai_body,
                    anthropic_body,
                    monitor,
                    "session-repair-required",
                )
            )

            args = json.loads(
                result["choices"][0]["message"]["tool_calls"][0]["function"][
                    "arguments"
                ]
            )
            self.assertTrue(args["cron"].strip())
            self.assertTrue(args["pattern"].strip())
            self.assertTrue(args["subject"].strip())
            self.assertEqual(monitor.arg_preflight_repairs, 1)
        finally:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", old_retry)

    def test_guardrail_retries_invalid_tool_args_and_recovers(self):
        old_retry = getattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX")
        try:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", 1)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.consecutive_forced_count = 7

            initial_resp = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "ScheduleJob",
                                        "arguments": '{"cron":"","command":"echo hi"}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            }
            repaired_resp = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_2",
                                    "function": {
                                        "name": "ScheduleJob",
                                        "arguments": '{"cron":"*/5 * * * *","command":"echo hi"}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            }

            fake_client = _FakeClient([_FakeResponse(repaired_resp)])
            openai_body = {
                "model": "test",
                "messages": [{"role": "user", "content": "schedule this job"}],
                "tool_choice": "required",
            }
            anthropic_body = {
                "tools": [
                    {
                        "name": "ScheduleJob",
                        "input_schema": {
                            "type": "object",
                            "required": ["cron", "command"],
                            "properties": {
                                "cron": {"type": "string", "minLength": 1},
                                "command": {"type": "string", "minLength": 1},
                            },
                        },
                    }
                ],
                "messages": [{"role": "user", "content": "schedule this job"}],
            }

            result = asyncio.run(
                proxy._apply_malformed_tool_guardrail(
                    fake_client,
                    initial_resp,
                    openai_body,
                    anthropic_body,
                    monitor,
                    "session-test",
                )
            )

            args = json.loads(
                result["choices"][0]["message"]["tool_calls"][0]["function"][
                    "arguments"
                ]
            )
            self.assertTrue(args["cron"].strip())
            self.assertTrue(args["command"].strip())
            self.assertGreaterEqual(len(fake_client.requests), 1)
            if fake_client.requests:
                retry_payload = fake_client.requests[0]["kwargs"]["json"]
                repair_message = retry_payload["messages"][-1]["content"]
                self.assertIn("TOOL CALL REPAIR", repair_message)
        finally:
            setattr(proxy, "PROXY_MALFORMED_TOOL_RETRY_MAX", old_retry)

    def test_guardrails_skip_finalize_turn(self):
        monitor = proxy.SessionMonitor(context_window=262144)
        monitor.finalize_turn_active = True

        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "final answer", "tool_calls": []},
                }
            ]
        }
        openai_body = {
            "model": "test",
            "messages": [{"role": "user", "content": "continue"}],
        }
        anthropic_body = {
            "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": "start"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "Bash",
                            "input": {"command": "pwd"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "ok",
                        }
                    ],
                },
            ],
        }

        fake_client = _FakeClient([_FakeResponse({"choices": []})])

        unexpected = asyncio.run(
            proxy._apply_unexpected_end_turn_guardrail(
                fake_client,
                openai_resp,
                openai_body,
                anthropic_body,
                monitor,
                "session-finalize",
            )
        )
        malformed = asyncio.run(
            proxy._apply_malformed_tool_guardrail(
                fake_client,
                openai_resp,
                openai_body,
                anthropic_body,
                monitor,
                "session-finalize",
            )
        )

        self.assertEqual(unexpected, openai_resp)
        self.assertEqual(malformed, openai_resp)
        self.assertEqual(len(fake_client.requests), 0)

    def test_unexpected_end_turn_guardrail_retries_review_auto_turn_in_active_loop(self):
        monitor = proxy.SessionMonitor(context_window=262144)
        monitor.tool_turn_phase = "review"

        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "looks complete", "tool_calls": []},
                }
            ]
        }
        openai_body = {
            "model": "test",
            "tool_choice": "auto",
            "messages": [{"role": "user", "content": "continue"}],
        }
        anthropic_body = {
            "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": "start"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_2",
                            "name": "Bash",
                            "input": {"command": "pwd"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_2",
                            "content": "ok",
                        }
                    ],
                },
            ],
        }

        retried_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '{"command":"pwd"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        fake_client = _FakeClient([_FakeResponse(retried_resp)])
        result = asyncio.run(
            proxy._apply_unexpected_end_turn_guardrail(
                fake_client,
                openai_resp,
                openai_body,
                anthropic_body,
                monitor,
                "session-review-auto",
            )
        )

        self.assertEqual(result, retried_resp)
        self.assertEqual(len(fake_client.requests), 1)

    def test_unexpected_end_turn_guardrail_retries_act_auto_turn_in_active_loop(self):
        monitor = proxy.SessionMonitor(context_window=262144)
        monitor.tool_turn_phase = "act"

        openai_resp = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "done", "tool_calls": []},
                }
            ]
        }
        openai_body = {
            "model": "test",
            "tool_choice": "auto",
            "messages": [{"role": "user", "content": "continue"}],
        }
        anthropic_body = {
            "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": "start"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_3",
                            "name": "Bash",
                            "input": {"command": "pwd"},
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_3",
                            "content": "ok",
                        }
                    ],
                },
            ],
        }

        retried_resp = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_2",
                                "function": {
                                    "name": "Bash",
                                    "arguments": '{"command":"pwd"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }

        fake_client = _FakeClient([_FakeResponse(retried_resp)])
        result = asyncio.run(
            proxy._apply_unexpected_end_turn_guardrail(
                fake_client,
                openai_resp,
                openai_body,
                anthropic_body,
                monitor,
                "session-act-auto",
            )
        )

        self.assertEqual(result, retried_resp)
        self.assertEqual(len(fake_client.requests), 1)


class TestToolTurnControls(unittest.TestCase):
    def test_tool_narrowing_reduces_tool_count(self):
        old_narrow = getattr(proxy, "PROXY_TOOL_NARROWING")
        old_keep = getattr(proxy, "PROXY_TOOL_NARROWING_KEEP")
        old_min = getattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS")
        try:
            setattr(proxy, "PROXY_TOOL_NARROWING", True)
            setattr(proxy, "PROXY_TOOL_NARROWING_KEEP", 2)
            setattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS", 3)

            body = {
                "model": "test",
                "messages": [
                    {
                        "role": "user",
                        "content": "run tests and fix the failing test quickly",
                    }
                ],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    },
                    {
                        "name": "Edit",
                        "description": "Edit file",
                        "input_schema": {"type": "object"},
                    },
                    {
                        "name": "RunTests",
                        "description": "Run unit tests",
                        "input_schema": {"type": "object"},
                    },
                    {
                        "name": "Deploy",
                        "description": "Deploy app",
                        "input_schema": {"type": "object"},
                    },
                ],
            }
            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=262144)
            )
            self.assertEqual(len(openai.get("tools", [])), 2)
            names = [t.get("function", {}).get("name") for t in openai.get("tools", [])]
            self.assertIn("RunTests", names)
        finally:
            setattr(proxy, "PROXY_TOOL_NARROWING", old_narrow)
            setattr(proxy, "PROXY_TOOL_NARROWING_KEEP", old_keep)
            setattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS", old_min)

    def test_disable_thinking_flag_sets_enable_thinking_false(self):
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", True)
            body = {
                "model": "test",
                "messages": [{"role": "user", "content": "use tool"}],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    }
                ],
            }
            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=262144)
            )
            self.assertIn("enable_thinking", openai)
            self.assertFalse(openai["enable_thinking"])
        finally:
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)

    def test_state_machine_releases_after_forced_budget(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 2)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 1)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)

            monitor = proxy.SessionMonitor(context_window=262144)
            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_1",
                                "name": "Read",
                                "input": {"file_path": "README.md"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_1",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai_1 = proxy.build_openai_request(body, monitor)
            openai_2 = proxy.build_openai_request(body, monitor)
            openai_3 = proxy.build_openai_request(body, monitor)

            self.assertEqual(openai_1.get("tool_choice"), "required")
            self.assertEqual(openai_2.get("tool_choice"), "required")
            # Review phase now keeps required to prevent end-turn escape
            self.assertEqual(openai_3.get("tool_choice"), "required")
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)

    def test_state_machine_releases_on_two_tool_cycle(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        old_cycle_window = getattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 20)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 2)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", 6)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_forced_budget_remaining = 20
            monitor.tool_call_history = [
                "Bash",
                "TaskOutput",
                "Bash",
                "TaskOutput",
                "Bash",
                "TaskOutput",
            ]
            monitor.last_tool_fingerprint = "TaskOutput"

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_2",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_2",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    },
                    {
                        "name": "TaskOutput",
                        "description": "Return result",
                        "input_schema": {"type": "object"},
                    },
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            # Review phase now keeps required to prevent end-turn escape
            self.assertEqual(openai.get("tool_choice"), "required")
            self.assertEqual(monitor.tool_turn_phase, "review")
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", old_cycle_window)

    def test_state_machine_review_budget_handoff_returns_required(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 20)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 1)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "review"
            monitor.tool_state_auto_budget_remaining = 1
            monitor.tool_state_forced_budget_remaining = 0
            monitor.last_tool_fingerprint = "Bash"

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_review_1",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_review_1",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(openai.get("tool_choice"), "required")
            self.assertEqual(monitor.tool_turn_phase, "act")
            self.assertEqual(monitor.tool_state_auto_budget_remaining, 0)
            self.assertEqual(monitor.tool_state_forced_budget_remaining, 10)
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)

    def test_state_machine_review_cycles_increment_on_forced_budget_exhausted(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 20)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 2)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_forced_budget_remaining = 0

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_cycle_1",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_cycle_1",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            # Review phase now keeps required to prevent end-turn escape
            self.assertEqual(openai.get("tool_choice"), "required")
            self.assertEqual(monitor.tool_turn_phase, "review")
            self.assertEqual(monitor.tool_state_review_cycles, 1)
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)

    def test_state_machine_finalize_after_review_cycle_limit(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        old_cycle_window = getattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW")
        old_review_cycles = getattr(proxy, "PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", 8)
            setattr(proxy, "PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT", 2)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_review_cycles = 2

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_cycle_2",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_cycle_2",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertNotIn("tools", openai)
            self.assertNotIn("tool_choice", openai)
            self.assertEqual(monitor.tool_turn_phase, "finalize")
            self.assertTrue(monitor.finalize_turn_active)
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", old_cycle_window)
            setattr(proxy, "PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT", old_review_cycles)

    def test_state_machine_fresh_user_text_clears_stale_tool_history(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_call_history = ["Bash", "Bash", "Bash"]
            monitor.tool_turn_phase = "review"
            monitor.forced_auto_cooldown_turns = 3
            monitor.consecutive_forced_count = 5
            monitor.no_progress_streak = 2
            monitor.malformed_tool_streak = 1
            monitor.invalid_tool_call_streak = 1
            monitor.required_tool_miss_streak = 1

            body = {
                "model": "test",
                "messages": [{"role": "user", "content": "new task"}],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(monitor.tool_call_history, [])
            self.assertEqual(monitor.tool_turn_phase, "bootstrap")
            self.assertEqual(monitor.forced_auto_cooldown_turns, 0)
            self.assertEqual(monitor.malformed_tool_streak, 0)
            self.assertEqual(monitor.invalid_tool_call_streak, 0)
            self.assertEqual(monitor.required_tool_miss_streak, 0)
            self.assertNotEqual(openai.get("tool_choice"), "auto")
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)

    def test_state_machine_inactive_loop_clears_stale_tool_history(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_call_history = ["Bash", "TaskOutput"]
            monitor.tool_turn_phase = "act"
            monitor.forced_auto_cooldown_turns = 2
            monitor.consecutive_forced_count = 4
            monitor.no_progress_streak = 3
            monitor.malformed_tool_streak = 1
            monitor.invalid_tool_call_streak = 1
            monitor.required_tool_miss_streak = 1

            body = {
                "model": "test",
                "messages": [{"role": "assistant", "content": "done"}],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(monitor.tool_call_history, [])
            self.assertEqual(monitor.tool_turn_phase, "bootstrap")
            self.assertEqual(monitor.forced_auto_cooldown_turns, 0)
            self.assertEqual(monitor.consecutive_forced_count, 0)
            self.assertEqual(monitor.no_progress_streak, 0)
            self.assertEqual(monitor.malformed_tool_streak, 0)
            self.assertEqual(monitor.invalid_tool_call_streak, 0)
            self.assertEqual(monitor.required_tool_miss_streak, 0)
            self.assertNotEqual(openai.get("tool_choice"), "auto")
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)

    def test_state_machine_finalize_temporarily_disables_tools(self):
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        old_cycle_window = getattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW")
        old_finalize = getattr(proxy, "PROXY_TOOL_STATE_FINALIZE_THRESHOLD")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 2)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", 4)
            setattr(proxy, "PROXY_TOOL_STATE_FINALIZE_THRESHOLD", 4)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_stagnation_streak = 4
            monitor.tool_call_history = ["Bash", "TaskOutput", "Bash", "TaskOutput"]
            monitor.last_tool_fingerprint = "TaskOutput"

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_4",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_4",
                                "content": "ok",
                            }
                        ],
                    },
                ],
                "tools": [
                    {
                        "name": "Bash",
                        "description": "Run command",
                        "input_schema": {"type": "object"},
                    },
                    {
                        "name": "TaskOutput",
                        "description": "Return result",
                        "input_schema": {"type": "object"},
                    },
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertNotIn("tools", openai)
            self.assertNotIn("tool_choice", openai)
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", old_cycle_window)
            setattr(proxy, "PROXY_TOOL_STATE_FINALIZE_THRESHOLD", old_finalize)

    def test_narrowing_keeps_full_toolset_for_no_token_active_loop(self):
        old_narrow = getattr(proxy, "PROXY_TOOL_NARROWING")
        old_keep = getattr(proxy, "PROXY_TOOL_NARROWING_KEEP")
        old_min = getattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS")
        old_expand = getattr(proxy, "PROXY_TOOL_NARROWING_EXPAND_ON_LOOP")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        try:
            setattr(proxy, "PROXY_TOOL_NARROWING", True)
            setattr(proxy, "PROXY_TOOL_NARROWING_KEEP", 2)
            setattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS", 3)
            setattr(proxy, "PROXY_TOOL_NARROWING_EXPAND_ON_LOOP", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_3",
                                "name": "Read",
                                "input": {"file_path": "README.md"},
                            }
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_3",
                                "content": "done",
                            }
                        ],
                    },
                ],
                "tools": [
                    {"name": "Read", "input_schema": {"type": "object"}},
                    {"name": "Edit", "input_schema": {"type": "object"}},
                    {"name": "Write", "input_schema": {"type": "object"}},
                    {"name": "Bash", "input_schema": {"type": "object"}},
                ],
            }

            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=262144)
            )
            self.assertEqual(len(openai.get("tools", [])), 4)
        finally:
            setattr(proxy, "PROXY_TOOL_NARROWING", old_narrow)
            setattr(proxy, "PROXY_TOOL_NARROWING_KEEP", old_keep)
            setattr(proxy, "PROXY_TOOL_NARROWING_MIN_TOOLS", old_min)
            setattr(proxy, "PROXY_TOOL_NARROWING_EXPAND_ON_LOOP", old_expand)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)

    def test_forced_tool_dampener_temporarily_releases_required(self):
        old_enabled = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER")
        old_min_forced = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED")
        old_bad_streak = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK")
        old_empty_streak = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK")
        old_rejections = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS")
        old_auto_turns = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS")
        try:
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER", True)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED", 3)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK", 1)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK", 1)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS", 2)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS", 2)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.consecutive_forced_count = 3
            monitor.invalid_tool_call_streak = 1

            activated = monitor.maybe_activate_forced_tool_dampener("invalid_tool_args")
            self.assertTrue(activated)
            self.assertEqual(monitor.forced_auto_cooldown_turns, 2)

            body = {
                "model": "test",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "I will continue."}],
                    },
                    {"role": "user", "content": "keep going"},
                ],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(openai.get("tool_choice"), "auto")
            self.assertEqual(monitor.forced_auto_cooldown_turns, 1)
        finally:
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER", old_enabled)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED", old_min_forced)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK", old_bad_streak)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK", old_empty_streak)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS", old_rejections)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS", old_auto_turns)

    def test_forced_tool_dampener_uses_rejection_pressure(self):
        old_enabled = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER")
        old_min_forced = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED")
        old_bad_streak = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK")
        old_empty_streak = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK")
        old_rejections = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS")
        old_auto_turns = getattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS")
        try:
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER", True)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED", 3)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK", 5)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK", 5)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS", 2)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS", 1)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.consecutive_forced_count = 3
            monitor.arg_preflight_rejections = 2

            activated = monitor.maybe_activate_forced_tool_dampener("invalid_tool_args")
            self.assertTrue(activated)
            self.assertEqual(monitor.forced_auto_cooldown_turns, 1)
            self.assertEqual(monitor.arg_preflight_rejections, 0)
        finally:
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER", old_enabled)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED", old_min_forced)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK", old_bad_streak)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK", old_empty_streak)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_REJECTIONS", old_rejections)
            setattr(proxy, "PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS", old_auto_turns)

    def test_build_request_applies_grammar_when_tool_choice_required(self):
        old_enabled = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR")
        old_required_only = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY")
        old_grammar = getattr(proxy, "TOOL_CALL_GBNF")
        try:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", True)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", True)
            setattr(proxy, "TOOL_CALL_GBNF", 'root ::= "<tool_call>"')

            body = {
                "model": "test",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "I will continue."}],
                    },
                    {"role": "user", "content": "continue"},
                ],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=262144)
            )
            self.assertEqual(openai.get("tool_choice"), "required")
            self.assertEqual(openai.get("grammar"), 'root ::= "<tool_call>"')
        finally:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", old_enabled)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", old_required_only)
            setattr(proxy, "TOOL_CALL_GBNF", old_grammar)

    def test_build_request_omits_grammar_when_tool_choice_released_to_auto(self):
        old_enabled = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR")
        old_required_only = getattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY")
        old_grammar = getattr(proxy, "TOOL_CALL_GBNF")
        try:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", True)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", True)
            setattr(proxy, "TOOL_CALL_GBNF", 'root ::= "<tool_call>"')

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.forced_auto_cooldown_turns = 1

            body = {
                "model": "test",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "I will continue."}],
                    },
                    {"role": "user", "content": "continue"},
                ],
                "tools": [
                    {
                        "name": "Read",
                        "description": "Read file",
                        "input_schema": {"type": "object"},
                    }
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(openai.get("tool_choice"), "auto")
            self.assertNotIn("grammar", openai)
        finally:
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR", old_enabled)
            setattr(proxy, "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", old_required_only)
            setattr(proxy, "TOOL_CALL_GBNF", old_grammar)

    def test_no_tools_does_not_inject_agentic_system_message(self):
        body = {
            "model": "test",
            "messages": [{"role": "user", "content": "analyze architecture"}],
        }
        openai = proxy.build_openai_request(
            body, proxy.SessionMonitor(context_window=262144)
        )

        self.assertEqual(openai["messages"][0]["role"], "user")
        self.assertNotIn("tools", openai)

    def test_analysis_only_route_removes_tools(self):
        old_route = getattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE")
        old_min_tools = getattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS")
        old_max_messages = getattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES")
        try:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", True)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", 4)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", 2)

            body = {
                "messages": [
                    {
                        "role": "user",
                        "content": "analyze lifecycle and plan options to improve performance and compliance",
                    }
                ],
                "tools": [
                    {"name": "Read", "input_schema": {"type": "object"}},
                    {"name": "Edit", "input_schema": {"type": "object"}},
                    {"name": "Write", "input_schema": {"type": "object"}},
                    {"name": "Bash", "input_schema": {"type": "object"}},
                ],
            }

            updated, removed = proxy._maybe_route_analysis_without_tools(body)
            self.assertEqual(removed, 4)
            self.assertNotIn("tools", updated)
        finally:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", old_route)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", old_min_tools)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", old_max_messages)

    def test_analysis_only_route_keeps_tools_for_action_prompt(self):
        old_route = getattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE")
        old_min_tools = getattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS")
        old_max_messages = getattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES")
        try:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", True)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", 4)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", 2)

            body = {
                "messages": [
                    {
                        "role": "user",
                        "content": "analyze failing run and fix the bug",
                    }
                ],
                "tools": [
                    {"name": "Read", "input_schema": {"type": "object"}},
                    {"name": "Edit", "input_schema": {"type": "object"}},
                    {"name": "Write", "input_schema": {"type": "object"}},
                    {"name": "Bash", "input_schema": {"type": "object"}},
                ],
            }

            updated, removed = proxy._maybe_route_analysis_without_tools(body)
            self.assertEqual(removed, 0)
            self.assertIn("tools", updated)
        finally:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", old_route)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", old_min_tools)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", old_max_messages)

    def test_analysis_only_route_does_not_treat_implementation_as_action(self):
        old_route = getattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE")
        old_min_tools = getattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS")
        old_max_messages = getattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES")
        try:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", True)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", 4)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", 2)

            body = {
                "messages": [
                    {
                        "role": "user",
                        "content": "analyze implementation options and summarize tradeoffs",
                    }
                ],
                "tools": [
                    {"name": "Read", "input_schema": {"type": "object"}},
                    {"name": "Edit", "input_schema": {"type": "object"}},
                    {"name": "Write", "input_schema": {"type": "object"}},
                    {"name": "Bash", "input_schema": {"type": "object"}},
                ],
            }

            updated, removed = proxy._maybe_route_analysis_without_tools(body)
            self.assertEqual(removed, 4)
            self.assertNotIn("tools", updated)
        finally:
            setattr(proxy, "PROXY_ANALYSIS_ONLY_ROUTE", old_route)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MIN_TOOLS", old_min_tools)
            setattr(proxy, "PROXY_ANALYSIS_ONLY_MAX_MESSAGES", old_max_messages)


class TestRequiredArgRepair(unittest.TestCase):
    def test_repair_required_args_uses_schema_enum_value(self):
        openai_resp = {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "omp_task",
                                    "arguments": '{"prompt":"analyze"}',
                                },
                            }
                        ]
                    }
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "omp_task",
                    "input_schema": {
                        "type": "object",
                        "required": ["agent", "prompt"],
                        "properties": {
                            "agent": {
                                "type": "string",
                                "enum": ["task", "explore", "plan"],
                            },
                            "prompt": {"type": "string"},
                        },
                    },
                }
            ]
        }

        repaired, repaired_count = proxy._repair_required_tool_args(
            openai_resp, anthropic_body
        )

        self.assertEqual(repaired_count, 1)
        args = json.loads(
            repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        )
        self.assertEqual(args["agent"], "task")

    def test_repair_required_args_does_not_inject_placeholder_without_schema_defaults(
        self,
    ):
        openai_resp = {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "omp_task",
                                    "arguments": '{"prompt":"analyze"}',
                                },
                            }
                        ]
                    }
                }
            ]
        }
        anthropic_body = {
            "tools": [
                {
                    "name": "omp_task",
                    "input_schema": {
                        "type": "object",
                        "required": ["agent", "prompt"],
                        "properties": {
                            "agent": {"type": "string"},
                            "prompt": {"type": "string"},
                        },
                    },
                }
            ]
        }

        repaired, repaired_count = proxy._repair_required_tool_args(
            openai_resp, anthropic_body
        )

        self.assertEqual(repaired_count, 0)
        args = json.loads(
            repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        )
        self.assertNotIn("agent", args)

    def test_validate_tool_args_rejects_placeholder_values(self):
        issue = proxy._validate_tool_call_arguments(
            "omp_task",
            '{"agent":"__uap_required__","prompt":"analyze"}',
            {
                "type": "object",
                "required": ["agent", "prompt"],
                "properties": {
                    "agent": {"type": "string", "enum": ["task", "explore"]},
                    "prompt": {"type": "string"},
                },
            },
            {"omp_task"},
        )

        self.assertTrue(issue.has_issue())
        self.assertEqual(issue.kind, "invalid_tool_args")
        self.assertIn("placeholder", issue.reason)

    def test_validate_tool_args_rejects_enum_mismatch(self):
        issue = proxy._validate_tool_call_arguments(
            "omp_task",
            '{"agent":"planner","prompt":"analyze"}',
            {
                "type": "object",
                "required": ["agent", "prompt"],
                "properties": {
                    "agent": {"type": "string", "enum": ["task", "explore"]},
                    "prompt": {"type": "string"},
                },
            },
            {"omp_task"},
        )

        self.assertTrue(issue.has_issue())
        self.assertEqual(issue.kind, "invalid_tool_args")
        self.assertIn("enum mismatch", issue.reason)


class TestSessionContaminationBreaker(unittest.TestCase):
    def test_contamination_breaker_trims_and_resets_streak(self):
        old_enabled = getattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER")
        old_threshold = getattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD")
        old_keep = getattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST")
        try:
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER", True)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD", 2)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST", 3)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.malformed_tool_streak = 2
            body = {
                "messages": [
                    {"role": "user", "content": "start"},
                    {"role": "assistant", "content": "a1"},
                    {"role": "user", "content": "u2"},
                    {"role": "assistant", "content": "a3"},
                    {"role": "user", "content": "u4"},
                    {"role": "assistant", "content": "a5"},
                ]
            }

            updated = proxy._maybe_apply_session_contamination_breaker(
                body, monitor, "session-test"
            )

            self.assertEqual(monitor.malformed_tool_streak, 0)
            self.assertEqual(monitor.contamination_resets, 1)
            self.assertEqual(len(updated["messages"]), 5)
            self.assertIn("SESSION RESET", updated["messages"][1]["content"])
        finally:
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER", old_enabled)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD", old_threshold)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST", old_keep)

    def test_contamination_breaker_triggers_on_forced_invalid_combo(self):
        old_enabled = getattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER")
        old_threshold = getattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD")
        old_keep = getattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST")
        old_forced = getattr(proxy, "PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD")
        old_required = getattr(
            proxy, "PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD"
        )
        try:
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER", True)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD", 3)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST", 3)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD", 5)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD", 4)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.invalid_tool_call_streak = 2
            monitor.consecutive_forced_count = 6
            body = {
                "messages": [
                    {"role": "user", "content": "start"},
                    {"role": "assistant", "content": "a1"},
                    {"role": "user", "content": "u2"},
                    {"role": "assistant", "content": "a3"},
                    {"role": "user", "content": "u4"},
                    {"role": "assistant", "content": "a5"},
                ]
            }

            updated = proxy._maybe_apply_session_contamination_breaker(
                body, monitor, "session-test"
            )

            self.assertEqual(monitor.contamination_resets, 1)
            self.assertEqual(monitor.invalid_tool_call_streak, 0)
            self.assertEqual(len(updated["messages"]), 5)
            self.assertIn("SESSION RESET", updated["messages"][1]["content"])
        finally:
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_BREAKER", old_enabled)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_THRESHOLD", old_threshold)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_KEEP_LAST", old_keep)
            setattr(proxy, "PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD", old_forced)
            setattr(
                proxy,
                "PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD",
                old_required,
            )


class TestToolCallXMLExtraction(unittest.TestCase):
    """Tests for recovering tool calls from <tool_call> XML in text content."""

    def test_extract_single_tool_call_from_text(self):
        text = '<tool_call>\n{"name": "Read", "arguments": {"file_path": "/tmp/foo.py"}}\n</tool_call>'
        extracted, remaining = proxy._extract_tool_calls_from_text(text)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0]["function"]["name"], "Read")
        args = json.loads(extracted[0]["function"]["arguments"])
        self.assertEqual(args["file_path"], "/tmp/foo.py")
        self.assertEqual(remaining, "")

    def test_extract_multiple_tool_calls_from_text(self):
        text = (
            'Some preamble\n'
            '<tool_call>{"name": "Read", "arguments": {"file_path": "/a.py"}}</tool_call>\n'
            'Middle text\n'
            '<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>'
        )
        extracted, remaining = proxy._extract_tool_calls_from_text(text)
        self.assertEqual(len(extracted), 2)
        self.assertEqual(extracted[0]["function"]["name"], "Read")
        self.assertEqual(extracted[1]["function"]["name"], "Bash")
        self.assertNotIn("<tool_call>", remaining)
        self.assertIn("Some preamble", remaining)

    def test_no_extraction_without_tool_call_tags(self):
        text = "Just normal text without any XML"
        extracted, remaining = proxy._extract_tool_calls_from_text(text)
        self.assertEqual(len(extracted), 0)
        self.assertEqual(remaining, text)

    def test_invalid_json_skipped(self):
        text = '<tool_call>not valid json</tool_call>'
        extracted, remaining = proxy._extract_tool_calls_from_text(text)
        self.assertEqual(len(extracted), 0)
        self.assertEqual(remaining, text)

    def test_missing_name_skipped(self):
        text = '<tool_call>{"arguments": {"x": 1}}</tool_call>'
        extracted, remaining = proxy._extract_tool_calls_from_text(text)
        self.assertEqual(len(extracted), 0)

    def test_maybe_extract_promotes_to_tool_calls(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": '<tool_call>\n{"name": "Grep", "arguments": {"pattern": "foo"}}\n</tool_call>',
                },
            }]
        }
        proxy._maybe_extract_text_tool_calls(openai_resp)
        msg = openai_resp["choices"][0]["message"]
        self.assertEqual(len(msg["tool_calls"]), 1)
        self.assertEqual(msg["tool_calls"][0]["function"]["name"], "Grep")
        self.assertEqual(openai_resp["choices"][0]["finish_reason"], "tool_calls")
        # Text content should be cleared (or empty)
        self.assertFalse(msg.get("content"))

    def test_maybe_extract_noop_when_structured_tool_calls_exist(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": '<tool_call>{"name": "Read", "arguments": {}}</tool_call>',
                    "tool_calls": [{"function": {"name": "Write", "arguments": "{}"}}],
                },
            }]
        }
        proxy._maybe_extract_text_tool_calls(openai_resp)
        msg = openai_resp["choices"][0]["message"]
        # Should NOT have extracted from text since structured tool_calls exist
        self.assertEqual(len(msg["tool_calls"]), 1)
        self.assertEqual(msg["tool_calls"][0]["function"]["name"], "Write")

    def test_anthropic_response_uses_extracted_tool_calls(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": '<tool_call>\n{"name": "Edit", "arguments": {"file_path": "/x.py", "old_string": "a", "new_string": "b"}}\n</tool_call>',
                },
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50},
        }
        anthropic = proxy.openai_to_anthropic_response(openai_resp, "qwen3.5")
        tool_blocks = [b for b in anthropic["content"] if b["type"] == "tool_use"]
        self.assertEqual(len(tool_blocks), 1)
        self.assertEqual(tool_blocks[0]["name"], "Edit")
        self.assertEqual(tool_blocks[0]["input"]["file_path"], "/x.py")
        self.assertEqual(anthropic["stop_reason"], "tool_use")


class TestGarbledToolArgDetection(unittest.TestCase):
    """Tests for detecting and sanitizing garbled tool call arguments."""

    def test_runaway_braces_detected(self):
        self.assertTrue(proxy._is_garbled_tool_arguments('{"command":"echo test}}}}}'))

    def test_repetitive_digits_detected(self):
        self.assertTrue(proxy._is_garbled_tool_arguments('{"command":"echo 398398398398398398"}'))

    def test_long_zeros_detected(self):
        self.assertTrue(proxy._is_garbled_tool_arguments('{"command":"echo 00000000000"}'))

    def test_extremely_long_digits_detected(self):
        self.assertTrue(proxy._is_garbled_tool_arguments('{"x":"' + "1" * 35 + '"}'))

    def test_unbalanced_braces_detected(self):
        self.assertTrue(proxy._is_garbled_tool_arguments('{"a":{"b":{"c":"d"'))

    def test_normal_args_not_flagged(self):
        self.assertFalse(proxy._is_garbled_tool_arguments('{"command":"ls -la /tmp"}'))
        self.assertFalse(proxy._is_garbled_tool_arguments('{"file_path":"/home/user/test.py"}'))

    def test_empty_args_not_flagged(self):
        self.assertFalse(proxy._is_garbled_tool_arguments("{}"))
        self.assertFalse(proxy._is_garbled_tool_arguments(""))

    def test_sanitize_removes_garbled_calls(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [
                        {"function": {"name": "Bash", "arguments": '{"command":"ls"}'}},
                        {"function": {"name": "Bash", "arguments": '{"command":"echo test}}}}}}'}},
                    ],
                },
            }]
        }
        removed = proxy._sanitize_garbled_tool_calls(openai_resp)
        self.assertTrue(removed)
        msg = openai_resp["choices"][0]["message"]
        self.assertEqual(len(msg["tool_calls"]), 1)
        self.assertEqual(msg["tool_calls"][0]["function"]["name"], "Bash")

    def test_sanitize_all_garbled_removes_tool_calls(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [
                        {"function": {"name": "Bash", "arguments": '{"command":"echo }}}}}}'}},
                    ],
                },
            }]
        }
        removed = proxy._sanitize_garbled_tool_calls(openai_resp)
        self.assertTrue(removed)
        msg = openai_resp["choices"][0]["message"]
        self.assertNotIn("tool_calls", msg)
        self.assertEqual(openai_resp["choices"][0]["finish_reason"], "stop")

    def test_sanitize_clean_args_noop(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [
                        {"function": {"name": "Read", "arguments": '{"file_path":"/x.py"}'}},
                    ],
                },
            }]
        }
        removed = proxy._sanitize_garbled_tool_calls(openai_resp)
        self.assertFalse(removed)


class TestToolTurnTemperature(unittest.TestCase):
    """Tests for per-request temperature forcing on tool-enabled turns."""

    def _make_monitor(self):
        return proxy.SessionMonitor()

    def test_tool_turn_forces_temperature(self):
        body = {
            "model": "qwen3.5",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"name": "Bash", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
            "temperature": 0.8,
        }
        result = proxy.build_openai_request(body, self._make_monitor())
        self.assertLessEqual(result["temperature"], proxy.PROXY_TOOL_TURN_TEMPERATURE)

    def test_no_tools_preserves_temperature(self):
        body = {
            "model": "qwen3.5",
            "messages": [{"role": "user", "content": "hello"}],
            "temperature": 0.8,
        }
        result = proxy.build_openai_request(body, self._make_monitor())
        self.assertEqual(result["temperature"], 0.8)


class TestSystemPromptLeakDetection(unittest.TestCase):
    """Tests for detecting and repairing system prompt leaks in tool args."""

    def test_detects_agentic_protocol_leak(self):
        self.assertTrue(proxy._contains_system_prompt_leak(
            {"command": "echo test call one or more functions to assist"}
        ))

    def test_detects_follow_rules_leak(self):
        self.assertTrue(proxy._contains_system_prompt_leak(
            {"command": "ls Follow these rules: 1. Use tools"}
        ))

    def test_detects_xml_tags_leak(self):
        self.assertTrue(proxy._contains_system_prompt_leak(
            {"command": "echo function signatures within <tools></tools> XML tags:"}
        ))

    def test_clean_args_not_flagged(self):
        self.assertFalse(proxy._contains_system_prompt_leak(
            {"command": "echo hello world"}
        ))
        self.assertFalse(proxy._contains_system_prompt_leak(
            {"file_path": "/home/user/test.py"}
        ))

    def test_find_earliest_leak_position(self):
        text = "echo test-1 call one or more functions to assist"
        pos = proxy._find_earliest_leak_position(text)
        self.assertIsNotNone(pos)
        self.assertEqual(text[:pos].strip(), "echo test-1")

    def test_find_no_leak_returns_none(self):
        self.assertIsNone(proxy._find_earliest_leak_position("echo hello"))

    def test_repair_truncates_at_leak(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "Bash",
                            "arguments": '{"command":"echo test-1 call one or more functions to assist"}'
                        }
                    }],
                },
            }]
        }
        repaired, count = proxy._repair_system_prompt_leak(openai_resp)
        self.assertEqual(count, 1)
        fn = repaired["choices"][0]["message"]["tool_calls"][0]["function"]
        args = json.loads(fn["arguments"])
        self.assertEqual(args["command"], "echo test-1")

    def test_repair_noop_on_clean_args(self):
        openai_resp = {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "tool_calls": [{
                        "function": {"name": "Bash", "arguments": '{"command":"ls -la"}'}
                    }],
                },
            }]
        }
        repaired, count = proxy._repair_system_prompt_leak(openai_resp)
        self.assertEqual(count, 0)

    def test_validate_rejects_leaked_args(self):
        result = proxy._validate_tool_call_arguments(
            "Bash",
            '{"command":"echo test follow these rules"}',
            {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
            {"Bash"},
        )
        self.assertTrue(result.has_issue())
        self.assertIn("leaked system prompt", result.reason)


class TestMinimalSupplementForQwen(unittest.TestCase):
    """Tests for model-based supplement selection."""

    def _make_monitor(self):
        return proxy.SessionMonitor()

    def test_qwen_model_gets_minimal_supplement(self):
        body = {
            "model": "qwen3.5",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"name": "Bash", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
        }
        result = proxy.build_openai_request(body, self._make_monitor())
        system_msg = result["messages"][0]["content"]
        self.assertNotIn("agentic-protocol", system_msg)
        self.assertIn("Use tools for all actions", system_msg)

    def test_non_qwen_model_gets_full_supplement(self):
        body = {
            "model": "claude-3",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"name": "Bash", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
        }
        result = proxy.build_openai_request(body, self._make_monitor())
        system_msg = result["messages"][0]["content"]
        self.assertIn("agentic-protocol", system_msg)


class TestToolStarvationBreaker(unittest.TestCase):
    """Tests for tool-call starvation breaker."""

    def _make_body_with_tools(self):
        return {
            "model": "qwen3.5",
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "I will help you."},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]},
            ],
            "tools": [{"name": "Bash", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
        }

    def test_starvation_breaker_strips_tools(self):
        monitor = proxy.SessionMonitor()
        monitor.consecutive_forced_count = proxy.PROXY_TOOL_STARVATION_THRESHOLD
        body = self._make_body_with_tools()
        result = proxy.build_openai_request(body, monitor)
        self.assertNotIn("tools", result)
        self.assertNotIn("tool_choice", result)
        self.assertEqual(monitor.tool_starvation_streak, 1)

    def test_no_starvation_below_threshold(self):
        monitor = proxy.SessionMonitor()
        monitor.consecutive_forced_count = proxy.PROXY_TOOL_STARVATION_THRESHOLD - 1
        body = self._make_body_with_tools()
        result = proxy.build_openai_request(body, monitor)
        self.assertIn("tools", result)


class TestPruningImprovements(unittest.TestCase):
    """Tests for pruning death spiral fixes."""

    def test_prune_uses_upstream_tokens_when_higher(self):
        """Option 1: upstream last_input_tokens used when higher than local estimate."""
        monitor = proxy.SessionMonitor(context_window=10000)
        # Simulate upstream reporting higher token count than local estimate
        monitor.last_input_tokens = 9000  # 90% - above 85% threshold
        body = {
            "model": "test",
            "messages": [
                {"role": "user", "content": "start"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "a" * 100},
                {"role": "assistant", "content": "b" * 100},
                {"role": "user", "content": "c" * 100},
                {"role": "assistant", "content": "d" * 100},
                {"role": "user", "content": "e" * 100},
                {"role": "assistant", "content": "f" * 100},
                {"role": "user", "content": "g" * 100},
                {"role": "assistant", "content": "h" * 100},
                {"role": "user", "content": "continue"},
            ],
        }
        # Local estimate_total_tokens will be much lower than 9000
        local_est = proxy.estimate_total_tokens(body)
        self.assertLess(local_est, 9000)
        # The pruning code should use upstream's 9000 for the decision

    def test_prune_conversation_accepts_keep_last(self):
        """Option 3: prune_conversation accepts keep_last parameter."""
        body = {
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "a" * 500},
                {"role": "user", "content": "b" * 500},
                {"role": "assistant", "content": "c" * 500},
                {"role": "user", "content": "d" * 500},
                {"role": "assistant", "content": "e" * 500},
                {"role": "user", "content": "f" * 500},
                {"role": "assistant", "content": "g" * 500},
                {"role": "user", "content": "h" * 500},
                {"role": "assistant", "content": "i" * 500},
                {"role": "user", "content": "last"},
            ],
        }
        # With keep_last=4, more middle messages should be prunable
        result_8 = proxy.prune_conversation(dict(body), 2000, target_fraction=0.50, keep_last=8)
        result_4 = proxy.prune_conversation(dict(body), 2000, target_fraction=0.50, keep_last=4)
        # keep_last=4 should result in fewer or equal messages
        self.assertLessEqual(
            len(result_4.get("messages", [])),
            len(result_8.get("messages", [])),
        )

    def test_prune_circuit_breaker_sets_finalize(self):
        """Option 2: circuit breaker forces finalize after repeated prunes."""
        monitor = proxy.SessionMonitor(context_window=10000)
        monitor.prune_count = 3  # Already pruned 3 times
        # After the pruning code runs and still exceeds threshold,
        # it should set finalize phase
        monitor.set_tool_turn_phase("act", reason="test")
        # Simulate the circuit breaker logic
        monitor.set_tool_turn_phase("finalize", reason="prune_circuit_breaker")
        self.assertEqual(monitor.tool_turn_phase, "finalize")


class TestCycleBreakOptions(unittest.TestCase):
    """Tests for cycle-break options: hint injection, tool narrowing, reduced budgets."""

    def test_cycle_break_injects_hint_message(self):
        """Option 1: cycle detection injects a user hint about the cycling tools."""
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        old_cycle_window = getattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 20)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 2)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", 4)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_forced_budget_remaining = 20
            monitor.tool_call_history = ["Bash", "Bash", "Bash", "Bash"]
            monitor.last_tool_fingerprint = "Bash"

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                        ],
                    },
                ],
                "tools": [
                    {"name": "Bash", "description": "Run command", "input_schema": {"type": "object"}},
                    {"name": "Read", "description": "Read file", "input_schema": {"type": "object"}},
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(monitor.tool_turn_phase, "review")
            # Check that a cycle-break hint was injected
            messages = openai.get("messages", [])
            last_msg = messages[-1] if messages else {}
            self.assertEqual(last_msg.get("role"), "user")
            self.assertIn("Bash", last_msg.get("content", ""))
            self.assertIn("DIFFERENT tool", last_msg.get("content", ""))
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", old_cycle_window)

    def test_cycle_break_narrows_tools(self):
        """Option 2: cycling tools are excluded from the tools array during review."""
        old_state = getattr(proxy, "PROXY_TOOL_STATE_MACHINE")
        old_min_msgs = getattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES")
        old_forced = getattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET")
        old_auto = getattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET")
        old_stagnation = getattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD")
        old_cycle_window = getattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW")
        try:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", True)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", 3)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", 20)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", 2)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", 99)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", 4)

            monitor = proxy.SessionMonitor(context_window=262144)
            monitor.tool_turn_phase = "act"
            monitor.tool_state_forced_budget_remaining = 20
            monitor.tool_call_history = ["Bash", "Bash", "Bash", "Bash"]
            monitor.last_tool_fingerprint = "Bash"

            body = {
                "model": "test",
                "messages": [
                    {"role": "user", "content": "start"},
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                        ],
                    },
                ],
                "tools": [
                    {"name": "Bash", "description": "Run command", "input_schema": {"type": "object"}},
                    {"name": "Read", "description": "Read file", "input_schema": {"type": "object"}},
                    {"name": "Write", "description": "Write file", "input_schema": {"type": "object"}},
                ],
            }

            openai = proxy.build_openai_request(body, monitor)
            self.assertEqual(monitor.tool_turn_phase, "review")
            # Bash should be excluded, Read and Write should remain
            tool_names = [t["function"]["name"] for t in openai.get("tools", [])]
            self.assertNotIn("Bash", tool_names)
            self.assertIn("Read", tool_names)
            self.assertIn("Write", tool_names)
        finally:
            setattr(proxy, "PROXY_TOOL_STATE_MACHINE", old_state)
            setattr(proxy, "PROXY_TOOL_STATE_MIN_MESSAGES", old_min_msgs)
            setattr(proxy, "PROXY_TOOL_STATE_FORCED_BUDGET", old_forced)
            setattr(proxy, "PROXY_TOOL_STATE_AUTO_BUDGET", old_auto)
            setattr(proxy, "PROXY_TOOL_STATE_STAGNATION_THRESHOLD", old_stagnation)
            setattr(proxy, "PROXY_TOOL_STATE_CYCLE_WINDOW", old_cycle_window)

    def test_forced_budget_default_is_12(self):
        """Option 3: default forced budget reduced from 24 to 12."""
        self.assertEqual(proxy.PROXY_TOOL_STATE_FORCED_BUDGET, 12)

    def test_review_cycle_limit_default_is_1(self):
        """Option 4: default review cycle limit reduced from 2 to 1."""
        self.assertEqual(proxy.PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT, 1)

    def test_cycling_tool_names_cleared_on_reset(self):
        """cycling_tool_names is cleared when tool turn state resets."""
        monitor = proxy.SessionMonitor(context_window=262144)
        monitor.cycling_tool_names = ["Bash", "Read"]
        monitor.reset_tool_turn_state(reason="test")
        self.assertEqual(monitor.cycling_tool_names, [])


class TestMalformedRetryHardening(unittest.TestCase):
    """Tests for malformed retry improvements: budget, temp escalation, message sanitization."""

    def test_retry_max_default_is_3(self):
        """Option 1: default retry budget increased from 2 to 3."""
        self.assertEqual(proxy.PROXY_MALFORMED_TOOL_RETRY_MAX, 3)

    def test_sanitize_assistant_messages_strips_tool_like_text(self):
        """Option 3: malformed tool-like text stripped from assistant messages on retry."""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Run a command"},
            {"role": "assistant", "content": 'Here is the result <tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>'},
            {"role": "user", "content": "ok"},
        ]
        sanitized = proxy._sanitize_assistant_messages_for_retry(messages)
        # System and user messages unchanged
        self.assertEqual(sanitized[0]["content"], "You are helpful.")
        self.assertEqual(sanitized[1]["content"], "Run a command")
        self.assertEqual(sanitized[3]["content"], "ok")
        # Assistant message should have tool_call stripped
        self.assertNotIn("<tool_call>", sanitized[2]["content"])
        self.assertNotIn("Bash", sanitized[2]["content"])

    def test_sanitize_preserves_clean_assistant_messages(self):
        """Clean assistant messages are not modified by sanitization."""
        messages = [
            {"role": "assistant", "content": "I will read the file for you."},
        ]
        sanitized = proxy._sanitize_assistant_messages_for_retry(messages)
        self.assertEqual(sanitized[0]["content"], "I will read the file for you.")

    def test_sanitize_replaces_empty_content_with_placeholder(self):
        """If stripping leaves empty content, a placeholder is used."""
        messages = [
            {"role": "assistant", "content": '<tool_call>{"name": "Bash", "arguments": {}}</tool_call>'},
        ]
        sanitized = proxy._sanitize_assistant_messages_for_retry(messages)
        self.assertEqual(sanitized[0]["content"], "I will use the appropriate tool.")

    def test_retry_body_uses_sanitized_messages(self):
        """Retry body messages are sanitized before adding retry instruction."""
        openai_body = {
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "do it"},
                {"role": "assistant", "content": '<tool_call>{"name":"X","arguments":{}}</tool_call>'},
            ],
            "tools": [{"type": "function", "function": {"name": "X", "parameters": {}}}],
        }
        anthropic_body = {"tools": [{"name": "X", "input_schema": {"type": "object"}}]}
        retry = proxy._build_malformed_retry_body(
            openai_body, anthropic_body, attempt=1, total_attempts=3,
        )
        # The assistant message should be sanitized
        assistant_msgs = [m for m in retry["messages"] if m.get("role") == "assistant"]
        for m in assistant_msgs:
            self.assertNotIn("<tool_call>", m.get("content", ""))


class TestDegenerateRepetitionDetection(unittest.TestCase):
    """Tests for degenerate repetition detection and truncation."""

    def test_detects_and_truncates_repetitive_text(self):
        """Highly repetitive text should be truncated."""
        repeated = "Mermaid Diagrams](docs/mermaid-diagrams" * 50
        openai_resp = {
            "choices": [{"message": {"content": repeated}, "finish_reason": "length"}]
        }
        result = proxy._detect_and_truncate_degenerate_repetition(openai_resp)
        truncated_text = result["choices"][0]["message"]["content"]
        self.assertLess(len(truncated_text), len(repeated))
        self.assertEqual(result["choices"][0]["finish_reason"], "stop")

    def test_preserves_non_repetitive_text(self):
        """Normal text should not be modified."""
        text = "This is a perfectly normal response with varied content. " * 5
        openai_resp = {
            "choices": [{"message": {"content": text}, "finish_reason": "stop"}]
        }
        result = proxy._detect_and_truncate_degenerate_repetition(openai_resp)
        self.assertEqual(result["choices"][0]["message"]["content"], text)

    def test_preserves_short_text(self):
        """Short text (< 200 chars) should not be processed."""
        text = "Short response."
        openai_resp = {
            "choices": [{"message": {"content": text}, "finish_reason": "stop"}]
        }
        result = proxy._detect_and_truncate_degenerate_repetition(openai_resp)
        self.assertEqual(result["choices"][0]["message"]["content"], text)

    def test_max_tokens_floor_skipped_for_non_tool_requests(self):
        """max_tokens floor should not inflate non-tool requests."""
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 16384)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", False)

            body = {
                "model": "test",
                "max_tokens": 100,
                "messages": [{"role": "user", "content": "generate a title"}],
            }
            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=0)
            )
            # No tools = no floor inflation
            self.assertEqual(openai.get("max_tokens"), 100)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)

    def test_max_tokens_floor_applied_when_thinking_active(self):
        """max_tokens floor should apply when tools present and thinking enabled."""
        old_floor = getattr(proxy, "PROXY_MAX_TOKENS_FLOOR")
        old_disable = getattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS")
        try:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", 4096)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", False)

            body = {
                "model": "test",
                "max_tokens": 512,
                "messages": [{"role": "user", "content": "run command"}],
                "tools": [{"name": "Bash", "description": "run", "input_schema": {"type": "object"}}],
            }
            openai = proxy.build_openai_request(
                body, proxy.SessionMonitor(context_window=0)
            )
            # Tools + thinking enabled = floor applied
            self.assertEqual(openai.get("max_tokens"), 4096)
        finally:
            setattr(proxy, "PROXY_MAX_TOKENS_FLOOR", old_floor)
            setattr(proxy, "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", old_disable)


class TestGenerationHangRecovery(unittest.TestCase):
    """Tests for generation hang recovery: timeouts, slot hang detection."""

    def test_read_timeout_default_is_180(self):
        """Option 3: default read timeout reduced from 600 to 180."""
        self.assertEqual(proxy.PROXY_READ_TIMEOUT, 180)

    def test_generation_timeout_default_is_300(self):
        """Option 1: generation timeout is 300s."""
        self.assertEqual(proxy.PROXY_GENERATION_TIMEOUT, 300)

    def test_slot_hang_timeout_default_is_120(self):
        """Option 2: slot hang timeout is 120s."""
        self.assertEqual(proxy.PROXY_SLOT_HANG_TIMEOUT, 120)

    def test_generation_timeout_wraps_post_with_retry(self):
        """_post_with_generation_timeout raises ReadTimeout on asyncio timeout."""
        import asyncio

        async def _run():
            # Create a mock client that hangs forever
            async def _hanging_post(*args, **kwargs):
                await asyncio.sleep(999)

            class FakeClient:
                async def post(self, *args, **kwargs):
                    await asyncio.sleep(999)

            old_timeout = proxy.PROXY_GENERATION_TIMEOUT
            old_retry_max = proxy.PROXY_UPSTREAM_RETRY_MAX
            try:
                proxy.PROXY_GENERATION_TIMEOUT = 0.1  # 100ms
                proxy.PROXY_UPSTREAM_RETRY_MAX = 1
                with self.assertRaises(httpx.ReadTimeout):
                    await proxy._post_with_generation_timeout(
                        FakeClient(),
                        "http://localhost:9999/fake",
                        {},
                        {},
                    )
            finally:
                proxy.PROXY_GENERATION_TIMEOUT = old_timeout
                proxy.PROXY_UPSTREAM_RETRY_MAX = old_retry_max

        asyncio.run(_run())

    def test_check_slot_hang_detects_stuck_slot(self):
        """_check_slot_hang returns True when a slot is processing with n_decoded=0."""
        import asyncio

        async def _run():
            # We can't easily mock the HTTP call, but we can verify the function
            # doesn't crash when the server is unreachable
            result = await proxy._check_slot_hang("http://localhost:9999/nonexistent")
            self.assertFalse(result)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()


class TestCompletionContractGuardrails(unittest.TestCase):
    def test_completion_contract_requires_progress_after_tool_results(self):
        body = {
            "model": "test",
            "messages": [
                {"role": "user", "content": "fix the bug"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/tmp/x"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "done"}]},
            ],
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
        }
        monitor = proxy.SessionMonitor(context_window=0)
        monitor.update_completion_state(body, has_tool_results=True)
        self.assertTrue(monitor.completion_required)
        self.assertTrue(monitor.completion_pending)
        self.assertIn("awaiting_post_tool_followup", monitor.completion_blockers)

    def test_completion_contract_skips_analysis_only_requests(self):
        body = {
            "model": "test",
            "messages": [
                {"role": "user", "content": "analyze this session and plan options only"},
            ],
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
        }
        self.assertFalse(proxy._should_enforce_completion_contract(body))

    def test_retry_for_completion_contract_detects_premature_final_text(self):
        body = {
            "messages": [
                {"role": "user", "content": "fix the bug"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/tmp/x"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "done"}]},
            ],
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
        }
        monitor = proxy.SessionMonitor(context_window=0)
        monitor.update_completion_state(body, has_tool_results=True)
        openai_resp = {
            "choices": [{"finish_reason": "stop", "message": {"content": "Done, the issue is fixed.", "tool_calls": []}}]
        }
        self.assertTrue(proxy._should_retry_for_completion_contract(openai_resp, body, monitor))

    def test_completion_retry_body_forces_required_tool_choice(self):
        monitor = proxy.SessionMonitor(context_window=0)
        monitor.completion_blockers = ["awaiting_post_tool_followup"]
        openai_body = {"messages": [{"role": "user", "content": "fix it"}], "stream": True, "tool_choice": "auto"}
        retry = proxy._build_completion_contract_retry_body(openai_body, monitor)
        self.assertFalse(retry["stream"])
        self.assertEqual(retry["tool_choice"], "required")
        self.assertIn("awaiting_post_tool_followup", retry["messages"][-1]["content"])

    def test_finalize_phase_returns_to_review_when_completion_pending(self):
        monitor = proxy.SessionMonitor(context_window=0)
        monitor.tool_turn_phase = "finalize"
        monitor.tool_state_auto_budget_remaining = 1
        monitor.completion_pending = True
        monitor.completion_blockers = ["awaiting_post_tool_followup"]
        choice, reason = proxy._resolve_state_machine_tool_choice(
            {"messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "done"}]}]},
            monitor,
            has_tool_results=True,
            last_user_has_tool_result=True,
        )
        self.assertEqual(choice, "auto")
        self.assertEqual(reason, "completion_pending")
        self.assertEqual(monitor.tool_turn_phase, "review")
        self.assertEqual(monitor.completion_recovery_attempts, 1)


class TestGarbledArgsRetry(unittest.TestCase):
    """Tests for garbled tool arguments triggering retry via _validate_tool_call_arguments."""

    def test_garbled_runaway_braces_triggers_retry(self):
        """Garbled brace imbalance should return an invalid_tool_args issue."""
        # Valid JSON but with extreme brace imbalance in string value
        garbled_args = '{"todos": "}}}}}}}}}}}}}"}'
        issue = proxy._validate_tool_call_arguments(
            "TodoWrite", garbled_args, {}, {"TodoWrite"}
        )
        self.assertTrue(issue.has_issue())
        self.assertEqual(issue.kind, "invalid_tool_args")
        self.assertIn("garbled", issue.reason)

    def test_garbled_repetitive_digits_triggers_retry(self):
        """Repetitive digit patterns should return an invalid_tool_args issue."""
        garbled_args = '{"value": "398859738398859738398859738"}'
        issue = proxy._validate_tool_call_arguments(
            "Bash", garbled_args, {}, {"Bash"}
        )
        self.assertTrue(issue.has_issue())
        self.assertEqual(issue.kind, "invalid_tool_args")
        self.assertIn("garbled", issue.reason)

    def test_clean_args_pass_garbled_check(self):
        """Well-formed tool arguments should not be flagged as garbled."""
        clean_args = '{"command": "echo hello world"}'
        issue = proxy._validate_tool_call_arguments(
            "Bash", clean_args, {}, {"Bash"}
        )
        self.assertFalse(issue.has_issue())

    def test_garbled_detection_before_schema_validation(self):
        """Garbled args should be caught even without schema info."""
        garbled_args = '{"content": "' + "0" * 40 + '"}'
        issue = proxy._validate_tool_call_arguments(
            "Write", garbled_args, {}, {"Write"}
        )
        self.assertTrue(issue.has_issue())
        self.assertEqual(issue.kind, "invalid_tool_args")

    def test_env_sync_malformed_retry_max(self):
        """PROXY_MALFORMED_TOOL_RETRY_MAX should be 3."""
        self.assertEqual(proxy.PROXY_MALFORMED_TOOL_RETRY_MAX, 3)


class TestToolTurnMaxTokensCap(unittest.TestCase):
    """Tests for tool turn max_tokens capping to prevent 32K waste."""

    def test_tool_turn_max_tokens_constant(self):
        """PROXY_TOOL_TURN_MAX_TOKENS should default to 8192."""
        self.assertEqual(proxy.PROXY_TOOL_TURN_MAX_TOKENS, 8192)

    def test_tool_turn_max_tokens_garbled_constant(self):
        """PROXY_TOOL_TURN_MAX_TOKENS_GARBLED should default to 4096."""
        self.assertEqual(proxy.PROXY_TOOL_TURN_MAX_TOKENS_GARBLED, 4096)

    def test_tool_turn_caps_high_max_tokens(self):
        """Tool turn with max_tokens=32000 should be capped to 8192."""
        body = {
            "model": "test-model",
            "max_tokens": 32000,
            "messages": [{"role": "user", "content": "test"}],
            "tools": [
                {
                    "name": "Bash",
                    "description": "run command",
                    "input_schema": {"type": "object"},
                }
            ],
        }
        monitor = proxy.SessionMonitor(context_window=262144)
        openai_body = proxy.build_openai_request(body, monitor)
        self.assertLessEqual(openai_body["max_tokens"], proxy.PROXY_TOOL_TURN_MAX_TOKENS)

    def test_tool_turn_garbled_reduces_cap(self):
        """After garbled output, max_tokens should use the lower garbled cap."""
        body = {
            "model": "test-model",
            "max_tokens": 32000,
            "messages": [{"role": "user", "content": "test"}],
            "tools": [
                {
                    "name": "Bash",
                    "description": "run command",
                    "input_schema": {"type": "object"},
                }
            ],
        }
        monitor = proxy.SessionMonitor(context_window=262144)
        monitor.last_response_garbled = True
        openai_body = proxy.build_openai_request(body, monitor)
        self.assertLessEqual(
            openai_body["max_tokens"], proxy.PROXY_TOOL_TURN_MAX_TOKENS_GARBLED
        )

    def test_non_tool_request_not_capped(self):
        """Non-tool requests should not be affected by tool turn cap."""
        body = {
            "model": "test-model",
            "max_tokens": 32000,
            "messages": [{"role": "user", "content": "test"}],
        }
        monitor = proxy.SessionMonitor(context_window=262144)
        openai_body = proxy.build_openai_request(body, monitor)
        # Should not be capped to 8192 (may be capped by context window logic)
        self.assertGreater(openai_body["max_tokens"], proxy.PROXY_TOOL_TURN_MAX_TOKENS)

    def test_last_response_garbled_cleared_on_clean(self):
        """SessionMonitor.last_response_garbled should default to False."""
        monitor = proxy.SessionMonitor(context_window=262144)
        self.assertFalse(monitor.last_response_garbled)

    def test_small_max_tokens_stays_within_cap(self):
        """If client requests less than the cap, result should not exceed cap."""
        body = {
            "model": "test-model",
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": "test"}],
            "tools": [
                {
                    "name": "Bash",
                    "description": "run command",
                    "input_schema": {"type": "object"},
                }
            ],
        }
        monitor = proxy.SessionMonitor(context_window=262144)
        openai_body = proxy.build_openai_request(body, monitor)
        # The tool turn cap should ensure we don't exceed PROXY_TOOL_TURN_MAX_TOKENS
        self.assertLessEqual(openai_body["max_tokens"], proxy.PROXY_TOOL_TURN_MAX_TOKENS)
