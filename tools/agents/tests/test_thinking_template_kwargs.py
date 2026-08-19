"""Turning reasoning off must reach the place llama.cpp actually reads it.

Measured on the live server (Qwen3.6-35B-A3B, launched `--jinja
--chat-template-kwargs {"enable_thinking": true}`), identical tool-call prompt:

    top-level "enable_thinking": false   -> 703 chars of reasoning, 196 tokens
    chat_template_kwargs.enable_thinking ->   0 chars,                27 tokens

and on a planning-flavoured prompt with max_tokens=700, reasoning consumed the
ENTIRE budget and NO tool call was emitted — the "stuck planning" symptom.

Every thinking switch in the proxy set only the top-level field, so
PROXY_DISABLE_THINKING_ALWAYS, PROXY_DISABLE_THINKING_ON_TOOL_TURNS and the
Anthropic `thinking: {type: disabled}` parameter were all no-ops against a jinja
server: the controls existed, logged themselves as active, and changed nothing.
"""
import asyncio
import importlib.util
import json
import os
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


_PRIOR_AUTOLOAD = os.environ.get("UAP_PROXY_ENV_AUTOLOAD")


def tearDownModule():
    # Restore rather than leak into any test sharing this process.
    if _PRIOR_AUTOLOAD is None:
        os.environ.pop("UAP_PROXY_ENV_AUTOLOAD", None)
    else:
        os.environ["UAP_PROXY_ENV_AUTOLOAD"] = _PRIOR_AUTOLOAD


def load_proxy(**env):
    # Explicit, so a project .uap/proxy.env cannot leak in when this module is
    # run directly rather than through the npm script.
    os.environ["UAP_PROXY_ENV_AUTOLOAD"] = "0"
    for k in (
        "PROXY_DISABLE_THINKING_ALWAYS",
        "PROXY_DISABLE_THINKING_ON_TOOL_TURNS",
        # This branch exists precisely so an operator will set this one, so an
        # operator's shell must not be able to change what the suite means.
        "PROXY_CHAT_TEMPLATE_KWARGS",
    ):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in env.items()})
    spec = importlib.util.spec_from_file_location("anthropic_proxy_thinking", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SetThinkingTest(unittest.TestCase):
    def tearDown(self):
        for k in ("PROXY_DISABLE_THINKING_ALWAYS", "PROXY_DISABLE_THINKING_ON_TOOL_TURNS"):
            os.environ.pop(k, None)

    def test_disabling_reaches_chat_template_kwargs(self):
        # THE BUG: the top-level field alone is overridden by the server's
        # --chat-template-kwargs default, so reasoning kept flowing.
        ap = load_proxy()
        body = {}
        ap._set_thinking(body, False)
        self.assertIs(body["chat_template_kwargs"]["enable_thinking"], False)

    def test_top_level_is_still_set_for_servers_that_read_it(self):
        # Belt and braces: non-jinja / older builds read the top-level field.
        ap = load_proxy()
        body = {}
        ap._set_thinking(body, False)
        self.assertIs(body["enable_thinking"], False)

    def test_enabling_reaches_both_places_too(self):
        ap = load_proxy()
        body = {}
        ap._set_thinking(body, True)
        self.assertIs(body["enable_thinking"], True)
        self.assertIs(body["chat_template_kwargs"]["enable_thinking"], True)

    def test_existing_chat_template_kwargs_are_preserved(self):
        # The server is launched with other template kwargs; clobbering the dict
        # would drop them.
        ap = load_proxy()
        body = {"chat_template_kwargs": {"preserve_thinking": False, "custom": 1}}
        ap._set_thinking(body, False)
        self.assertEqual(body["chat_template_kwargs"]["custom"], 1)
        self.assertIs(body["chat_template_kwargs"]["preserve_thinking"], False)
        self.assertIs(body["chat_template_kwargs"]["enable_thinking"], False)

    def test_a_non_dict_kwargs_value_does_not_raise(self):
        # Defensive: a malformed client body must not 500 the turn.
        ap = load_proxy()
        body = {"chat_template_kwargs": "nonsense"}
        ap._set_thinking(body, False)
        self.assertIs(body["enable_thinking"], False)

    def test_a_shallow_retry_copy_does_not_disable_thinking_on_the_original(self):
        # The helper's whole rationale: retry bodies are built as
        # `dict(openai_body)`, which SHARES this nested dict. Mutating it in
        # place would disable thinking on the in-flight request too.
        ap = load_proxy()
        original = {"chat_template_kwargs": {"enable_thinking": True}}
        retry = dict(original)
        ap._set_thinking(retry, False)
        self.assertIs(original["chat_template_kwargs"]["enable_thinking"], True)
        self.assertIs(retry["chat_template_kwargs"]["enable_thinking"], False)


class SwitchesReachTheTemplateTest(unittest.TestCase):
    """The switches, exercised through the real request builder."""

    def tearDown(self):
        for k in ("PROXY_DISABLE_THINKING_ALWAYS", "PROXY_DISABLE_THINKING_ON_TOOL_TURNS"):
            os.environ.pop(k, None)

    @staticmethod
    def _build(ap, tools=False):
        body = {"model": "test", "messages": [{"role": "user", "content": "hi"}]}
        if tools:
            body["tools"] = [
                {"name": "Read", "description": "Read file", "input_schema": {"type": "object"}}
            ]
        return ap.build_openai_request(body, ap.SessionMonitor(context_window=262144))

    def test_always_switch_reaches_chat_template_kwargs(self):
        ap = load_proxy(PROXY_DISABLE_THINKING_ALWAYS="on")
        built = self._build(ap)
        self.assertIs(built["chat_template_kwargs"]["enable_thinking"], False)

    def test_protocol_default_does_NOT_force_the_template(self):
        # Deliberate: Anthropic defaults thinking off, and making that
        # authoritative would flip every client that never asked for it from
        # the server's configured default to off. A serving-policy change is
        # not a bug fix; operators have an explicit switch for that.
        ap = load_proxy()
        built = self._build(ap)
        self.assertIs(built["enable_thinking"], False)
        self.assertNotIn(
            "enable_thinking",
            built.get("chat_template_kwargs", {}),
            "the protocol default must not override the server's configured default",
        )

    def test_a_client_cannot_turn_thinking_ON_against_the_server_default(self):
        # The measured bug was one-directional (an OFF switch that didn't
        # stick); the fix stays one-directional.
        ap = load_proxy()
        body = {
            "model": "test",
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {"type": "enabled"},
        }
        built = ap.build_openai_request(body, ap.SessionMonitor(context_window=262144))
        self.assertIs(built["enable_thinking"], True)
        self.assertNotIn("enable_thinking", built.get("chat_template_kwargs", {}))




class ChatTemplateKwargsCapabilityTest(unittest.TestCase):
    """`chat_template_kwargs` is a llama.cpp `--jinja` concept, not OpenAI API.

    Measured 2026-08-19 against ninfer-serve (the qwen3.8-27b backend):

        HTTP 400 {"error":{"code":"chat_template_option_not_supported",
          "message":"chat_template_kwargs.enable_thinking is not supported",
          "param":"chat_template_kwargs","type":"invalid_request_error"}}

    Sending it there does not merely fail to take effect — it 400s the whole
    turn, so every path that expresses a thinking intent (the operator
    switches, the tool-turn breakers, the JSON-verdict grammar, the
    empty-response retry, every assistant prefill) died on that backend.
    """

    def tearDown(self):
        os.environ.pop("PROXY_CHAT_TEMPLATE_KWARGS", None)

    def test_unknown_support_still_writes_the_field(self):
        # UNKNOWN MUST MEAN YES. Dropping the field on llama.cpp does not fail
        # loudly, it silently restores the template default and every thinking
        # control becomes a no-op again — the original bug this file covers.
        ap = load_proxy()
        self.assertIsNone(ap._ctk_supported)
        body = {}
        ap._set_thinking(body, False)
        self.assertIs(body["chat_template_kwargs"]["enable_thinking"], False)

    def test_rejecting_backend_gets_only_the_top_level_flag(self):
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="off")
        body = {}
        ap._set_thinking(body, False)
        self.assertNotIn("chat_template_kwargs", body)
        self.assertIs(body["enable_thinking"], False)

    def test_pinned_on_writes_the_field(self):
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="on")
        body = {}
        ap._set_thinking(body, True)
        self.assertIs(body["chat_template_kwargs"]["enable_thinking"], True)

    def test_a_stale_field_is_removed_not_left_behind(self):
        # A retry body is built with dict(openai_body): the caller may hand us
        # one that already carries the field from before the latch flipped.
        # Leaving it would 400 the retry the latch exists to rescue.
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="off")
        body = {"chat_template_kwargs": {"enable_thinking": True}}
        ap._set_thinking(body, False)
        self.assertNotIn("chat_template_kwargs", body)

    def test_error_latch_recognises_the_rejection(self):
        ap = load_proxy()
        self.assertTrue(
            ap._note_ctk_rejection(
                '{"error":{"code":"chat_template_option_not_supported",'
                '"message":"chat_template_kwargs.enable_thinking is not supported"}}'
            )
        )
        self.assertIs(ap._ctk_supported, False)
        body = {}
        ap._set_thinking(body, False)
        self.assertNotIn("chat_template_kwargs", body)

    def test_error_latch_ignores_unrelated_upstream_errors(self):
        # An overload / bad-model / auth error says nothing about this field.
        # Latching on it would disable a field llama.cpp needs, permanently,
        # for the life of the process.
        ap = load_proxy()
        self.assertFalse(ap._note_ctk_rejection('{"error":{"code":"model_not_found"}}'))
        self.assertFalse(ap._note_ctk_rejection("upstream overloaded"))
        self.assertFalse(ap._note_ctk_rejection(""))
        self.assertIsNone(ap._ctk_supported)
        body = {}
        ap._set_thinking(body, False)
        self.assertIn("chat_template_kwargs", body)

    def test_an_operator_pin_of_on_is_not_overridden_by_the_latch(self):
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="on")
        self.assertFalse(
            ap._note_ctk_rejection("chat_template_option_not_supported")
        )
        self.assertIs(ap._ctk_supported, True)

    def test_prefill_turn_does_not_send_the_field_to_a_rejecting_backend(self):
        # The prefill block sets the nested key to dodge the jinja template's
        # "prefill is incompatible with enable_thinking" 400. A backend with no
        # jinja template has no such incompatibility — and would 400 on the
        # workaround itself.
        ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS="off")
        out = ap.build_openai_request(
            {
                "model": "qwen3.8-27b",
                "max_tokens": 64,
                "messages": [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "partial"},
                ],
            },
            ap.SessionMonitor(context_window=131072),
        )
        self.assertNotIn("chat_template_kwargs", out)
        self.assertIs(out.get("enable_thinking"), False)


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text if text is not None else json.dumps(self._payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Records what the probe actually put on the wire."""

    def __init__(self, models_status=200, models_payload=None, post_response=None):
        self.posts = []
        self.gets = []
        self._models_status = models_status
        self._models_payload = (
            models_payload
            if models_payload is not None
            else {"data": [{"id": "qwen3.8-27b", "object": "model"}]}
        )
        self._post_response = post_response

    async def get(self, url, **kw):
        self.gets.append(url)
        return _FakeResponse(self._models_status, self._models_payload)

    async def post(self, url, json=None, **kw):
        self.posts.append(json or {})
        return self._post_response


REJECTION = _FakeResponse(
    400,
    text=(
        '{"error":{"code":"chat_template_option_not_supported","message":'
        '"chat_template_kwargs.enable_thinking is not supported",'
        '"param":"chat_template_kwargs","type":"invalid_request_error"}}'
    ),
)


class ChatTemplateKwargsProbeTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("PROXY_CHAT_TEMPLATE_KWARGS", None)

    def test_probe_sends_a_model_or_it_cannot_learn_anything(self):
        # REGRESSION. The first version of the probe omitted `model`. The server
        # answered `missing required field: model` — a 400 that says nothing
        # about chat_template_kwargs — so the probe correctly declined to latch
        # and learned nothing on every attempt. Verified live against
        # ninfer-serve before this test was written.
        ap = load_proxy()
        client = _FakeClient(post_response=REJECTION)
        ap.http_client = client
        asyncio.run(ap._probe_chat_template_kwargs())
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.posts[0].get("model"), "qwen3.8-27b")
        self.assertIn("chat_template_kwargs", client.posts[0])
        self.assertIs(ap._ctk_supported, False)

    def test_a_200_marks_the_field_supported(self):
        ap = load_proxy()
        ap.http_client = _FakeClient(post_response=_FakeResponse(200, {"choices": []}))
        asyncio.run(ap._probe_chat_template_kwargs())
        self.assertIs(ap._ctk_supported, True)

    def test_an_unrelated_error_leaves_the_answer_unknown(self):
        # Unknown must stay unknown: latching 'unsupported' off an overload or
        # auth error would permanently disable a field llama.cpp needs.
        ap = load_proxy()
        ap.http_client = _FakeClient(
            post_response=_FakeResponse(503, text='{"error":{"message":"overloaded"}}')
        )
        asyncio.run(ap._probe_chat_template_kwargs())
        self.assertIsNone(ap._ctk_supported)

    def test_inconclusive_probes_stop_after_the_attempt_cap(self):
        # Re-arming forever would add an upstream round-trip to EVERY request
        # for the life of the process.
        ap = load_proxy()
        client = _FakeClient(
            post_response=_FakeResponse(503, text='{"error":{"message":"overloaded"}}')
        )
        ap.http_client = client
        for _ in range(10):
            asyncio.run(ap._probe_chat_template_kwargs())
        self.assertEqual(ap._ctk_probe_attempts, ap._CTK_PROBE_MAX_ATTEMPTS)
        self.assertIsNone(ap._ctk_supported)

    def test_an_unreachable_model_list_does_not_disable_the_field(self):
        ap = load_proxy()
        ap.http_client = _FakeClient(models_status=500, post_response=REJECTION)
        asyncio.run(ap._probe_chat_template_kwargs())
        self.assertIsNone(ap._ctk_supported)

    def test_an_operator_pin_skips_the_probe_entirely(self):
        for pin in ("on", "off"):
            with self.subTest(pin=pin):
                ap = load_proxy(PROXY_CHAT_TEMPLATE_KWARGS=pin)
                client = _FakeClient(post_response=REJECTION)
                ap.http_client = client
                asyncio.run(ap._probe_chat_template_kwargs())
                self.assertEqual(client.posts, [])


class MatcherStrictnessTest(unittest.TestCase):
    """The latch must not fire on an error that merely QUOTES the request.

    The proxy puts the literal string `chat_template_kwargs` in its own outbound
    body, and a middlebox that echoes the request in an error envelope is the
    most likely component to reshape it. Matching the bare name therefore made
    any unrelated 400/429/503 able to disable a field llama.cpp needs -- the bad
    direction, permanently, for the life of the process.
    """

    def tearDown(self):
        os.environ.pop("PROXY_CHAT_TEMPLATE_KWARGS", None)

    def test_an_error_echoing_the_request_body_does_not_latch(self):
        ap = load_proxy()
        echoed = (
            '{"error":{"message":"context length exceeded. received request body: '
            '{\'model\': \'x\', \'chat_template_kwargs\': {\'enable_thinking\': false}}"}}'
        )
        self.assertFalse(ap._note_ctk_rejection(echoed))
        self.assertIsNone(ap._ctk_supported)

    def test_the_contractual_code_still_latches(self):
        ap = load_proxy()
        self.assertTrue(ap._note_ctk_rejection('{"error":{"code":"chat_template_option_not_supported"}}'))
        self.assertIs(ap._ctk_supported, False)

    def test_the_human_message_alone_still_latches(self):
        # The documented reshaped-envelope case: no machine-readable code
        # survived, but the sentence did.
        ap = load_proxy()
        self.assertTrue(ap._note_ctk_rejection("unknown field: chat_template_kwargs"))
        self.assertIs(ap._ctk_supported, False)

    def test_the_name_with_no_rejection_phrase_does_not_latch(self):
        ap = load_proxy()
        self.assertFalse(ap._note_ctk_rejection("debug: chat_template_kwargs seen"))
        self.assertIsNone(ap._ctk_supported)


class ColdBackendProbeBudgetTest(unittest.TestCase):
    """A model server still loading its weights must not spend the probe budget.

    `uap proxy` starts the proxy alongside the model server, so the first
    requests routinely land while it is loading. Counting those 503s exhausts
    all three attempts before the server is up, and the answer then stays
    "unknown" for the life of the process -- which is "keep sending the field",
    i.e. permanent breakage on a backend that rejects it.
    """

    def tearDown(self):
        os.environ.pop("PROXY_CHAT_TEMPLATE_KWARGS", None)

    def test_a_loading_model_503_is_not_an_attempt(self):
        ap = load_proxy()
        loading = _FakeResponse(503, text='{"error":{"message":"Loading model"}}')
        ap.http_client = _FakeClient(post_response=loading)
        for _ in range(5):
            asyncio.run(ap._probe_chat_template_kwargs())
        self.assertEqual(ap._ctk_probe_attempts, 0)
        self.assertFalse(ap._ctk_probed)
        self.assertIsNone(ap._ctk_supported)

    def test_and_the_probe_still_answers_once_the_backend_is_up(self):
        ap = load_proxy()
        ap.http_client = _FakeClient(post_response=_FakeResponse(503, text='{"error":{"message":"Loading model"}}'))
        asyncio.run(ap._probe_chat_template_kwargs())
        ap.http_client = _FakeClient(post_response=REJECTION)
        asyncio.run(ap._probe_chat_template_kwargs())
        self.assertIs(ap._ctk_supported, False)


class WireModelReconciliationTest(unittest.TestCase):
    """Send a model the backend answers to, or the turn is lost to a 404.

    llama.cpp ignored the OpenAI `model` field; ninfer validates it. With the
    local-only sentinel every advertised id is served locally, so the four
    `claude-*` ids the proxy advertises for SDK compatibility all came back
    `404 model_not_found` -- measured against the live backend.
    """

    def _ap(self, ids=("qwen3.8-27b",)):
        ap = load_proxy()
        ap.http_client = _FakeClient(
            models_payload={"data": [{"id": i, "object": "model"} for i in ids]},
            post_response=_FakeResponse(200, {"choices": []}),
        )
        return ap

    def test_an_unservable_id_is_rewritten_to_what_the_backend_serves(self):
        ap = self._ap()
        body = {"model": "claude-sonnet-4-6", "messages": []}
        asyncio.run(ap._reconcile_wire_model(body))
        self.assertEqual(body["model"], "qwen3.8-27b")

    def test_a_retired_local_preset_id_is_rewritten_too(self):
        # This repo's own .uap.json still names qwen36-a3b as roles.fallback,
        # whose apiModel is the id the backend 404s on.
        ap = self._ap()
        body = {"model": "qwen36-35b-a3b-iq4xs", "messages": []}
        asyncio.run(ap._reconcile_wire_model(body))
        self.assertEqual(body["model"], "qwen3.8-27b")

    def test_an_id_the_backend_serves_is_left_ALONE(self):
        # A genuine multi-model gateway must keep working: only ids the upstream
        # does not list are touched.
        ap = self._ap(ids=("qwen3.8-27b", "some-other-model"))
        body = {"model": "some-other-model", "messages": []}
        asyncio.run(ap._reconcile_wire_model(body))
        self.assertEqual(body["model"], "some-other-model")

    def test_an_uninterrogable_backend_changes_nothing(self):
        ap = load_proxy()
        ap.http_client = _FakeClient(models_status=500, post_response=_FakeResponse(200, {}))
        body = {"model": "claude-sonnet-4-6", "messages": []}
        asyncio.run(ap._reconcile_wire_model(body))
        self.assertEqual(body["model"], "claude-sonnet-4-6")

    def test_the_model_list_is_fetched_once_not_per_request(self):
        ap = self._ap()
        for _ in range(5):
            asyncio.run(ap._reconcile_wire_model({"model": "claude-sonnet-4-6", "messages": []}))
        self.assertEqual(len(ap.http_client.gets), 1)


class StreamingLatchWiringTest(unittest.TestCase):
    """The latch must be wired into ALL upstream error handlers, not most.

    Streaming is the default client path and was the one handler of three that
    never latched, so the safety net had a hole exactly where the traffic is.
    Asserted structurally: counting call sites is crude, but it is the only
    check that fails when a fourth handler is added without the call.
    """

    def test_every_upstream_error_handler_latches(self):
        src = proxy_path.read_text(encoding="utf-8")
        handlers = src.count('logger.error("Upstream HTTP') + src.count('"Upstream HTTP %d (')
        latches = src.count("_note_ctk_rejection(error_text)")
        self.assertGreaterEqual(
            latches, 3, "an upstream error handler is missing _note_ctk_rejection"
        )
        self.assertGreaterEqual(latches, handlers - 1)


if __name__ == "__main__":
    unittest.main()
