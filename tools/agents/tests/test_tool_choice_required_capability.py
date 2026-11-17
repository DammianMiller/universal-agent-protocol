#!/usr/bin/env python3
"""tool_choice='required' is a CAPABILITY, not a constant.

The steering force sets tool_choice='required' so a model must emit the tool
call its prompt demands. Engines that never implemented the field reject the
whole request:
    HTTP 400  tool_choice "required" is not supported; use "auto" or "none"
(yasakani arm, live-observed 2026-11-14). Three failure handlers existed for
grammar/tool incompatibilities, but this one only latched on two of the three
request paths — the third re-sent the rejected field on EVERY forced turn for
the life of the process.

These tests pin the contract pieces:
  * the 400 detector (error-text keyed, not arm-registry keyed)
  * the relax-and-latch (mutate to 'auto', latch off process-wide, retry once)
  * the choke point (_force_tool_choice_required) degrading to 'auto'
  * wiring: every request path (non-stream, stream, strict-stream) carries
    both the tool_choice relax and the served-ids 404 refresh
"""

import importlib.util
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()

YASAKANI_400 = 'tool_choice "required" is not supported; use "auto" or "none"'
PEG_500 = "Failed to parse input at pos 42: <|tool_call>call:{bad"
# Live 2026-11-17, qwen-warp (swift-mk) arm on :8080: the engine's vLLM-derived
# layer maps forced tool_choice='required' onto an internal structured_outputs
# flag that its own mk-core allowlist then rejects — with no 'tool_choice' in
# the text. 13 of 16 forced turns failed this way, each surfacing to the client
# as a retryable-looking 529 because the relax latch never fired.
SWIFTMK_400 = (
    "swift-mk engine does not support structured_outputs (supported sampling: "
    "temperature, top_p, top_k <= 64, min_p, presence_penalty) "
    "(parameter=structured_outputs, value=set)"
)


class ToolChoiceRequiredCapabilityTests(unittest.TestCase):
    def setUp(self):
        self._saved_supported = proxy.TOOL_CHOICE_REQUIRED_SUPPORTED
        proxy.TOOL_CHOICE_REQUIRED_SUPPORTED = True

    def tearDown(self):
        proxy.TOOL_CHOICE_REQUIRED_SUPPORTED = self._saved_supported

    # -- detector -----------------------------------------------------------

    def test_detector_matches_the_yasakani_400_shape(self):
        self.assertTrue(
            proxy._is_tool_choice_required_unsupported(400, YASAKANI_400)
        )

    def test_detector_matches_a_function_pin_refusal(self):
        # A pinned function is stricter than 'required' and draws the same
        # engine-level refusal naming the field.
        self.assertTrue(
            proxy._is_tool_choice_required_unsupported(
                400, 'tool_choice: {"type":"function"} is not supported'
            )
        )

    def test_detector_matches_the_swiftmk_structured_outputs_400_shape(self):
        # The refusal arrives one step removed: no 'tool_choice' anywhere in
        # the text, only the engine rejecting the structured_outputs flag its
        # own layer derived FROM the forced choice.
        self.assertTrue(
            proxy._is_tool_choice_required_unsupported(400, SWIFTMK_400)
        )

    def test_detector_matches_a_paraphrased_structured_outputs_refusal(self):
        # Text-keyed, not literal: other wordings of the same refusal count.
        self.assertTrue(
            proxy._is_tool_choice_required_unsupported(
                400, "unsupported parameter: 'structured_outputs' for this engine"
            )
        )

    def test_detector_is_case_insensitive_and_text_keyed(self):
        self.assertTrue(
            proxy._is_tool_choice_required_unsupported(
                400, "TOOL_CHOICE 'required' NOT SUPPORTED by engine"
            )
        )

    def test_detector_rejects_disjoint_failures(self):
        # Grammar failures carry 'failed to parse grammar', never 'not
        # supported' + 'tool_choice'; other status codes never match.
        for status, text in (
            (400, "failed to parse grammar: tool schema"),  # gemma4 compile
            (500, PEG_500),                                  # gemma4 runtime
            (400, "custom grammar constraints with tools"),  # grammar+tools
            (400, "unknown parameter: 'tool_choice2'"),       # different field
            (400, "tool_choice is not a valid choice"),      # no 'not supported'
            (500, YASAKANI_400),                             # right text, wrong code
            (200, YASAKANI_400),
            (400, ""),
            (400, None),
            # structured_outputs MENTIONED without being refused is not a
            # capability signal (e.g. an informational notice).
            (400, "structured_outputs enabled for guided decoding"),
            (500, SWIFTMK_400),  # right text, wrong code
        ):
            self.assertFalse(
                proxy._is_tool_choice_required_unsupported(status, text),
                (status, text),
            )

    # -- relax-and-latch ----------------------------------------------------

    def test_relax_mutates_latches_and_signals_retry(self):
        body = {"model": "m", "tools": [{}], "tool_choice": "required"}
        retry = proxy._maybe_relax_unsupported_tool_choice(
            body, 400, YASAKANI_400, "non-stream"
        )
        self.assertTrue(retry)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertFalse(proxy.TOOL_CHOICE_REQUIRED_SUPPORTED)  # latched off

    def test_relax_latches_off_on_the_swiftmk_structured_outputs_400(self):
        # The live warp-arm sequence: forced turn -> engine 400 on
        # structured_outputs -> relax this turn to 'auto', latch the
        # capability off so every later force degrades BEFORE it is sent.
        body = {"model": "m", "tools": [{}], "tool_choice": "required"}
        retry = proxy._maybe_relax_unsupported_tool_choice(
            body, 400, SWIFTMK_400, "guarded non-stream"
        )
        self.assertTrue(retry)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertFalse(proxy.TOOL_CHOICE_REQUIRED_SUPPORTED)  # latched off

    def test_relax_ignores_structured_outputs_when_the_choice_is_not_forced(self):
        # A structured_outputs failure on an already-auto body is NOT a
        # forced-tool-use capability signal (e.g. a client-sent param the
        # engine rejects): no relax, no latch — the error surfaces as-is.
        body = {"tools": [{}], "tool_choice": "auto"}
        self.assertFalse(
            proxy._maybe_relax_unsupported_tool_choice(
                body, 400, SWIFTMK_400, "stream"
            )
        )
        self.assertEqual(body["tool_choice"], "auto")
        self.assertTrue(proxy.TOOL_CHOICE_REQUIRED_SUPPORTED)  # untouched

    def test_relax_also_handles_the_object_choice_shapes(self):
        # {"type": "any"} (Anthropic any) and a pinned function both relax.
        for choice in ({"type": "any"}, {"type": "function", "function": {}}):
            body = {"tools": [{}], "tool_choice": choice}
            self.assertTrue(
                proxy._maybe_relax_unsupported_tool_choice(
                    body, 400, YASAKANI_400, "stream"
                ),
                choice,
            )
            self.assertEqual(body["tool_choice"], "auto")

    def test_relax_is_idempotent_when_already_latched(self):
        proxy.TOOL_CHOICE_REQUIRED_SUPPORTED = False  # latched earlier
        body = {"tools": [{}], "tool_choice": "required"}
        self.assertTrue(
            proxy._maybe_relax_unsupported_tool_choice(
                body, 400, YASAKANI_400, "stream"
            )
        )
        self.assertEqual(body["tool_choice"], "auto")
        self.assertFalse(proxy.TOOL_CHOICE_REQUIRED_SUPPORTED)  # stays off

    def test_relax_leaves_unforced_and_unrelated_bodies_alone(self):
        for choice in ("auto", "none", None):
            body = {"tools": [{}]}
            if choice is not None:
                body["tool_choice"] = choice
            before = dict(body)
            self.assertFalse(
                proxy._maybe_relax_unsupported_tool_choice(
                    body, 400, YASAKANI_400, "stream"
                ),
                choice,
            )
            self.assertEqual(body, before)  # untouched, not even 'auto' re-set
        # A non-matching error must not mutate or latch anything.
        body = {"tool_choice": "required"}
        self.assertFalse(
            proxy._maybe_relax_unsupported_tool_choice(body, 500, PEG_500, "s")
        )
        self.assertEqual(body["tool_choice"], "required")
        self.assertTrue(proxy.TOOL_CHOICE_REQUIRED_SUPPORTED)  # untouched

    # -- choke point ----------------------------------------------------------

    def test_choke_point_forces_required_while_supported(self):
        body = {}
        applied = proxy._force_tool_choice_required(body)
        self.assertEqual(applied, "required")
        self.assertEqual(body["tool_choice"], "required")

    def test_choke_point_degrades_to_auto_once_latched_off(self):
        proxy.TOOL_CHOICE_REQUIRED_SUPPORTED = False
        body = {}
        applied = proxy._force_tool_choice_required(body)
        self.assertEqual(applied, "auto")
        self.assertEqual(body["tool_choice"], "auto")

    def test_latch_flows_from_relax_to_choke_point(self):
        # The whole loop: force -> upstream refuses -> relax latches -> the
        # NEXT forced turn degrades before it is ever sent.
        body = {"tool_choice": "required"}
        self.assertTrue(
            proxy._maybe_relax_unsupported_tool_choice(
                body, 400, YASAKANI_400, "strict-stream"
            )
        )
        fresh = {}
        self.assertEqual(proxy._force_tool_choice_required(fresh), "auto")

    # -- disjointness from the Gemma 4 PEG retry -------------------------------

    def test_gemma4_peg_relax_and_capability_relax_are_disjoint(self):
        # The PEG failure (HTTP 500 parse / HTTP 400 grammar-compile) takes
        # the gemma4 retry; the capability refusal (HTTP 400 not-supported)
        # takes this one. Neither triggers the other's remedy.
        self.assertTrue(proxy._is_gemma4_peg_parse_failure(500, PEG_500))
        peg_body = {"tools": [{}], "tool_choice": "required"}
        self.assertTrue(
            proxy._relax_tool_choice_for_gemma4_peg_retry(peg_body, "stream")
        )
        self.assertEqual(peg_body["tool_choice"], "auto")
        cap_body = {"tools": [{}], "tool_choice": "required"}
        self.assertTrue(
            proxy._maybe_relax_unsupported_tool_choice(
                cap_body, 400, YASAKANI_400, "stream"
            )
        )
        # And each detector rejects the other's trigger:
        self.assertFalse(
            proxy._is_gemma4_peg_parse_failure(400, YASAKANI_400)
        )
        self.assertFalse(
            proxy._is_tool_choice_required_unsupported(500, PEG_500)
        )


class RequestPathWiringTests(unittest.TestCase):
    """The 2026-11-17 breakage class: a handler added to two of three paths.

    All three request paths (non-stream, stream, strict-stream) must carry
    BOTH recovery helpers — the tool_choice capability relax and the served-
    ids 404 refresh — and the context-window recheck must consult /health
    when /slots yields nothing. Asserted on the proxy source so a future
    path addition that forgets one of the handlers fails here, at unit
    level, instead of live on a thinking-intent turn.
    """

    @classmethod
    def setUpClass(cls):
        src_path = Path(proxy.__file__)
        cls.source = src_path.read_text(encoding="utf-8")
        # _maybe_recheck_context_window's own source (module-level def).
        import inspect
        cls.recheck_src = inspect.getsource(proxy._maybe_recheck_context_window)

    def _call_sites(self, helper):
        """Arg-lists of every call to *helper* (the call args here contain no
        nested parens, so `[^)]*` spans the multi-line call exactly)."""
        import re
        return re.findall(rf"{re.escape(helper)}\(\s*([^)]*)\)", self.source)

    def test_every_path_carries_the_tool_choice_relax(self):
        sites = self._call_sites("_maybe_relax_unsupported_tool_choice")
        # def signature + one call per request path
        self.assertGreaterEqual(len(sites), 4)
        for tag in ("non-stream", "stream", "strict-stream"):
            self.assertTrue(
                any(f'"{tag}"' in s for s in sites),
                f"no relax call site tagged {tag}",
            )

    def test_every_path_carries_the_served_ids_404_refresh(self):
        sites = self._call_sites("_maybe_refresh_served_ids_on_404")
        self.assertGreaterEqual(len(sites), 4)  # def signature + 3 paths
        for tag in ("non-stream", "stream", "strict-stream"):
            self.assertTrue(
                any(f'"{tag}"' in s for s in sites),
                f"no 404-refresh call site tagged {tag}",
            )

    def test_context_recheck_falls_back_to_health_endpoint(self):
        # /slots is llama.cpp-only; engines answering a plain-200 /health
        # (n_ctx or max_context) must still get their real window measured.
        self.assertIn("/health", self.recheck_src)
        self.assertIn("max_context", self.recheck_src)
        self.assertIn("n_ctx", self.recheck_src)


if __name__ == "__main__":
    unittest.main()
