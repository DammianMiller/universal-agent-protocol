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
        self.assertEqual(b["tool_choice"], {"type": "function", "function": {"name": "deliver"}})
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
        self.assertEqual(b["tool_choice"], {"type": "function", "function": {"name": "mcp__uap-router__deliver"}})

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
