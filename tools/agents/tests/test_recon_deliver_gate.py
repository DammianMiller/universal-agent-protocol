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



class ProactiveGateDetectionTest(unittest.TestCase):
    """A: gate detected from the harness banner BEFORE any write is attempted.

    A read-forever session never triggers the reactive (blocked tool_result)
    path, so the deliver redirect must fire from the gate banner in context."""

    def test_system_banner_route_through_deliver(self):
        body = {"messages": [
            {"role": "system", "content": "Writing code — route through deliver. Use the deliver tool."},
            {"role": "user", "content": "read the next file"},
        ]}
        self.assertTrue(ap._writes_are_gated(body))

    def test_gated_and_will_be_blocked_banner(self):
        body = {"messages": [
            {"role": "user", "content": "direct Edit/Write on source files is gated and will be blocked"},
        ]}
        self.assertTrue(ap._writes_are_gated(body))

    def test_no_banner_and_no_block_is_ungated(self):
        body = {"messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "read the next file"},
        ]}
        self.assertFalse(ap._writes_are_gated(body))


class DeliverIsWriteToolTest(unittest.TestCase):
    """A: deliver is the only write path under a gate; it must count as a write."""

    def test_deliver_in_write_tool_class(self):
        self.assertIn("deliver", ap._WRITE_TOOL_CLASS)


class FirmTierReleasesToolChoiceTest(unittest.TestCase):
    """B: the firm tier must release the 'required' coercion so the model can
    actually write / call deliver / stop instead of being forced into a read."""

    def test_firm_tier_releases_required(self):
        m = ap.SessionMonitor(context_window=132096)
        m.consecutive_no_write_turns = ap.PROXY_RECON_CONVERGENCE_THRESHOLD  # firm
        body = {"messages": [{"role": "user", "content": "reading"}],
                "tools": [{"name": "Write"}], "tool_choice": "required"}
        ap._maybe_inject_recon_convergence(body, m)
        self.assertEqual(body.get("tool_choice"), "auto")


class HardMultiplierTest(unittest.TestCase):
    """C: hard-tier onset is governed by the configurable multiplier (default
    1.5x, earlier than the old hard-coded 2x)."""

    def test_multiplier_invariant(self):
        self.assertGreaterEqual(ap.PROXY_RECON_HARD_MULTIPLIER, 1.0)

    def test_hard_tier_directive_at_multiplier(self):
        m = ap.SessionMonitor(context_window=132096)
        streak = int(ap.PROXY_RECON_HARD_MULTIPLIER * ap.PROXY_RECON_CONVERGENCE_THRESHOLD) + 1
        m.consecutive_no_write_turns = streak
        body = {"messages": [{"role": "user", "content": "reading"}], "tools": [{"name": "Write"}]}
        ap._maybe_inject_recon_convergence(body, m)
        self.assertIn("STOP", body["messages"][-1]["content"])


if __name__ == "__main__":
    unittest.main()
