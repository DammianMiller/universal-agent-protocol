#!/usr/bin/env python3
"""Unit tests for the attractor-aware contamination-breaker path.

Validates that a repeated fault-excerpt hash across consecutive contamination
resets triggers the hard-reset + corrective-injection path, and that the
standard kept-last path remains unchanged when no repeat is observed.
"""

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


def _make_monitor(**overrides):
    m = proxy.SessionMonitor()
    for k, v in overrides.items():
        setattr(m, k, v)
    return m


def _make_body(n_msgs: int):
    """Build an anthropic_body with a system + N user/assistant turns."""
    messages = [{"role": "user", "content": "Run a recon on /repos/pay2u."}]
    for i in range(n_msgs - 1):
        role = "assistant" if i % 2 == 0 else "user"
        messages.append({"role": role, "content": f"turn-{i}"})
    return {
        "model": "qwen36-35b-a3b-iq4xs",
        "messages": messages,
        "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "any"},
    }


class TestHashFaultExcerpt(unittest.TestCase):
    def test_empty_returns_empty(self):
        self.assertEqual(proxy._hash_fault_excerpt(""), "")
        self.assertEqual(proxy._hash_fault_excerpt("   "), "")

    def test_whitespace_normalized(self):
        a = proxy._hash_fault_excerpt("The   security  architecture is layered.")
        b = proxy._hash_fault_excerpt("The security architecture is layered.")
        c = proxy._hash_fault_excerpt("The\nsecurity\narchitecture\nis\nlayered.")
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_case_normalized(self):
        a = proxy._hash_fault_excerpt("FAIL CLOSED security")
        b = proxy._hash_fault_excerpt("fail closed security")
        self.assertEqual(a, b)

    def test_distinct_excerpts_distinct_hashes(self):
        a = proxy._hash_fault_excerpt("Pay2U API analysis")
        b = proxy._hash_fault_excerpt("Different attractor text")
        self.assertNotEqual(a, b)
        self.assertEqual(len(a), 16)
        self.assertEqual(len(b), 16)


class TestAttractorDetectionPath(unittest.TestCase):
    """First reset → standard. Second reset with same excerpt → attractor."""

    def _trip_breaker(self, monitor):
        # Make the breaker think it should reset.
        monitor.required_tool_miss_streak = (
            proxy.PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD
        )

    def test_first_reset_is_standard(self):
        monitor = _make_monitor()
        monitor.last_fault_excerpt_hash = "deadbeefcafebabe"
        self._trip_breaker(monitor)

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        self.assertEqual(monitor.contamination_resets, 1)
        self.assertFalse(monitor.attractor_correction_active)
        # Standard keeps head + reset_marker + last keep_last messages
        kept_last = max(2, proxy.PROXY_SESSION_CONTAMINATION_KEEP_LAST)
        self.assertEqual(len(updated["messages"]), 1 + 1 + kept_last)
        # Reset marker carries the standard wording, not the attractor wording.
        self.assertIn("SESSION RESET", updated["messages"][1]["content"])

    def test_second_reset_same_hash_triggers_attractor(self):
        monitor = _make_monitor()
        monitor.last_fault_excerpt_hash = "deadbeefcafebabe"
        # Pretend we've already done one reset with the same fault excerpt.
        monitor._prev_reset_fault_hash = "deadbeefcafebabe"
        monitor.contamination_resets = 1
        self._trip_breaker(monitor)

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        self.assertTrue(monitor.attractor_correction_active)
        # Hard reset keeps only system + first user (+ corrective marker)
        # → 2 messages total for this body (first user + marker).
        self.assertLessEqual(len(updated["messages"]), 3)
        self.assertIn("ATTRACTOR INTERVENTION", updated["messages"][-1]["content"])

    def test_second_reset_different_hash_stays_standard(self):
        monitor = _make_monitor()
        monitor.last_fault_excerpt_hash = "newhashvalue1234"
        monitor._prev_reset_fault_hash = "deadbeefcafebabe"
        monitor.contamination_resets = 1
        self._trip_breaker(monitor)

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        self.assertFalse(monitor.attractor_correction_active)
        self.assertIn("SESSION RESET", updated["messages"][1]["content"])


class TestAttractorFinalizeThreshold(unittest.TestCase):
    """Once attractor correction is active, finalize fires at the lower
    threshold instead of waiting for 3 resets."""

    def test_attractor_lowers_finalize_threshold(self):
        monitor = _make_monitor()
        monitor.attractor_correction_active = True
        # Just at the lowered threshold.
        monitor.contamination_resets = proxy.PROXY_ATTRACTOR_FINALIZE_THRESHOLD
        monitor.required_tool_miss_streak = (
            proxy.PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD
        )

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        # Finalize path strips tools and appends the "respond with plain text" prompt.
        self.assertNotIn("tools", updated)
        self.assertNotIn("tool_choice", updated)
        self.assertIn("plain text only", updated["messages"][-1]["content"])

    def test_standard_path_keeps_3_reset_budget(self):
        monitor = _make_monitor()
        monitor.attractor_correction_active = False
        # 2 resets done — under the standard 3-reset budget.
        monitor.contamination_resets = 2
        monitor.required_tool_miss_streak = (
            proxy.PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD
        )

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        # Standard reset, not finalize.
        self.assertIn("tools", updated)


class TestAttractorPhase2Defaults(unittest.TestCase):
    """Phase 2 (PR #192) raises the default temp override and strengthens the
    intervention wording. Verify the defaults the operator gets out of the box."""

    def test_temp_override_default_is_1_20(self):
        # Phase 1 default was 0.95; Phase 2 raises to 1.20 after one
        # production attractor (fp:d19b7a44...) failed to escape at 0.95.
        self.assertGreaterEqual(proxy.PROXY_ATTRACTOR_TEMP_OVERRIDE, 1.20 - 0.001)

    def test_intervention_message_has_structured_directives(self):
        """The Phase 2 wording uses MUST / DO NOT bullets and explicitly
        names the failure mode. Trigger the attractor path and inspect the
        injected marker."""
        monitor = _make_monitor()
        monitor.last_fault_excerpt_hash = "deadbeefcafebabe"
        monitor._prev_reset_fault_hash = "deadbeefcafebabe"
        monitor.contamination_resets = 1
        monitor.required_tool_miss_streak = (
            proxy.PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD
        )

        body = _make_body(n_msgs=20)
        updated = proxy._maybe_apply_session_contamination_breaker(
            body, monitor, "test-session"
        )

        content = updated["messages"][-1]["content"]
        # Phase 2 wording signals
        self.assertIn("CRITICAL", content)
        self.assertIn("MUST", content)
        self.assertIn("DO NOT", content)
        # Specifically forbids the attractor's preferred behaviors
        self.assertIn("prose", content.lower())
        # Still has the marker substring callers may grep on
        self.assertIn("ATTRACTOR INTERVENTION", content)


if __name__ == "__main__":
    unittest.main()
