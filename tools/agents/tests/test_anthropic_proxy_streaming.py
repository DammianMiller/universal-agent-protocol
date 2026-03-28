#!/usr/bin/env python3

import asyncio
import importlib.util
import json
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

    def test_build_request_keeps_floor_for_non_tool_turns(self):
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
            self.assertEqual(openai.get("max_tokens"), 4096)
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

    def test_unexpected_end_turn_guardrail_skips_review_auto_turn(self):
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

        fake_client = _FakeClient([_FakeResponse({"choices": []})])
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

        self.assertEqual(result, openai_resp)
        self.assertEqual(len(fake_client.requests), 0)

    def test_unexpected_end_turn_guardrail_skips_act_auto_release_turn(self):
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

        fake_client = _FakeClient([_FakeResponse({"choices": []})])
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

        self.assertEqual(result, openai_resp)
        self.assertEqual(len(fake_client.requests), 0)


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
            self.assertEqual(openai_3.get("tool_choice"), "auto")
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
            self.assertEqual(openai.get("tool_choice"), "auto")
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
            self.assertEqual(openai.get("tool_choice"), "auto")
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


if __name__ == "__main__":
    unittest.main()
