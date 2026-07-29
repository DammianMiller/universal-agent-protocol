#!/usr/bin/env python3
"""MANDATE-DELIVER guardrail: when delivery-enforcement blocks a direct source
edit, the proxy must force the next turn to call the `deliver` tool for ANY model
(pin tool_choice), so weak models can't ignore the routing and deadlock."""

import importlib.util
import os
import unittest
from pathlib import Path


def _load_proxy():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    assert spec is not None and spec.loader is not None
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()

DELIVER_TOOL = {"type": "function", "function": {"name": "deliver", "parameters": {}}}
READ_TOOL = {"type": "function", "function": {"name": "read", "parameters": {}}}
BLOCK_MSG = (
    "BLOCKED: do not edit 'src/foo.ts' directly. To create or change code, call "
    "the `deliver` tool (or run: uap deliver \"...\"). Do NOT retry this edit."
)


def _body(messages, tools=None, tool_choice="auto"):
    return {
        "tools": DELIVER_TOOL if tools is None else tools,
        "messages": messages,
        "tool_choice": tool_choice,
    }


class MandateDeliverTest(unittest.TestCase):
    def setUp(self):
        self.mon = proxy.SessionMonitor()

    def test_forces_deliver_on_block(self):
        b = _body([
            {"role": "assistant", "content": "editing", "tool_calls": [{"function": {"name": "edit"}}]},
            {"role": "tool", "content": BLOCK_MSG},
        ], tools=[DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        # "required" + a one-tool list, NOT the OpenAI object form: llama.cpp
        # parses tool_choice as a string and silently falls back to "auto" when
        # handed an object, which un-pinned every mandate.
        self.assertEqual(b["tool_choice"], "required")
        self.assertEqual([t["function"]["name"] for t in b["tools"]], ["deliver"])
        self.assertEqual(self.mon.mandate_deliver_fires, 1)
        self.assertTrue(any("MANDATORY" in (m.get("content") or "") for m in b["messages"]))

    def test_no_block_no_change(self):
        b = _body([{"role": "user", "content": "hi"}], tools=[DELIVER_TOOL], tool_choice="auto")
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(b["tool_choice"], "auto")
        self.assertEqual(self.mon.mandate_deliver_fires, 0)

    def test_reactor_standing_guidance_does_not_trigger(self):
        # The reactor injects this EVERY turn — it must NOT be treated as a block.
        b = _body([{"role": "user", "content": "Use the `deliver` tool to write code — direct Edit/Write is gated and will be blocked."}], tools=[DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(self.mon.mandate_deliver_fires, 0)

    def test_no_deliver_tool_no_change(self):
        b = _body([{"role": "tool", "content": BLOCK_MSG}], tools=[READ_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(self.mon.mandate_deliver_fires, 0)

    def test_already_called_deliver_no_reforce(self):
        b = _body([
            {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "deliver"}}]},
            {"role": "tool", "content": BLOCK_MSG},
        ], tools=[DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(self.mon.mandate_deliver_fires, 0)

    def test_mcp_namespaced_deliver_tool(self):
        mcp_deliver = {"type": "function", "function": {"name": "mcp__uap-router__deliver", "parameters": {}}}
        b = _body([{"role": "tool", "content": BLOCK_MSG}], tools=[mcp_deliver])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(b["tool_choice"], "required")
        self.assertEqual(
            [t["function"]["name"] for t in b["tools"]], ["mcp__uap-router__deliver"]
        )

    def test_pin_narrows_tools_to_the_single_mandated_tool(self):
        """The pin must REMOVE the other tools. 'required' only means "some
        tool", so leaving `read` advertised would let the model satisfy the
        mandate by reading a file instead of delivering."""
        b = _body([{"role": "tool", "content": BLOCK_MSG}], tools=[READ_TOOL, DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertEqual(b["tool_choice"], "required")
        self.assertEqual([t["function"]["name"] for t in b["tools"]], ["deliver"])

    def test_tool_choice_is_never_an_object(self):
        """Regression guard for the llama.cpp string-only parser. An object here
        is not a hard error upstream -- it degrades to "auto" with only a log
        line -- so nothing downstream would have caught the regression."""
        b = _body([{"role": "tool", "content": BLOCK_MSG}], tools=[DELIVER_TOOL])
        proxy._maybe_inject_mandate_deliver(b, self.mon)
        self.assertIsInstance(b["tool_choice"], str)
        self.assertIn(b["tool_choice"], {"auto", "none", "required"})

    def test_pin_is_a_noop_when_the_named_tool_is_absent(self):
        """Forcing "required" while the mandated tool is missing would demand a
        call the model cannot make. _pin_tool_choice_to must decline instead."""
        b = _body([{"role": "user", "content": "hi"}], tools=[READ_TOOL], tool_choice="auto")
        self.assertFalse(proxy._pin_tool_choice_to(b, "deliver"))
        self.assertEqual(b["tool_choice"], "auto")
        self.assertEqual([t["function"]["name"] for t in b["tools"]], ["read"])

    def test_disabled_by_env(self):
        old = os.environ.get("PROXY_MANDATE_DELIVER")
        os.environ["PROXY_MANDATE_DELIVER"] = "off"
        try:
            p2 = _load_proxy()
            mon = p2.SessionMonitor()
            b = _body([{"role": "tool", "content": BLOCK_MSG}], tools=[DELIVER_TOOL])
            p2._maybe_inject_mandate_deliver(b, mon)
            self.assertEqual(mon.mandate_deliver_fires, 0)
        finally:
            if old is None:
                os.environ.pop("PROXY_MANDATE_DELIVER", None)
            else:
                os.environ["PROXY_MANDATE_DELIVER"] = old


if __name__ == "__main__":
    unittest.main()
