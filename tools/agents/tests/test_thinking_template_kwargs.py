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
import importlib.util
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
    for k in ("PROXY_DISABLE_THINKING_ALWAYS", "PROXY_DISABLE_THINKING_ON_TOOL_TURNS"):
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


if __name__ == "__main__":
    unittest.main()
