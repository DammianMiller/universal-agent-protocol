#!/usr/bin/env python3
"""The thinking budget wall is a CAPABILITY-GATED REQUEST FIELD, not a flag.

A reasoning model can spend its ENTIRE max_tokens wall inside
reasoning_content and emit nothing (finish_reason=length, empty message —
strata live-observed 2026-11-23 15:35: "the reply reached max tokens while
still thinking"). Today's remedies are all SECOND requests: the Option-3
backstop retries with thinking OFF (reasoning lost) and the client re-requests
at a 4x wall (a full re-decode). H bounds reasoning per request instead:
thinking_budget_tokens = fraction x the request's own wall, so the model exits
thinking with room left to answer.

DEFAULT 0 (OFF), measured 2026-11-24 against basalt-fn (direct paired turns,
:8080 budget-honoring runs): the Infernix build implements the field as a
TOTAL completion cap shared by reasoning AND text (budget 1500 -> completion
exactly 1500; budget 2000 under an 8000 wall -> exactly 2000, both parts
truncated), NOT a thinking-only budget. The earlier "server-side 0.75 ratio"
observation (probe req#7: 3072 against a 4096 wall) was the same total-cap
semantics, misread as thinking-only. Injecting fraction x wall therefore
SHRINKS the caller's effective wall — a pessimization for answer completeness
— so the default is off and deployments opt in per server.

These tests pin the contract pieces:
  * the 400 detector (error-text keyed: names thinking_budget, status 400)
  * the budget application (thinking-on + wall + fraction -> the field)
  * the DEFAULT: 0 unless PROXY_THINKING_BUDGET_FRACTION opts in
  * the strip-and-latch (mutate, latch off process-wide, signal retry)
  * wiring: every request path (non-stream, stream, strict-stream) carries
    the strip handler, and the choke point applies the budget before the
    wire sanitizer — ahead of every retry-body copy
"""

import importlib.util
import inspect
import re
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()

BUDGET_400 = (
    "Invalid parameter for chat completions endpoint: "
    "thinking_budget_tokens is not supported by this engine "
    "(parameter=thinking_budget_tokens, value=12288)"
)
CONTEXT_OVERFLOW_400 = (
    "Error: prompt tokens 195000 exceeds context window of 131072"
)
GRAMMAR_400 = "Failed to initialize samplers: failed to parse grammar"
TOOL_CHOICE_400 = (
    'tool_choice "required" is not supported; use "auto" or "none"'
)


def thinking_on_body(wall):
    """The outbound OpenAI body shape on a thinking-ON turn."""
    return {
        "model": "qwen3.8-flash-next",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": wall,
        "enable_thinking": True,
        "chat_template_kwargs": {"enable_thinking": True},
    }


class ThinkingBudgetCapabilityTests(unittest.TestCase):
    def setUp(self):
        self._saved_supported = proxy.THINKING_BUDGET_SUPPORTED
        self._saved_fraction = proxy.PROXY_THINKING_BUDGET_FRACTION
        proxy.THINKING_BUDGET_SUPPORTED = True
        proxy.PROXY_THINKING_BUDGET_FRACTION = 0.75

    def tearDown(self):
        proxy.THINKING_BUDGET_SUPPORTED = self._saved_supported
        proxy.PROXY_THINKING_BUDGET_FRACTION = self._saved_fraction

    # -- detector -----------------------------------------------------------

    def test_detector_matches_the_infernix_style_refusal(self):
        self.assertTrue(proxy._is_thinking_budget_rejection(400, BUDGET_400))

    def test_detector_is_case_insensitive(self):
        self.assertTrue(
            proxy._is_thinking_budget_rejection(
                400, "THINKING_BUDGET_TOKENS: unsupported parameter"
            )
        )

    def test_detector_matches_the_alias_field_names(self):
        # The Infernix kNames set also accepts thinking_token_budget /
        # thinking_budget / reasoning_budget_tokens — a strict refusal can
        # name any of them; our field is the first, but the detector must
        # not miss a refusal that echoes an alias.
        for name in (
            "thinking_token_budget",
            "thinking_budget",
            "reasoning_budget_tokens",
        ):
            self.assertTrue(
                proxy._is_thinking_budget_rejection(
                    400, f"{name} is not supported by this engine"
                ),
                name,
            )

    def test_detector_rejects_disjoint_failures(self):
        for status, text in (
            (400, CONTEXT_OVERFLOW_400),
            (400, GRAMMAR_400),
            (400, TOOL_CHOICE_400),
            (500, BUDGET_400),   # right text, wrong code
            (200, BUDGET_400),
            (400, "unknown parameter: 'temperature2'"),
            (400, ""),
            (400, None),
        ):
            self.assertFalse(
                proxy._is_thinking_budget_rejection(status, text),
                (status, text),
            )

    # -- budget application -------------------------------------------------

    def test_applies_fraction_of_the_wall_on_thinking_turns(self):
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        self.assertEqual(body["thinking_budget_tokens"], 12288)

    def test_matches_the_infernix_probe_ratio(self):
        # The live tray probe derived budget 3072 from a 4096 wall; the proxy
        # sends the same ratio client-side.
        body = thinking_on_body(4096)
        proxy._apply_thinking_budget(body)
        self.assertEqual(body["thinking_budget_tokens"], 3072)

    def test_floors_rather_than_rounds_odd_walls(self):
        body = thinking_on_body(33)
        proxy._apply_thinking_budget(body)
        self.assertEqual(body["thinking_budget_tokens"], 24)  # int(24.75)

    def test_skips_thinking_off_turns(self):
        body = thinking_on_body(16384)
        body["enable_thinking"] = False
        body["chat_template_kwargs"] = {"enable_thinking": False}
        proxy._apply_thinking_budget(body)
        self.assertNotIn("thinking_budget_tokens", body)

    def test_skips_turns_without_a_wall(self):
        body = thinking_on_body(0)
        del body["max_tokens"]
        proxy._apply_thinking_budget(body)
        self.assertNotIn("thinking_budget_tokens", body)

    def test_never_overrides_a_caller_supplied_budget(self):
        body = thinking_on_body(16384)
        body["thinking_budget_tokens"] = 512
        proxy._apply_thinking_budget(body)
        self.assertEqual(body["thinking_budget_tokens"], 512)

    def test_fraction_zero_disables_the_field(self):
        proxy.PROXY_THINKING_BUDGET_FRACTION = 0.0
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        self.assertNotIn("thinking_budget_tokens", body)

    def test_default_is_off_unless_env_opts_in(self):
        # Measured 2026-11-24 (direct paired turns against basalt-fn): the
        # field acts as a TOTAL completion cap on the Infernix builds (not
        # thinking-only), so the shipped default is 0 and deployments opt
        # in per server. A FRESH import must reflect exactly that: env
        # unset -> 0.0; env set -> the operator's value.
        import os

        def fresh(env_value):
            saved = os.environ.pop("PROXY_THINKING_BUDGET_FRACTION", None)
            try:
                if env_value is not None:
                    os.environ["PROXY_THINKING_BUDGET_FRACTION"] = env_value
                spec = importlib.util.spec_from_file_location(
                    "anthropic_proxy_fresh", proxy.__file__
                )
                m = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(m)
                return m.PROXY_THINKING_BUDGET_FRACTION
            finally:
                os.environ.pop("PROXY_THINKING_BUDGET_FRACTION", None)
                if saved is not None:
                    os.environ["PROXY_THINKING_BUDGET_FRACTION"] = saved

        self.assertEqual(fresh(None), 0.0)
        self.assertEqual(fresh("0.5"), 0.5)

    def test_latch_off_degrades_before_the_wire(self):
        proxy.THINKING_BUDGET_SUPPORTED = False
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        self.assertNotIn("thinking_budget_tokens", body)

    def test_reads_the_ctk_form_for_thinking_state(self):
        # _thinking_enabled_on_body reads chat_template_kwargs first; a body
        # that expresses thinking ONLY through ctk still gets the budget.
        body = thinking_on_body(8192)
        del body["enable_thinking"]
        proxy._apply_thinking_budget(body)
        self.assertEqual(body["thinking_budget_tokens"], 6144)

    # -- strip-and-latch ----------------------------------------------------

    def test_strip_mutates_latches_and_signals_retry(self):
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        retry = proxy._maybe_strip_unsupported_thinking_budget(
            body, 400, BUDGET_400, "non-stream"
        )
        self.assertTrue(retry)
        self.assertNotIn("thinking_budget_tokens", body)
        self.assertFalse(proxy.THINKING_BUDGET_SUPPORTED)  # latched off

    def test_strip_is_a_noop_when_the_body_has_no_budget(self):
        body = thinking_on_body(16384)  # budget never applied
        retry = proxy._maybe_strip_unsupported_thinking_budget(
            body, 400, BUDGET_400, "stream"
        )
        self.assertFalse(retry)
        self.assertNotIn("thinking_budget_tokens", body)

    def test_strip_leaves_unrelated_failures_alone(self):
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        for status, text in ((400, CONTEXT_OVERFLOW_400), (500, BUDGET_400)):
            body2 = dict(body)
            retry = proxy._maybe_strip_unsupported_thinking_budget(
                body2, status, text, "strict-stream"
            )
            self.assertFalse(retry, (status, text))
            self.assertIn("thinking_budget_tokens", body2)

    def test_latched_process_never_applies_the_budget_again(self):
        # The full degrade-then-apply cycle: after the latch flips, a fresh
        # thinking-on turn must not carry the field.
        body = thinking_on_body(16384)
        proxy._apply_thinking_budget(body)
        proxy._maybe_strip_unsupported_thinking_budget(
            body, 400, BUDGET_400, "stream"
        )
        fresh = thinking_on_body(8192)
        proxy._apply_thinking_budget(fresh)
        self.assertNotIn("thinking_budget_tokens", fresh)


class RequestPathWiringTests(unittest.TestCase):
    """The 2026-11-17 breakage class, applied to H: a handler added to some
    of the request paths and not others. The budget flows into every path's
    body at the shared choke point, so EVERY path's 400 handler must carry
    the strip — asserted on the proxy source so a future path addition that
    forgets the handler fails here instead of live on a thinking-intent turn.
    """

    @classmethod
    def setUpClass(cls):
        src_path = Path(proxy.__file__)
        cls.source = src_path.read_text(encoding="utf-8")
        cls.apply_src = inspect.getsource(proxy._apply_thinking_budget)

    def _call_sites(self, helper):
        return re.findall(
            rf"{re.escape(helper)}\(\s*([^)]*)\)", self.source
        )

    def test_every_path_carries_the_budget_strip(self):
        sites = self._call_sites("_maybe_strip_unsupported_thinking_budget")
        # def signature + one call per request path
        self.assertGreaterEqual(len(sites), 4)
        for tag in ("non-stream", "stream", "strict-stream"):
            self.assertTrue(
                any(f'"{tag}"' in s for s in sites),
                f"no budget-strip call site tagged {tag}",
            )

    def test_choke_point_applies_the_budget_before_the_wire_sanitizer(self):
        # The single application site must precede _sanitize_tool_names_
        # for_upstream so every downstream retry-body copy inherits it.
        apply_pos = self.source.index("_apply_thinking_budget(openai_body)")
        sanitize_pos = self.source.index(
            "_sanitize_tool_names_for_upstream(openai_body)"
        )
        self.assertLess(apply_pos, sanitize_pos)

    def test_application_is_idempotent_by_source(self):
        # def signature + the single choke-point call; per-path re-application
        # would double-set after a retry copy already carries the field.
        sites = self._call_sites("_apply_thinking_budget")
        self.assertEqual(len(sites), 2)

    def test_option3_backstop_remains_armed(self):
        # The thinking-OFF retry stays for arms that ignore the budget field;
        # H prevents the common case, it does not replace the backstop.
        self.assertIn("_apply_empty_maxtokens_recovery", self.source)
        self.assertIn("PROXY_EMPTY_MAXTOKENS_RECOVER", self.source)


if __name__ == "__main__":
    unittest.main()
