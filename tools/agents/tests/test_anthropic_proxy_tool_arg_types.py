#!/usr/bin/env python3
"""Tool-argument type coercion + signature-aware ERROR-LOOP remedies.

Regression cover for the 2026-09-13 droid loop: the preflight guard validated
only that `arguments` parsed as JSON and was an object, so a double-encoded
argument reached the client broken and the model repeated the identical bad
call until the ERROR-LOOP hard stop killed the run.

Payloads here are verbatim from the live proxy journal.
"""

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

TODO_SCHEMA = {
    "name": "TodoWrite",
    "input_schema": {
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                        },
                    },
                },
            }
        },
        "required": ["todos"],
    },
}


def _resp(tool_name, arguments):
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": tool_name, "arguments": arguments},
                        }
                    ],
                }
            }
        ]
    }


def _args_of(resp):
    fn = resp["choices"][0]["message"]["tool_calls"][0]["function"]
    return json.loads(fn["arguments"])


class TestToolArgTypeRepair(unittest.TestCase):
    def test_stringified_array_is_parsed_into_a_real_array(self):
        """The live defect: 120/120 TodoWrite payloads sent `todos` as a string."""
        inner = [{"content": "Set up worktree", "status": "in_progress"}]
        resp = _resp("TodoWrite", json.dumps({"todos": json.dumps(inner)}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n, 1)
        self.assertEqual(_args_of(out)["todos"], inner)

    def test_already_valid_array_is_left_untouched(self):
        inner = [{"content": "x", "status": "pending"}]
        resp = _resp("TodoWrite", json.dumps({"todos": inner}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n, 0)
        self.assertEqual(_args_of(out)["todos"], inner)

    def test_a_string_typed_field_is_never_coerced(self):
        """A tool that legitimately takes JSON-in-a-string must not be rewritten."""
        schema = {
            "name": "Run",
            "input_schema": {
                "type": "object",
                "properties": {"payload": {"type": "string"}},
            },
        }
        resp = _resp("Run", json.dumps({"payload": '[{"a": 1}]'}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [schema]})
        self.assertEqual(n, 0)
        self.assertEqual(_args_of(out)["payload"], '[{"a": 1}]')

    def test_unparseable_string_is_left_for_the_retry_path(self):
        resp = _resp("TodoWrite", json.dumps({"todos": "[{not json"}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n, 0)

    def test_object_string_coerced_only_when_object_is_declared(self):
        schema = {
            "name": "Cfg",
            "input_schema": {
                "type": "object",
                "properties": {"opts": {"type": "object"}},
            },
        }
        resp = _resp("Cfg", json.dumps({"opts": '{"a": 1}'}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [schema]})
        self.assertEqual(n, 1)
        self.assertEqual(_args_of(out)["opts"], {"a": 1})

    def test_array_declared_but_object_string_supplied_is_not_coerced(self):
        """Type must match what the schema declares — never force a shape."""
        resp = _resp("TodoWrite", json.dumps({"todos": '{"a": 1}'}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n, 0)

    def test_nullable_union_type_still_coerces(self):
        schema = {
            "name": "T",
            "input_schema": {
                "type": "object",
                "properties": {"items": {"type": ["array", "null"]}},
            },
        }
        resp = _resp("T", json.dumps({"items": "[1,2]"}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [schema]})
        self.assertEqual(n, 1)
        self.assertEqual(_args_of(out)["items"], [1, 2])

    def test_quoted_scalars_coerced_to_declared_scalar_types(self):
        schema = {
            "name": "N",
            "input_schema": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer"},
                    "ratio": {"type": "number"},
                    "deep": {"type": "boolean"},
                },
            },
        }
        resp = _resp("N", json.dumps({"limit": "10", "ratio": "1.5", "deep": "true"}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [schema]})
        self.assertEqual(n, 1)
        self.assertEqual(_args_of(out), {"limit": 10, "ratio": 1.5, "deep": True})

    def test_untyped_property_is_left_alone(self):
        schema = {
            "name": "U",
            "input_schema": {"type": "object", "properties": {"blob": {}}},
        }
        resp = _resp("U", json.dumps({"blob": "[1,2]"}))
        out, n = proxy._repair_tool_arg_types(resp, {"tools": [schema]})
        self.assertEqual(n, 0)

    def test_unknown_tool_and_no_tool_calls_are_no_ops(self):
        resp = _resp("Mystery", json.dumps({"todos": "[]"}))
        _, n = proxy._repair_tool_arg_types(resp, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n, 0)
        _, n2 = proxy._repair_tool_arg_types({"choices": []}, {"tools": [TODO_SCHEMA]})
        self.assertEqual(n2, 0)


class TestErrorLoopRemedy(unittest.TestCase):
    def test_directory_misuse_does_not_advise_rereading_a_file(self):
        r = proxy._error_loop_remedy('error: error: path "<path> is a directory.')
        self.assertIn("TOOL MISUSE", r)
        self.assertIn("LS", r)
        self.assertNotIn("re-read the ENTIRE failing file", r)

    def test_missing_path_advises_listing_not_retyping(self):
        r = proxy._error_loop_remedy("error: path does not exist: <path>")
        self.assertIn("TOOL MISUSE", r)
        self.assertIn("Glob", r)

    def test_enum_violation_advises_schema_not_code(self):
        r = proxy._error_loop_remedy(
            "error: todo item #: status must be pending, in_progress, or completed"
        )
        self.assertIn("SCHEMA violation", r)
        self.assertNotIn("re-read the ENTIRE failing file", r)

    def test_genuine_code_error_keeps_the_generic_remedy(self):
        r = proxy._error_loop_remedy("error: command failed (exit code: #)")
        self.assertIn("re-read the ENTIRE failing file", r)

    def test_empty_signature_is_safe(self):
        self.assertIn("re-read the ENTIRE failing file", proxy._error_loop_remedy(""))


class TestRepairIsWiredIntoTheGuardrailPipeline(unittest.TestCase):
    """Unit-testing the repair function alone would not catch a wiring mistake.

    This drives the real `_apply_malformed_tool_guardrail` chain — the code path a
    live response actually takes — so the test fails if the repair is ever dropped
    from it or ordered after the preflight that consumes its output.
    """

    def test_double_encoded_arg_is_fixed_through_the_real_chain(self):
        import asyncio

        inner = [{"content": "Set up worktree", "status": "in_progress"}]
        resp = _resp("TodoWrite", json.dumps({"todos": json.dumps(inner)}))
        monitor = proxy.SessionMonitor()
        out = asyncio.run(
            proxy._apply_malformed_tool_guardrail(
                None,
                resp,
                {"tool_choice": "auto"},
                {"tools": [TODO_SCHEMA]},
                monitor,
                "sess-test",
            )
        )
        self.assertEqual(_args_of(out)["todos"], inner)



if __name__ == "__main__":
    unittest.main()
