#!/usr/bin/env python3
"""Vision-encoder-OOM handling in the anthropic proxy (uplift: dynamic vision
switching).

The live failure: the inkling2 arm advertises vision, so image blocks forward,
but its elastic KV pool left 505 MiB free and the image encoder needs 792 MiB
— every image request 400s at encode time with "the image could not be read:
inkling2: no device memory for the image encoder (792 MiB)". These tests pin
the three machinery pieces: the two-part classifier, the degrade window it
arms, and the park path (controller-mediated switch vs self-describing 409).
"""

import asyncio
import importlib.util
import json
import time
import unittest
import unittest.mock
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


LIVE_SIGNATURE = (
    "the image could not be read: inkling2: no device memory for the "
    "image encoder (792 MiB)"
)


class TestVisionEncoderOomClassifier(unittest.TestCase):
    """Two-part match on purpose: image-CLASS failure AND memory-CLASS cause.

    Either alone means something else — a corrupt image is an image-class 400
    a model switch cannot fix, and a KV-pool OOM is a memory-class 400 that
    hits text requests too and belongs to the upstream-retry machinery.
    """

    def test_live_signature_matches(self):
        self.assertTrue(proxy._is_vision_encoder_oom(400, LIVE_SIGNATURE))

    def test_image_class_without_memory_cause_is_not_the_switch_condition(self):
        self.assertFalse(
            proxy._is_vision_encoder_oom(
                400, "the image could not be read: corrupt image data"
            )
        )

    def test_memory_class_without_image_failure_is_not_the_switch_condition(self):
        self.assertFalse(
            proxy._is_vision_encoder_oom(
                400, "no device memory available for the KV cache pool"
            )
        )

    def test_non_400_status_never_matches(self):
        self.assertFalse(proxy._is_vision_encoder_oom(500, LIVE_SIGNATURE))
        self.assertFalse(proxy._is_vision_encoder_oom(429, LIVE_SIGNATURE))

    def test_empty_or_none_message_fails_closed(self):
        self.assertFalse(proxy._is_vision_encoder_oom(400, ""))
        self.assertFalse(proxy._is_vision_encoder_oom(400, None))


class TestRequestCarriesImage(unittest.TestCase):
    def test_direct_image_block(self):
        body = {
            "messages": [
                {"role": "user", "content": [{"type": "image", "source": {"data": "x"}}]}
            ]
        }
        self.assertTrue(proxy._request_carries_image(body))

    def test_text_only_request(self):
        body = {"messages": [{"role": "user", "content": "just text"}]}
        self.assertFalse(proxy._request_carries_image(body))

    def test_image_nested_in_tool_result(self):
        body = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "content": [{"type": "image", "source": {"data": "x"}}],
                        }
                    ],
                }
            ]
        }
        self.assertTrue(proxy._request_carries_image(body))

    def test_absent_messages(self):
        self.assertFalse(proxy._request_carries_image({}))


class _VisionWindowTestCase(unittest.TestCase):
    """The degrade window is module-global state — isolate and restore it."""

    def setUp(self):
        self._saved_until = proxy._upstream_vision_broken_until
        proxy._upstream_vision_broken_until = 0.0

    def tearDown(self):
        proxy._upstream_vision_broken_until = self._saved_until


class TestVisionDegradeWindow(_VisionWindowTestCase):
    def test_window_disables_advertised_vision(self):
        # The arm ADVERTISES vision (probe said yes) — the window dominates
        # that advertisement: demonstrated-broken beats advertised.
        proxy._upstream_vision_broken_until = time.time() + 60
        with unittest.mock.patch.object(proxy, "PROXY_VISION", "auto"), \
                unittest.mock.patch.object(proxy, "upstream_vision", True):
            self.assertFalse(proxy.vision_enabled())

    def test_window_expiry_re_arms_the_probe_answer(self):
        proxy._upstream_vision_broken_until = time.time() - 1
        with unittest.mock.patch.object(proxy, "PROXY_VISION", "auto"), \
                unittest.mock.patch.object(proxy, "upstream_vision", True):
            self.assertTrue(proxy.vision_enabled())
        # After expiry the arm gets one image request again: if headroom was
        # freed the images resume; otherwise the 400 re-arms the window.
        with unittest.mock.patch.object(proxy, "PROXY_VISION", "auto"), \
                unittest.mock.patch.object(proxy, "upstream_vision", False):
            self.assertFalse(proxy.vision_enabled())

    def test_explicit_on_off_override_the_window(self):
        proxy._upstream_vision_broken_until = time.time() + 60
        with unittest.mock.patch.object(proxy, "PROXY_VISION", "on"):
            self.assertTrue(proxy.vision_enabled())
        with unittest.mock.patch.object(proxy, "PROXY_VISION", "off"):
            self.assertFalse(proxy.vision_enabled())

    def test_park_due_requires_window_gate_and_controller(self):
        proxy._upstream_vision_broken_until = time.time() + 60
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"):
            self.assertTrue(proxy._vision_park_due())
        # No controller: strip-and-notice beats parking — the parked retry has
        # nothing to switch to, so the image degrades to text instead.
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""):
            self.assertFalse(proxy._vision_park_due())
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "off"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"):
            self.assertFalse(proxy._vision_park_due())
        proxy._upstream_vision_broken_until = time.time() - 1
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"):
            self.assertFalse(proxy._vision_park_due())


class TestVisionOomParkResponse(_VisionWindowTestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    def test_park_arms_the_degrade_window(self):
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""), \
                unittest.mock.patch.object(proxy, "PROXY_VISION_OOM_DEGRADE_SECS", 600.0):
            response = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None)
            )
        self.assertEqual(response.status_code, 409)
        self.assertGreater(proxy._upstream_vision_broken_until, time.time())

    def test_self_describing_409_without_controller(self):
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""):
            response = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None, cells=32768)
            )
        self.assertEqual(response.status_code, 409)
        body = json.loads(response.body)
        err = body["error"]
        self.assertEqual(err["type"], "model_placement_pending")
        self.assertEqual(err["reason"], "vision_encoder_oom")
        self.assertEqual(err["requested_model"], "inkling2-mini")
        self.assertIn("retry_after_ms", err)
        # The raw 400 told the client nothing actionable; the message must
        # say what broke and that text still forwards.
        self.assertIn("cannot encode images", err["message"])
        self.assertIn("text", err["message"])
        self.assertEqual(response.headers.get("retry-after"), "2")

    def test_controller_admit_carries_the_reason_and_parks(self):
        fake = _FakeClient(
            [
                _FakeResponse(
                    {
                        "decision": "park",
                        "placement_id": "plc-v001",
                        "reason": "vision_encoder_oom",
                    },
                    200,
                )
            ]
        )
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(
                    proxy, "PROXY_PLACEMENT_CONTROLLER", "http://127.0.0.1:3847"
                ), \
                unittest.mock.patch.object(proxy, "http_client", fake):
            response = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", "s1", cells=32768)
            )
        # The admit ask carries the park class — the controller's vision
        # branch keys on it (its resident-forward would feed the failure).
        self.assertEqual(len(fake.requests), 1)
        payload = fake.requests[0]["kwargs"]["json"]
        self.assertEqual(payload["model_id"], "inkling2-mini")
        self.assertEqual(payload["client"], "byok-droid")
        self.assertEqual(payload["cells"], 32768)
        self.assertEqual(payload["reason"], "vision_encoder_oom")
        # The park body is the controller's (placement id + its reason).
        self.assertEqual(response.status_code, 409)
        body = json.loads(response.body)
        err = body["error"]
        self.assertEqual(err["placement_id"], "plc-v001")
        self.assertEqual(err["reason"], "vision_encoder_oom")
        self.assertIn("uap models pending", err["resolve_with"])

    def test_controller_silent_falls_back_to_self_describing_409(self):
        # No answer in time / non-200: read-only admission degrades to the
        # self-describing 409, never 500s the request.
        async def _no_controller(*_args, **_kwargs):
            return None

        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(
                    proxy, "PROXY_PLACEMENT_CONTROLLER", "http://127.0.0.1:3847"
                ), \
                unittest.mock.patch.object(proxy, "_placement_controller_admit", _no_controller):
            response = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None)
            )
        self.assertEqual(response.status_code, 409)
        body = json.loads(response.body)
        self.assertEqual(body["error"]["reason"], "vision_encoder_oom")
        self.assertNotIn("placement_id", body["error"])


class TestAdmitReasonPayload(unittest.TestCase):
    """The reason field is opt-in: admission parks (request-side) never carry
    it — the controller derives those reasons itself; response-side parks
    (the proxy saw the upstream error) carry exactly the vision class."""

    def test_reason_forwarded_when_given(self):
        fake = _FakeClient([_FakeResponse({"decision": "park", "placement_id": "p"}, 200)])

        async def call():
            return await proxy._placement_controller_admit(
                "inkling2-mini", "byok-droid", None, cells=1024, reason="vision_encoder_oom"
            )

        with unittest.mock.patch.object(
            proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"
        ), unittest.mock.patch.object(proxy, "http_client", fake):
            answer = asyncio.run(call())
        self.assertEqual(answer["decision"], "park")
        payload = fake.requests[0]["kwargs"]["json"]
        self.assertEqual(
            payload,
            {
                "model_id": "inkling2-mini",
                "client": "byok-droid",
                "session": None,
                "cells": 1024,
                "reason": "vision_encoder_oom",
            },
        )

    def test_reason_absent_when_not_given(self):
        fake = _FakeClient([_FakeResponse({"decision": "forward"}, 200)])

        async def call():
            return await proxy._placement_controller_admit("m", "c", None)

        with unittest.mock.patch.object(
            proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"
        ), unittest.mock.patch.object(proxy, "http_client", fake):
            answer = asyncio.run(call())
        self.assertEqual(answer["decision"], "forward")
        payload = fake.requests[0]["kwargs"]["json"]
        self.assertEqual(
            payload, {"model_id": "m", "client": "c", "session": None}
        )
        self.assertNotIn("reason", payload)

    def test_no_controller_configured_returns_none(self):
        async def call():
            return await proxy._placement_controller_admit("m", "c", None)

        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""):
            self.assertIsNone(asyncio.run(call()))


if __name__ == "__main__":
    unittest.main()
