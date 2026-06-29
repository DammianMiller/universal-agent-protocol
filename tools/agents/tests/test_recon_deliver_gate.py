"""Tests for #1: RECON directive is write-block aware (routes to deliver)."""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

GATED_MSG = {"role": "user", "content": [
    {"type": "tool_result", "content": "[UAP policy blocked: delivery-enforcement] BLOCKED: call the `deliver` tool"}
]}
PLAIN_MSG = {"role": "user", "content": "read the next file"}


class WritesGatedTest(unittest.TestCase):
    def test_detects_delivery_enforcement_block(self):
        self.assertTrue(ap._writes_are_gated({"messages": [GATED_MSG]}))

    def test_plain_messages_not_gated(self):
        self.assertFalse(ap._writes_are_gated({"messages": [PLAIN_MSG]}))


class ReconDirectiveTest(unittest.TestCase):
    def _run(self, gated):
        m = ap.SessionMonitor(context_window=132096)
        m.consecutive_no_write_turns = max(1, ap.PROXY_RECON_CONVERGENCE_THRESHOLD)
        body = {"messages": [GATED_MSG if gated else PLAIN_MSG], "tools": [{"name": "Write"}]}
        ap._maybe_inject_recon_convergence(body, m)
        return body["messages"][-1]["content"]

    def test_gated_directive_routes_to_deliver(self):
        d = self._run(gated=True)
        self.assertIn("deliver", d.lower())
        self.assertIn("BLOCKED", d)

    def test_ungated_directive_says_write(self):
        d = self._run(gated=False)
        self.assertIn("write", d.lower())
        self.assertNotIn("being BLOCKED by policy", d)


if __name__ == "__main__":
    unittest.main()
