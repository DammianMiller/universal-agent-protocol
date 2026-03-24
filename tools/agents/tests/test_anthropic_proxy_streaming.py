#!/usr/bin/env python3

import importlib.util
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

    def test_prune_target_fraction_uses_config_or_default(self):
        old_target = getattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION")
        try:
            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", 0.55)
            self.assertEqual(proxy._resolve_prune_target_fraction(), 0.55)

            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", 1.2)
            self.assertEqual(proxy._resolve_prune_target_fraction(), 0.65)
        finally:
            setattr(proxy, "PROXY_CONTEXT_PRUNE_TARGET_FRACTION", old_target)


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

    def test_clean_guardrail_response_does_not_promise_future_tool_call(self):
        guardrail = proxy._build_clean_guardrail_openai_response(
            {"model": "test-model"}
        )
        text = guardrail["choices"][0]["message"]["content"]
        self.assertIn("Please retry the same request", text)
        self.assertNotIn("I will issue exactly one valid tool call next", text)


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


if __name__ == "__main__":
    unittest.main()
