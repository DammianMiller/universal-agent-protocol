#!/usr/bin/env python3
"""Live-upstream override on stale residency parks (2026-11-27 fleet incident).

The live failure (Droid qwen3.8-FN basalt-fn client, twice in one day): an
out-of-band arm switch (the Droid apiKeyHelper's panel.py --switch) updated
systemd and the proxy (the helper POSTs /internal/placement/refresh after
every swap) but NOT the placement controller's ledger. The controller kept
answering not_resident / auto_failed — fresh admits and unexpired pending
dedupe alike — while the requested model was provably loaded and healthy on
:8080 (observed 15:44-15:54: minutes of 409s against a serving arm, five
minutes of them AFTER the arm had recovered). The proxy already applies a
trust-but-verify guard to FORWARD decisions (spec §4.3: it posts to ONE
discovered upstream, so a vouch for a resident on another endpoint is
rejected); these tests pin the mirror-image guard on PARK decisions: when
the controller parks a residency-flavored failure but the proxy's own
live-upstream measurement says the requested id IS served, the park is
overridden with a forward. Capability, routing, and registry parks are
NOT overridden, and an unreachable upstream never overrides.
"""

import asyncio
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()

SERVED_ID = "Qwen3.8-Flash-Next NVIDIA-NVFP4"
OTHER_ID = "Inkling 2 Mini"
RAW_CUSTOM_ID = "custom:Qwen3.8-FN Basalt NVFP4 (UAP-local)-0"


class PlacementLiveUpstreamOverrideTest(unittest.TestCase):
    def setUp(self):
        self._old_mode = proxy.PROXY_PLACEMENT_MODE
        self._old_ids_failed_at = proxy._upstream_ids_failed_at
        proxy.PROXY_PLACEMENT_MODE = "ask"
        proxy._placement_pending.clear()

    def tearDown(self):
        proxy.PROXY_PLACEMENT_MODE = self._old_mode
        proxy._upstream_ids_failed_at = self._old_ids_failed_at
        proxy._placement_pending.clear()

    def _admit(
        self,
        *,
        reason,
        placement_id="plc-abc123",
        served_ids=(SERVED_ID,),
        carries_image=False,
        openai_body=None,
        wire_model=SERVED_ID,
    ):
        """Run _placement_admit with the controller answering `reason` and the
        live upstream serving `served_ids` (or None for an unreachable
        upstream). `wire_model` is the id the CLIENT asked for — pass the
        raw custom-local id to exercise the resolution + wire-ride path."""
        controller_answer = {
            "decision": "park",
            "reason": reason,
            "placement_id": placement_id,
        }

        async def fake_controller_admit(*args, **kwargs):
            return controller_answer

        async def fake_upstream_ids():
            return list(served_ids) if served_ids is not None else None

        async def fake_ask_model(given):
            return SERVED_ID if given == RAW_CUSTOM_ID else given

        body = openai_body if openai_body is not None else {"model": wire_model}
        with mock.patch.object(
            proxy, "_placement_controller_admit", side_effect=fake_controller_admit
        ), mock.patch.object(
            proxy, "_upstream_model_ids_cached", side_effect=fake_upstream_ids
        ), mock.patch.object(
            proxy, "_placement_ask_model", side_effect=fake_ask_model
        ):
            return asyncio.run(
                proxy._placement_admit(
                    wire_model,
                    "remote:127.0.0.1",
                    "sess_test",
                    cells=1000,
                    openai_body=body,
                    carries_image=carries_image,
                )
            )

    def test_not_resident_park_overridden_when_upstream_serves_the_id(self):
        """The headline case: the controller's ledger still names the
        displaced arm (not_resident) while :8080 serves the requested id —
        the gate must FORWARD, ride the wire as the served id, and mint no
        proxy-side pending entry. The client asks with the BYOK custom id;
        the override must still resolve it onto the served id."""
        body = {"model": RAW_CUSTOM_ID}
        result = self._admit(
            reason="not_resident", openai_body=body, wire_model=RAW_CUSTOM_ID
        )
        self.assertIsNone(result, "a live-served id must forward, not park")
        self.assertEqual(body["model"], SERVED_ID, "wire must ride the served id")
        self.assertEqual(
            proxy._placement_pending,
            {},
            "an overridden park must not mint a burst-dedupe entry",
        )

    def test_auto_failed_park_overridden_when_upstream_serves_the_id(self):
        """The 15:51 incident shape: the controller's pending row froze at
        auto_failed (its background load failed earlier) while a later
        out-of-band switch had already loaded the model. Retries must
        forward instead of 409ing for the rest of the pending TTL."""
        result = self._admit(reason="auto_failed", placement_id="plc-49ec46")
        self.assertIsNone(result, "auto_failed against a serving arm must forward")

    def test_auto_loading_park_overridden_when_upstream_serves_the_id(self):
        """A completed load outlives the controller's auto_loading answer:
        once the upstream serves the id the load is DONE, and the retry
        protocol's promise ('forwards when the load completes') must hold
        even when the controller's pending row has not caught up."""
        result = self._admit(reason="auto_loading", placement_id="plc-49ec46")
        self.assertIsNone(result, "auto_loading against a serving arm must forward")

    def test_not_resident_park_honored_when_upstream_does_not_serve_the_id(self):
        """The honest park stays a park: the controller says not_resident and
        the live upstream agrees (different arm resident). The 409 carries
        the controller's placement id and the burst map records it."""
        result = self._admit(reason="not_resident", served_ids=(OTHER_ID,))
        self.assertIsNotNone(result, "an unserved id must still park")
        self.assertEqual(result.status_code, 409)
        error = json.loads(result.body)["error"]
        self.assertEqual(error["type"], "model_placement_pending")
        self.assertEqual(error["placement_id"], "plc-abc123")
        self.assertEqual(error["reason"], "not_resident")
        self.assertIn(("remote:127.0.0.1", SERVED_ID), proxy._placement_pending)

    def test_routing_and_vision_parks_never_overridden_even_when_served(self):
        """unroutable_target is a ROUTING decision (the controller refused to
        vouch for this upstream) and vision parks are CAPABILITY decisions —
        the upstream serving the id speaks to neither, so both park even
        when the id is live-served."""
        routed = self._admit(reason="unroutable_target")
        self.assertIsNotNone(routed, "unroutable_target must stay the operator's call")
        self.assertEqual(routed.status_code, 409)

        imaged = self._admit(reason="not_resident", carries_image=True)
        self.assertIsNotNone(
            imaged, "an image-bearing request must never bypass its placement class"
        )
        self.assertEqual(imaged.status_code, 409)

    def test_unreachable_upstream_never_overrides(self):
        """A None ids cache (backend blip / probe backoff) carries no
        measurement, so the controller's park stands — the fail-open
        direction stays with the no-controller branch, not this override."""
        result = self._admit(reason="not_resident", served_ids=None)
        self.assertIsNotNone(result, "no measurement, no override")
        self.assertEqual(result.status_code, 409)


if __name__ == "__main__":
    unittest.main()
