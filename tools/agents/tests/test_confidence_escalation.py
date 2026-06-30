"""Tests for the confidence-escalation looper (vLLM Confidence recipe)."""
import importlib.util
import unittest
from pathlib import Path

mod_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "confidence_escalation.py"
spec = importlib.util.spec_from_file_location("confidence_escalation", mod_path)
ce = importlib.util.module_from_spec(spec)
import sys as _sys; _sys.modules["confidence_escalation"]=ce; spec.loader.exec_module(ce)


def S(enabled=True, threshold=0.5, model="opus", endpoint="http://x/", api_key="k"):
    return ce.Settings(enabled=enabled, threshold=threshold, model=model, endpoint=endpoint, api_key=api_key)


class ConfidenceTest(unittest.TestCase):
    def test_text_confidence_levels(self):
        self.assertEqual(ce.text_confidence(""), 0.0)
        self.assertEqual(ce.text_confidence("I don't know"), 0.2)
        self.assertEqual(ce.text_confidence("ok"), 0.3)
        self.assertGreater(ce.text_confidence("Here is a complete, detailed answer to your question."), 0.5)

    def test_extract_text(self):
        resp = {"content": [{"type": "text", "text": "a"}, {"type": "tool_use"}, {"type": "text", "text": "b"}]}
        self.assertEqual(ce.extract_text(resp), "ab")


class ShouldEscalateTest(unittest.TestCase):
    def test_low_confidence_escalates(self):
        self.assertTrue(ce.should_escalate("I cannot help", S(), has_tools=False))

    def test_high_confidence_does_not(self):
        self.assertFalse(ce.should_escalate("A thorough and confident full answer here.", S(), has_tools=False))

    def test_disabled_never(self):
        self.assertFalse(ce.should_escalate("", S(enabled=False), has_tools=False))

    def test_no_backend_never(self):
        self.assertFalse(ce.should_escalate("", S(endpoint=""), has_tools=False))

    def test_tool_turn_never(self):
        self.assertFalse(ce.should_escalate("", S(), has_tools=True))


class PayloadTest(unittest.TestCase):
    def test_payload_uses_escalation_model_and_messages(self):
        body = {"model": "qwen", "max_tokens": 100, "system": "sys", "messages": [{"role": "user", "content": "hi"}]}
        p = ce.build_escalation_payload(body, S(model="opus"))
        self.assertEqual(p["model"], "opus")
        self.assertEqual(p["messages"], body["messages"])
        self.assertEqual(p["system"], "sys")
        self.assertNotIn("tools", p)


if __name__ == "__main__":
    unittest.main()
