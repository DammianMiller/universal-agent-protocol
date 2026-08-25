#!/usr/bin/env python3
"""STUCK-BREAK hard tier.

The advisory STUCK-BREAK (directive + tool_choice released to 'auto') leaves
every tool on the table, and a weak local model just issues the same call
again: observed live 2026-08-23 16:46-17:45, the identical bash call 13+ turns
in a row with fires=33 and never a prose reply. After
PROXY_STUCK_BREAK_HARD_FIRES fires the break must be HARD -- tools removed for
that turn, XML tool-call resurrection suppressed -- so the turn can only end in
prose and the client's agent loop actually terminates.
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

# Angle brackets built at runtime; see _markup below for why.
LT = chr(60)
GT = chr(62)


def _looping_monitor(fires_so_far: int):
    mon = proxy.SessionMonitor()
    mon.self_stuck_streak = proxy.PROXY_STUCK_TEXT_THRESHOLD + 1
    mon.stuck_break_fires = fires_so_far
    return mon


def _body():
    return {
        "tool_choice": "required",
        "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}],
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "go"}],
    }


class TestStuckBreakHard(unittest.TestCase):
    def test_below_hard_threshold_stays_advisory(self):
        mon = _looping_monitor(fires_so_far=0)
        body = _body()
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(mon.stuck_break_fires, 1)
        self.assertIn("tools", body, "advisory tier keeps the tools")
        self.assertEqual(body["tool_choice"], "auto")
        self.assertFalse(mon.suppress_text_tool_extraction)
        self.assertIn("STOP", body["messages"][0]["content"])

    def test_hard_threshold_strips_tools_and_suppresses_xml_resurrection(self):
        mon = _looping_monitor(fires_so_far=proxy.PROXY_STUCK_BREAK_HARD_FIRES - 1)
        body = _body()
        proxy._maybe_inject_stuck_break(body, mon)
        self.assertEqual(mon.stuck_break_fires, proxy.PROXY_STUCK_BREAK_HARD_FIRES)
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertTrue(mon.suppress_text_tool_extraction)
        self.assertIn("plain text", body["messages"][0]["content"])
        self.assertIn("STOP", body["messages"][0]["content"])  # the advisory text still travels

    def test_hard_tier_can_be_disabled(self):
        saved = proxy.PROXY_STUCK_BREAK_HARD_FIRES
        try:
            proxy.PROXY_STUCK_BREAK_HARD_FIRES = 0
            mon = _looping_monitor(fires_so_far=50)
            body = _body()
            proxy._maybe_inject_stuck_break(body, mon)
            self.assertIn("tools", body)
            self.assertFalse(mon.suppress_text_tool_extraction)
        finally:
            proxy.PROXY_STUCK_BREAK_HARD_FIRES = saved

    def test_default_threshold_is_small(self):
        # Three ignored breaks is already ~8 minutes of identical calls on the
        # local executor; the default must not let a loop run for an hour.
        self.assertGreater(proxy.PROXY_STUCK_BREAK_HARD_FIRES, 0)
        self.assertLessEqual(proxy.PROXY_STUCK_BREAK_HARD_FIRES, 5)


class TestSuppressedTurnEndsInProse(unittest.TestCase):
    """The response half of the hard break.

    Suppressing XML resurrection stops the loop re-arming, but on its own it
    ships the raw markup to the client as the assistant's visible text.
    Measured live 2026-08-25 (opencode ses_fc7a27ea...): the client rendered a
    <tool_call> block as the reply, logged "exiting loop", and the operator
    retyped "go" straight back into the same loop. A turn forced to end in
    prose must actually end in prose.
    """

    @staticmethod
    def _markup(envelope=True, closed=True, lead=""):
        # Built from chr() so the literal tags never appear in this file --
        # the repo's bash-safety enforcer refuses commands carrying standalone
        # tool-call tag lines, which makes a literal fixture unrunnable.
        def tag(name):
            return LT + name + GT
        parts = [tag("function=bash"), tag("parameter=command"), "grep -rn X ."]
        if closed:
            parts += [tag("/parameter"), tag("/function")]
        if envelope:
            parts = [tag("tool_call")] + parts + [tag("/tool_call")]
        return (lead + "\n" + "\n".join(parts)) if lead else "\n".join(parts)

    @staticmethod
    def _resp(text):
        return {
            "choices": [
                {"finish_reason": "stop", "message": {"role": "assistant", "content": text}}
            ]
        }

    def test_enveloped_markup_never_reaches_the_client(self):
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup()), suppress=True
        )
        content = out["choices"][0]["message"]["content"]
        self.assertNotIn(LT + "tool_call" + GT, content)
        self.assertNotIn(LT + "function=", content)
        self.assertIsNone(out["choices"][0]["message"].get("tool_calls"))

    def test_bare_hermes_block_is_stripped_too(self):
        # _strip_residual_tool_call_xml only knows the envelope; a bare
        # function block walked straight through it.
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup(envelope=False)), suppress=True
        )
        self.assertNotIn(LT + "function=", out["choices"][0]["message"]["content"])

    def test_unclosed_block_is_stripped_too(self):
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup(envelope=False, closed=False)), suppress=True
        )
        content = out["choices"][0]["message"]["content"]
        self.assertNotIn(LT + "function=", content)
        self.assertNotIn(LT + "parameter=", content)

    def test_markup_only_reply_gets_fallback_prose(self):
        # An empty assistant message is no better than XML: the client ends the
        # turn either way and the operator sees a blank reply.
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup()), suppress=True
        )
        self.assertEqual(
            out["choices"][0]["message"]["content"], proxy.STUCK_BREAK_PROSE_FALLBACK
        )

    def test_the_model_own_prose_is_kept_when_it_wrote_any(self):
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup(lead="I will check the DB.")), suppress=True
        )
        self.assertEqual(out["choices"][0]["message"]["content"], "I will check the DB.")

    def test_plain_prose_passes_through_untouched(self):
        # Whitespace and blank lines included: the sanitiser collapses those, so
        # a fixture without them is a fixed point and would pass even if the
        # early exit were deleted.
        text = "\n  The cleanup at line 725 takes\n\n\n  the lock in the wrong order.  \n"
        out = proxy._maybe_extract_text_tool_calls(self._resp(text), suppress=True)
        self.assertEqual(out["choices"][0]["message"]["content"], text)

    def test_suppression_still_refuses_to_resurrect_the_call(self):
        # The original guarantee must survive the sanitiser.
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup()), suppress=True
        )
        self.assertIsNone(out["choices"][0]["message"].get("tool_calls"))
        self.assertEqual(out["choices"][0]["finish_reason"], "stop")

    def test_unsuppressed_turns_still_promote_the_call(self):
        # The sanitiser must not leak onto the normal path, where recovering a
        # prose tool call is the whole point.
        out = proxy._maybe_extract_text_tool_calls(
            self._resp(self._markup()), suppress=False
        )
        calls = out["choices"][0]["message"].get("tool_calls") or []
        self.assertEqual([c["function"]["name"] for c in calls], ["bash"])
        self.assertEqual(out["choices"][0]["finish_reason"], "tool_calls")

    def test_end_to_end_the_anthropic_response_is_a_prose_end_turn(self):
        # BARE hermes, not the enveloped form: the pre-existing
        # _strip_residual_tool_call_xml already deleted a whole <tool_call>
        # envelope downstream, so the enveloped fixture passed on the OLD code
        # too -- with an EMPTY text block, the very outcome this rail rejects.
        resp = self._resp(self._markup(envelope=False))
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        out = proxy.openai_to_anthropic_response(
            resp, "qwen", suppress_text_tool_extraction=True
        )
        self.assertEqual(out["stop_reason"], "end_turn")
        blocks = out.get("content") or []
        self.assertTrue(blocks, "a suppressed turn must still carry a text block")
        self.assertTrue(all(b.get("type") == "text" for b in blocks))
        joined = "".join(b.get("text") or "" for b in blocks)
        # An empty reply is as useless to the client as the markup was.
        self.assertTrue(joined.strip(), "the turn must end in ACTUAL prose")
        self.assertNotIn(LT + "function=", joined)
        self.assertNotIn(LT + "tool_call" + GT, joined)


if __name__ == "__main__":
    unittest.main()

class TestSuppressedMarkupLeakClasses(unittest.TestCase):
    """Every markup shape that reached a client, and every prose shape that must not be eaten.

    The sanitiser deletes text, so its failure modes run both ways: markup left
    behind is the original bug, and prose destroyed is a new one. Both are
    pinned here.
    """

    @staticmethod
    def _clean(text):
        return proxy._strip_all_tool_call_markup(text)

    @staticmethod
    def _tag(name):
        return LT + name + GT

    def _block(self, name="bash", closed=True, param=True):
        parts = [self._tag(f"function={name}")]
        if param:
            parts += [self._tag("parameter=command"), "grep X ."]
            if closed:
                parts.append(self._tag("/parameter"))
        else:
            parts.append("body")
        if closed:
            parts.append(self._tag("/function"))
        return "".join(parts)

    # --- markup that must go ---

    def test_strips_a_dotted_or_hyphenated_tool_name(self):
        # The PARSER's name class is [A-Za-z_][A-Za-z0-9_]*, so it ignored these
        # -- and the old stripper reused it, leaving a half-eaten block behind.
        for name in ("web.search", "read-file", "2fa_check"):
            with self.subTest(name=name):
                self.assertEqual(self._clean(self._block(name)), "")

    def test_strips_an_unclosed_block_that_carries_a_parameter(self):
        self.assertEqual(self._clean(self._block(closed=False)), "")

    def test_strips_an_orphan_closing_tag(self):
        self.assertEqual(self._clean("All done." + self._tag("/function")), "All done.")
        self.assertEqual(self._clean("Done." + self._tag("/tool_call")), "Done.")
        self.assertEqual(self._clean("Done." + self._tag("/parameter")), "Done.")

    def test_strips_an_unclosed_gemma_dsl_call(self):
        # The Gemma parsing regex has no premature-EOS arm, so a truncated call
        # passed through whole.
        dsl = LT + "|tool_call" + GT + "call: bash {c:1}"
        self.assertEqual(self._clean("Done.\n" + dsl), "Done.")

    # --- prose that must survive ---

    def test_prose_that_merely_mentions_a_tag_keeps_its_sentence(self):
        # The hard-tier directive asks the model what the repeated call
        # returned, i.e. it invites naming the call. A \Z-anchored delete turned
        # that into "The proxy scans for".
        text = (
            "The proxy scans for "
            + self._tag("function=bash")
            + " and then deletes the rest. THIS SHOULD SURVIVE."
        )
        out = self._clean(text)
        self.assertIn("THIS SHOULD SURVIVE.", out)
        self.assertIn("The proxy scans for", out)

    def test_prose_between_two_blocks_survives(self):
        text = (
            "Alpha.\n"
            + self._block("b")
            + "\nBETWEEN-PROSE\n"
            + self._block("d")
            + "\nOmega."
        )
        out = self._clean(text)
        self.assertIn("BETWEEN-PROSE", out)
        self.assertIn("Alpha.", out)
        self.assertIn("Omega.", out)

    def test_a_malformed_block_does_not_swallow_the_next_blocks_prose(self):
        # One unclosed opener used to match through the NEXT block's </function>.
        text = (
            "Alpha.\n"
            + self._tag("function=bash")
            + "X\nIMPORTANT PROSE\n"
            + self._block("read")
            + "\nOmega."
        )
        out = self._clean(text)
        self.assertIn("IMPORTANT PROSE", out)
        self.assertNotIn(LT + "function=", out)

    def test_a_fenced_json_call_is_deliberately_left_alone(self):
        # The normal path schema-matches these; here they are indistinguishable
        # from a model quoting JSON, and destroying real output is worse.
        text = 'I will run it.\n\n```json\n{"name": "bash"}\n```'
        self.assertEqual(self._clean(text), text)


class TestSuppressedSanitiserReach(unittest.TestCase):
    """Fields and shapes the sanitiser has to reach, beyond choices[0].content."""

    @staticmethod
    def _markup():
        return (
            LT + "function=bash" + GT + LT + "parameter=command" + GT
            + "grep X ." + LT + "/parameter" + GT + LT + "/function" + GT
        )

    def test_scrubs_the_reasoning_sidecar_too(self):
        # With content empty, the EMPTY-OUTPUT GUARD promotes reasoning into the
        # VISIBLE text -- leaving it alone just relocates the leak.
        resp = {"choices": [{"message": {"role": "assistant", "content": "", "reasoning_content": self._markup()}}]}
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        self.assertNotIn(LT + "function=", resp["choices"][0]["message"]["reasoning_content"])

    def test_a_think_wrapped_call_still_yields_visible_prose(self):
        # "<think></think>" is truthy but renders blank. Emptiness has to be
        # judged on what survives thinking extraction.
        text = LT + "think" + GT + LT + "/think" + GT + self._markup()
        resp = {"choices": [{"message": {"role": "assistant", "content": text}}]}
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        _, visible = proxy._extract_thinking_block(resp["choices"][0]["message"]["content"])
        self.assertTrue(visible.strip(), "a think-only reply renders blank to the client")

    def test_scrubs_every_choice_not_just_the_first(self):
        resp = {"choices": [
            {"message": {"role": "assistant", "content": "fine"}},
            {"message": {"role": "assistant", "content": self._markup()}},
        ]}
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        self.assertNotIn(LT + "function=", resp["choices"][1]["message"]["content"])

    def test_leaves_a_message_that_has_real_tool_calls_alone(self):
        # Rewriting the text beside a live tool call would attach an apology to
        # a turn that is actually doing work.
        mk = self._markup()
        resp = {"choices": [{"message": {"role": "assistant", "content": mk, "tool_calls": [{"id": "x"}]}}]}
        proxy._maybe_extract_text_tool_calls(resp, suppress=True)
        self.assertEqual(resp["choices"][0]["message"]["content"], mk)

    def test_survives_a_malformed_upstream_payload(self):
        # A degraded turn must not become a 500.
        for bad in ({"choices": [{"message": None}]}, {"choices": ["oops"]}, {"choices": []}, {}):
            with self.subTest(bad=bad):
                proxy._maybe_extract_text_tool_calls(dict(bad), suppress=True)


class TestSuppressedTurnIsBuffered(unittest.TestCase):
    """A tools-stripped turn must not be streamed.

    The sanitiser only runs on the buffered path -- a streamed turn is already
    on the wire before anything can inspect it. And the hard tier pops
    `tool_choice`, which is precisely the key _should_use_guarded_non_stream
    requires, so stripping the tools ALSO routed the turn away from the guarded
    path. That is why the request handler ORs the monitor flag in.
    """

    @staticmethod
    def _hard_tier_body():
        # What _maybe_inject_stuck_break leaves behind at the hard tier: no
        # tools, no tool_choice, no grammar.
        return {"messages": [{"role": "user", "content": "go"}]}

    @staticmethod
    def _monitor(suppress):
        mon = proxy.SessionMonitor()
        mon.suppress_text_tool_extraction = suppress
        return mon

    def test_a_suppressed_turn_is_always_buffered(self):
        # Regardless of stream flag, body shape, or any ambient proxy config:
        # the sanitiser only runs on the buffered path.
        for is_stream in (True, False):
            with self.subTest(is_stream=is_stream):
                self.assertTrue(
                    proxy._should_buffer_turn(
                        is_stream,
                        {"stream": is_stream},
                        self._hard_tier_body(),
                        self._monitor(True),
                    )
                )

    def test_an_ordinary_turn_defers_to_the_existing_check(self):
        # The new reason must ADD to the old rule, never replace it.
        body = self._hard_tier_body()
        mon = self._monitor(False)
        self.assertEqual(
            proxy._should_buffer_turn(True, {"stream": True}, body, mon),
            proxy._should_use_guarded_non_stream(True, {"stream": True}, body),
        )

    def test_suppression_overrides_a_declining_guarded_check(self):
        # Pin the actual defect: with the flag off this exact turn is NOT
        # buffered by the old rule alone, and with it on it is.
        body = {"stream": True}
        openai_body = self._hard_tier_body()
        if proxy._should_use_guarded_non_stream(True, body, openai_body):
            self.skipTest("ambient proxy config already forces buffering here")
        self.assertFalse(proxy._should_buffer_turn(True, body, openai_body, self._monitor(False)))
        self.assertTrue(proxy._should_buffer_turn(True, body, openai_body, self._monitor(True)))
