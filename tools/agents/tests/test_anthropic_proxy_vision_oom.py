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

    @property
    def text(self):
        return json.dumps(self._payload)

    async def aread(self):
        return self.text.encode()

    async def aclose(self):
        pass


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

_UPSTREAM_400_PAYLOAD = {
    "error": {"type": "invalid_request_error", "message": LIVE_SIGNATURE}
}


class _FakeHttp:
    """One fake httpx.AsyncClient routing by URL: the placement controller's
    admit endpoint vs the upstream backend, so the relay-site tests below can
    drive messages() end-to-end (the real wiring) instead of the helpers.

    NOTE: the ``json`` kwarg name shadows the module inside methods, so no
    method here may use the json module — precompute payloads instead."""

    def __init__(self, upstream_response=None):
        self.upstream_posts = []   # captured upstream request bodies
        self.controller_asks = [] # captured admit payloads
        self._upstream = upstream_response

    def _controller_answer(self, payload):
        # The placement admit (request-side, no reason) forwards: the arm IS
        # resident and serving. The vision ask (response-side,
        # reason=vision_encoder_oom) parks.
        if isinstance(payload, dict) and payload.get("reason") == "vision_encoder_oom":
            return {
                "decision": "park",
                "placement_id": "plc-relay9",
                "reason": "vision_encoder_oom",
            }
        return {"decision": "forward", "target_id": "gpu0:http://127.0.0.1:8080"}

    async def post(self, url, json=None, **kwargs):
        url = str(url)
        if "placement/admit" in url:
            self.controller_asks.append(json)
            return _FakeResponse(self._controller_answer(json), 200)
        self.upstream_posts.append(json)
        if self._upstream is not None:
            return self._upstream
        return _FakeResponse(_UPSTREAM_400_PAYLOAD, 400)

    def build_request(self, method, url, **kwargs):
        return {"method": method, "url": url, "kwargs": kwargs}

    async def send(self, request, stream=False):
        return await self.post(
            request["url"], json=request["kwargs"].get("json")
        )


_IMAGE_REQUEST = {
    "model": "inkling2-mini",
    "max_tokens": 32,
    "stream": False,
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "iVBORw0KGgo=",
                    },
                },
                {"type": "text", "text": "what is in this image?"},
            ],
        }
    ],
}


class TestVisionRelayWiring(unittest.TestCase):
    """The three relay hooks in messages() — the wiring, not the helpers.

    Deleting the hooks leaves every helper-level test green, so these tests
    pin the actual production paths: the non-stream relay, the stream relay
    (the default client path), and the pre-request park during an armed
    window (which must not round-trip upstream and must not re-arm the
    window)."""

    def setUp(self):
        self._window = proxy._upstream_vision_broken_until
        self._saved = {
            attr: getattr(proxy, attr)
            for attr in (
                "PROXY_VISION",
                "PROXY_PLACEMENT_MODE",
                "PROXY_PLACEMENT_CONTROLLER",
                "PROXY_VISION_OOM_DEGRADE_SECS",
                "PROXY_AUTH_TOKEN",
                "http_client",
                "PROXY_UPSTREAM_RETRY_MAX",
                "upstream_vision",
            )
        }
        proxy._placement_pending.clear()
        proxy.PROXY_VISION = "on"  # force image forwarding, no probe needed
        proxy.PROXY_PLACEMENT_MODE = "off"
        proxy.PROXY_PLACEMENT_CONTROLLER = ""
        proxy.PROXY_VISION_OOM_DEGRADE_SECS = 600.0
        proxy.PROXY_AUTH_TOKEN = ""
        proxy.PROXY_UPSTREAM_RETRY_MAX = 1

    def tearDown(self):
        for attr, value in self._saved.items():
            setattr(proxy, attr, value)
        proxy._placement_pending.clear()
        proxy._upstream_vision_broken_until = self._window

    def _client(self, http):
        # NO context manager: entering one runs the app's lifespan startup,
        # which re-creates http_client as a real AsyncClient and silently
        # replaces this fake — the request then hits the LIVE backend and
        # controller (observed: 529s and a live unknown_model park). Without
        # the context the routes still serve; only lifespan is skipped.
        from fastapi.testclient import TestClient

        proxy.http_client = http
        return TestClient(proxy.app)

    def _assert_park_body(self, response_json):
        err = response_json["error"]
        self.assertEqual(err["type"], "model_placement_pending")
        self.assertEqual(err["reason"], "vision_encoder_oom")

    def test_non_stream_relay_parks_instead_of_relaying_the_raw_400(self):
        http = _FakeHttp()
        tc = self._client(http)
        r = tc.post("/v1/messages", json=_IMAGE_REQUEST)
        # The wiring: the 400 was classified and PARKED, not relayed.
        self.assertEqual(r.status_code, 409)
        self._assert_park_body(r.json())
        # Evidence the round-trip happened and the window armed.
        self.assertEqual(len(http.upstream_posts), 1)
        self.assertGreater(proxy._upstream_vision_broken_until, time.time())

    def test_stream_relay_parks_instead_of_relaying_the_raw_400(self):
        http = _FakeHttp()
        request = dict(_IMAGE_REQUEST, stream=True)
        tc = self._client(http)
        r = tc.post("/v1/messages", json=request)
        self.assertEqual(r.status_code, 409)
        self._assert_park_body(r.json())
        self.assertEqual(len(http.upstream_posts), 1)
        self.assertGreater(proxy._upstream_vision_broken_until, time.time())

    def test_pre_request_park_no_upstream_round_trip_no_rearm(self):
        # Window armed + placement on + controller reachable: an image
        # request parks BEFORE the wire, without re-arming the window (the
        # parked retry is not evidence), and the burst dedupe collapses the
        # controller ask so the client's retry re-parks with zero network.
        http = _FakeHttp()
        proxy.PROXY_PLACEMENT_MODE = "ask"
        proxy.PROXY_PLACEMENT_CONTROLLER = "http://127.0.0.1:3847"
        armed_until = time.time() + 600.0
        proxy._upstream_vision_broken_until = armed_until
        tc = self._client(http)
        r1 = tc.post("/v1/messages", json=_IMAGE_REQUEST)
        r2 = tc.post("/v1/messages", json=_IMAGE_REQUEST)
        for r in (r1, r2):
            self.assertEqual(r.status_code, 409)
            err = r.json()["error"]
            self.assertEqual(err["reason"], "vision_encoder_oom")
            self.assertEqual(err["placement_id"], "plc-relay9")
        # No upstream round-trip for either request — the encoder is known
        # broken; sending the image again would just burn the encode.
        self.assertEqual(http.upstream_posts, [])
        # The window was NOT extended by the parks (rearm=False): the parked
        # retries the 409 itself tells the client to make are not evidence.
        self.assertEqual(proxy._upstream_vision_broken_until, armed_until)
        # Exactly ONE vision ask served both requests: the first minted the
        # burst-dedupe entry, the retry re-parked from the map with no
        # controller round-trip.
        vision_asks = [a for a in http.controller_asks if a and a.get("reason")]
        self.assertEqual(len(vision_asks), 1)
        self.assertEqual(vision_asks[0]["reason"], "vision_encoder_oom")

    def test_vision_park_never_parks_text_requests(self):
        # The starved arm still serves text — a vision park keyed on the
        # plain (client, model) burst key would 409 the same client's TEXT
        # requests with "cannot encode images" for a request that forwards
        # fine. The ':vision'-suffixed key serves image requests only.
        http = _FakeHttp(
            upstream_response=_FakeResponse(
                {"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
                200,
            )
        )
        proxy.PROXY_PLACEMENT_MODE = "ask"
        proxy.PROXY_PLACEMENT_CONTROLLER = "http://127.0.0.1:3847"
        proxy._upstream_vision_broken_until = time.time() + 600.0
        tc = self._client(http)
        parked = tc.post("/v1/messages", json=_IMAGE_REQUEST)
        self.assertEqual(parked.status_code, 409)
        text_request = dict(_IMAGE_REQUEST, messages=[{"role": "user", "content": "text only"}])
        forwarded = tc.post("/v1/messages", json=text_request)
        self.assertEqual(forwarded.status_code, 200)
        # The ONLY upstream round-trip is the text one.
        self.assertEqual(len(http.upstream_posts), 1)

    def test_custom_local_id_asks_by_the_served_arm_end_to_end(self):
        # Full automation (uplift): a BYOK custom-local id names the local
        # BACKEND, not a registry model — every placement ask it produces
        # (the request gate's forward ask AND the vision park's switch ask)
        # must carry the RESOLVED served id, and the pre-request burst keys
        # must agree with the park response's keys so a retry collapses to
        # one vision ask instead of re-asking per retry.
        async def ids():
            return ["Inkling 2 Mini"]

        http = _FakeHttp()
        proxy.PROXY_PLACEMENT_MODE = "ask"
        proxy.PROXY_PLACEMENT_CONTROLLER = "http://127.0.0.1:3847"
        tc = self._client(http)
        body = dict(
            _IMAGE_REQUEST, model="custom:Inkling-2-Mini-Basalt-NVFP4-q8-(UAP-local)-0"
        )
        with unittest.mock.patch.object(proxy, "_upstream_model_ids_cached", ids):
            first = tc.post("/v1/messages", json=body)
        self.assertEqual(first.status_code, 409)
        self._assert_park_body(first.json())
        # The gate ask AND the vision ask both named the ARM, never the
        # custom string (the registry declares wire ids, not BYOK strings).
        self.assertEqual(len(http.controller_asks), 2)
        for ask in http.controller_asks:
            self.assertEqual(ask["model_id"], "Inkling 2 Mini")
        self.assertEqual(
            [a.get("reason") for a in http.controller_asks],
            [None, "vision_encoder_oom"],
        )
        # The retry, inside the armed window, burst-dedupes: the gate may
        # re-ask (its answer is a forward, not a park — nothing cached), but
        # the VISION ask happens once for the burst.
        with unittest.mock.patch.object(proxy, "_upstream_model_ids_cached", ids):
            second = tc.post("/v1/messages", json=body)
        self.assertEqual(second.status_code, 409)
        vision_asks = [
            a for a in http.controller_asks if a.get("reason") == "vision_encoder_oom"
        ]
        self.assertEqual(len(vision_asks), 1)

    def test_window_without_controller_strips_images_and_forwards(self):
        # No controller: a park with nothing to switch to is a dead request,
        # so the window routes image blocks through the existing
        # strip-and-notice path — the upstream must see a text-only body.
        # PROXY_VISION='auto' (not 'on'): the explicit pin dominates the
        # window, and this test needs the WINDOW to dominate the probe.
        http = _FakeHttp(
            upstream_response=_FakeResponse(
                {
                    "choices": [
                        {"message": {"role": "assistant", "content": "a text answer"}}
                    ]
                },
                200,
            )
        )
        proxy.PROXY_VISION = "auto"
        proxy.upstream_vision = True
        proxy._upstream_vision_broken_until = time.time() + 600.0
        tc = self._client(http)
        r = tc.post("/v1/messages", json=_IMAGE_REQUEST)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(http.upstream_posts), 1)
        forwarded = http.upstream_posts[0]
        self.assertIsNotNone(forwarded, "upstream request must be captured")
        dumped = json.dumps(forwarded)
        self.assertNotIn("image_url", dumped)
        self.assertNotIn('"image"', dumped)


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

    def test_generic_memory_without_an_encoder_named_is_not_the_switch_condition(self):
        # A host-RAM decode failure on one pathological image: image-class
        # AND memory-class words, but no device memory and no encoder named —
        # no arm switch can fix it, so it must not park image traffic or
        # churn switches.
        self.assertFalse(
            proxy._is_vision_encoder_oom(
                400, "the image could not be read: out of memory while decoding"
            )
        )

    def test_generic_memory_with_an_encoder_named_is_the_switch_condition(self):
        self.assertTrue(
            proxy._is_vision_encoder_oom(
                400, "the image could not be read: out of memory in the image encoder"
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

    def test_pre_request_park_does_not_rearm_the_window(self):
        # The 409 tells the client to retry. If every parked retry re-armed
        # the window, a compliant retrying client would hold vision degraded
        # for every session as long as it kept retrying inside the window
        # (the window would only expire after 600s of NO image requests).
        # Only the 400-classified relays arm/re-arm; the pre-request park
        # serves the 409 without extending the window.
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""), \
                unittest.mock.patch.object(proxy, "PROXY_VISION_OOM_DEGRADE_SECS", 600.0):
            armed_until = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None)
            )
            self.assertEqual(armed_until.status_code, 409)
            first_until = proxy._upstream_vision_broken_until
            # A parked retry arrives well inside the window.
            time.sleep(0.01)
            response = self._run(
                proxy._vision_oom_park_response(
                    "inkling2-mini", "byok-droid", None, rearm=False
                )
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(proxy._upstream_vision_broken_until, first_until)

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

    def test_controller_auto_switch_park_body_names_the_switch(self):
        # The auto-approved switch parks with its OWN message: the operator
        # step is "wait", not "resolve" — the client's retry forwards when
        # the background switch lands.
        proxy._placement_pending.clear()
        fake = _FakeClient(
            [
                _FakeResponse(
                    {
                        "decision": "park",
                        "placement_id": "plc-v002",
                        "reason": "vision_auto_loading",
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
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", "s1")
            )
        self.assertEqual(response.status_code, 409)
        body = json.loads(response.body)
        err = body["error"]
        self.assertEqual(err["reason"], "vision_auto_loading")
        self.assertEqual(err["placement_id"], "plc-v002")
        self.assertIn("switched to automatically", err["message"])
        self.assertIn("retrying is correct", err["message"])
        self.assertIn("wait for the automatic switch", err["resolve_with"])
        self.assertIn("uap models auto --disable", err["resolve_with"])
        # The model-keyed burst entry (`__auto__`) covers a client that
        # rotates its id header mid-burst: one ask per model, not per id.
        entries = proxy._placement_pending
        self.assertIn(("byok-droid", "inkling2-mini:vision"), entries)
        self.assertIn(("__auto__", "inkling2-mini:vision"), entries)
        self.assertEqual(
            entries[("__auto__", "inkling2-mini:vision")]["reason"],
            "vision_auto_loading",
        )
        proxy._placement_pending.clear()

    def test_controller_forward_answer_still_parks_self_describing(self):
        # A dict-but-not-park answer (e.g. the controller says forward for
        # the arm) cannot un-fail the encoder: this park was reached BECAUSE
        # the upstream demonstrably failed to encode. Fail closed to the
        # self-describing 409 — never relay the raw 400, never forward the
        # doomed image request, never mint a burst entry for a non-park.
        proxy._placement_pending.clear()
        fake = _FakeClient(
            [
                _FakeResponse(
                    {"decision": "forward", "target_id": "gpu0:http://127.0.0.1:8080"},
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
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None)
            )
        self.assertEqual(response.status_code, 409)
        body = json.loads(response.body)
        self.assertEqual(body["error"]["reason"], "vision_encoder_oom")
        self.assertNotIn("placement_id", body["error"])
        self.assertEqual(proxy._placement_pending, {})

    def test_secs_zero_disables_the_window_not_the_conversion(self):
        # SECS=0 is the operator's "no sustained degrade" switch: the park
        # still converts the raw 400 into the clean 409 (that conversion is
        # not window-gated), but the window arms to NOW — instantly expired
        # — so no pre-request parks and advertised vision follows the probe.
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", ""), \
                unittest.mock.patch.object(proxy, "PROXY_VISION_OOM_DEGRADE_SECS", 0.0):
            response = self._run(
                proxy._vision_oom_park_response("inkling2-mini", "byok-droid", None)
            )
        self.assertEqual(response.status_code, 409)
        self.assertLessEqual(proxy._upstream_vision_broken_until, time.time())
        with unittest.mock.patch.object(proxy, "upstream_vision", True):
            self.assertTrue(proxy.vision_enabled())
        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"):
            self.assertFalse(proxy._vision_park_due())


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


class TestByokAskResolution(unittest.TestCase):
    """BYOK custom-local ids resolve to the served id for placement asks
    (uplift: full automation). The registry declares the WIRE ids a backend
    serves; the harness's `custom:<name>-(UAP-local)-<n>` strings name the
    local backend itself and are declared nowhere — without this resolution
    every BYOK request parks as invalid_request/unroutable the moment the
    placement gate turns on."""

    def _run(self, coro):
        return asyncio.run(coro)

    def test_custom_local_resolves_to_the_served_id(self):
        async def ids():
            return ["Inkling 2 Mini", "qwen35-a3b-iq4xs"]

        with unittest.mock.patch.object(proxy, "_upstream_model_ids_cached", ids):
            got = self._run(
                proxy._placement_ask_model("custom:Inkling-2-Mini-Basalt-NVFP4-q8-(UAP-local)-0")
            )
        self.assertEqual(got, "Inkling 2 Mini")

    def test_non_custom_ids_pass_through_untouched(self):
        # Only the custom-local class resolves — every other id asks raw so
        # an unknown model stays the operator's parked decision, never a
        # silent rewrite to the live arm.
        for raw in ("Inkling 2 Mini", "qwen3.8-27b", None):
            self.assertEqual(self._run(proxy._placement_ask_model(raw)), raw)

    def test_no_upstream_knowledge_asks_raw(self):
        # Fail-open shape: nothing served-known → ask raw, the controller
        # parks it, the operator decides.
        async def none_ids():
            return None

        with unittest.mock.patch.object(proxy, "_upstream_model_ids_cached", none_ids):
            got = self._run(proxy._placement_ask_model("custom:Foo-(UAP-local)-0"))
        self.assertEqual(got, "custom:Foo-(UAP-local)-0")

    def test_placement_admit_asks_by_the_resolved_id_and_keys_the_burst_by_it(self):
        fake = _FakeClient(
            [
                _FakeResponse(
                    {"decision": "park", "placement_id": "plc-byok1", "reason": "not_resident"},
                    200,
                )
            ]
        )

        async def ids():
            return ["Inkling 2 Mini"]

        with unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_MODE", "ask"), \
                unittest.mock.patch.object(proxy, "PROXY_PLACEMENT_CONTROLLER", "http://c"), \
                unittest.mock.patch.object(proxy, "http_client", fake), \
                unittest.mock.patch.object(proxy, "_upstream_model_ids_cached", ids):
            response = self._run(
                proxy._placement_admit(
                    "custom:Inkling-2-Mini-Basalt-NVFP4-q8-(UAP-local)-0",
                    "byok-droid",
                    None,
                )
            )
        # Parked through the controller's answer, and the ASK named the arm.
        self.assertEqual(response.status_code, 409)
        payload = fake.requests[0]["kwargs"]["json"]
        self.assertEqual(payload["model_id"], "Inkling 2 Mini")
        # The burst key is the RESOLVED id — a client retry after the arm
        # switches would resolve the same way and re-park cleanly, while the
        # raw custom string would never match anything again.
        self.assertIn(("byok-droid", "Inkling 2 Mini"), proxy._placement_pending)
        self.assertNotIn(
            ("byok-droid", "custom:Inkling-2-Mini-Basalt-NVFP4-q8-(UAP-local)-0"),
            proxy._placement_pending,
        )
        proxy._placement_pending.clear()


if __name__ == "__main__":
    unittest.main()
