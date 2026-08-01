#!/usr/bin/env python3
"""Retrying a TRUNCATED write must not ask for less room than already failed.

Measured on the Octopus Invaders build (2026-08-01): a 36KB game.js came back
cut off mid-file and every retry re-truncated.

The first diagnosis of this was wrong and is worth recording, because the wrong
version is the intuitive one:

  - The `max_tokens=4096` visible in the proxy's REQ: log is NOT the value sent
    upstream. It is logged on the converted body, BEFORE
    `_resolve_max_tokens_request` applies PROXY_MAX_TOKENS_FLOOR — which
    returns max(requested, floor) and so raises it. With the deployed
    FLOOR=32768 the default was never binding.
  - A truncated write is reclassified to `truncated_tool_args` and therefore
    never sets `last_response_garbled`, so PROXY_TOOL_TURN_MAX_TOKENS_GARBLED
    does not govern its retry either.
  - The actual clamp is PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS (8192 deployed),
    applied via min() on the retry — i.e. the retry of a file that was cut off
    for lack of room was given LESS room than the attempt that failed.

So these tests pin the retry-budget branching, which is where the bug was, and
the ordering properties of the ceiling chain. They deliberately do not assert
absolute token literals: the deployed EnvironmentFile overrides most of these
constants, so a test on a code default would pass while production disagreed.
"""

import importlib.util
import os
import unittest
from pathlib import Path


def _load_proxy(env=None):
    prev = {}
    env = dict(env or {})
    env.setdefault("UAP_PROXY_ENV_AUTOLOAD", "0")
    for k, v in env.items():
        prev[k] = os.environ.get(k)
        os.environ[k] = v
    try:
        path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
        spec = importlib.util.spec_from_file_location("anthropic_proxy_ceilings", path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    finally:
        for k, v in prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


proxy = _load_proxy({"PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS": "8192"})

BIG = 32768  # the budget a whole-module write actually runs with


def _retry(**kw):
    body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": BIG}
    return proxy._build_malformed_retry_body(body, {"tools": []}, **kw)["max_tokens"]


class TruncatedRetryBudgetTest(unittest.TestCase):
    def test_truncated_retry_keeps_the_budget_that_was_cut_off(self):
        # The whole bug: clamping here guarantees the retry truncates too.
        self.assertEqual(_retry(is_truncated=True), BIG)

    def test_garbled_retry_still_tightens(self):
        # Genuine malformed args SHOULD get less room — that guard is intact.
        self.assertEqual(
            _retry(is_garbled=True), proxy.PROXY_TOOL_TURN_MAX_TOKENS_GARBLED
        )

    def test_plain_malformed_retry_still_clamps(self):
        self.assertEqual(_retry(), proxy.PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS)

    def test_truncation_wins_over_the_generic_clamp_but_not_over_garbled(self):
        # Ordering matters: garbled is checked first by design, since args that
        # are both malformed AND long are a degeneration risk, not a big file.
        self.assertEqual(
            _retry(is_garbled=True, is_truncated=True),
            proxy.PROXY_TOOL_TURN_MAX_TOKENS_GARBLED,
        )


class TruncationSignalIsWiredTest(unittest.TestCase):
    """The helper is only correct if the call site actually tells it.

    Asserting the branch through the real call site would mean standing up the
    whole async malformed-retry handler with a mocked upstream; the cheaper and
    still-effective guard is that the kwarg is derived from the issue kind
    rather than hardcoded. Without this, deleting the derivation leaves every
    other test in this file green while the bug returns — which is exactly what
    mutation testing showed.
    """

    SRC = (
        Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    ).read_text()

    def test_call_site_derives_is_truncated_from_the_issue_kind(self):
        self.assertIn(
            'is_truncated=current_issue.kind == "truncated_tool_args"',
            self.SRC,
            "the retry no longer learns that the previous attempt was truncated",
        )

    def test_the_kind_it_keys_on_is_the_one_the_classifier_produces(self):
        # Guards a rename on one side only.
        self.assertIn('kind="truncated_tool_args"', self.SRC)


class CeilingChainOrderingTest(unittest.TestCase):
    def test_floor_raises_a_small_request_rather_than_capping_it(self):
        # This is what made the 4096 default a red herring.
        m = _load_proxy({"PROXY_MAX_TOKENS_FLOOR": "32768"})
        self.assertEqual(m._resolve_max_tokens_request(4096), 32768)

    def test_a_zero_floor_leaves_the_request_alone(self):
        m = _load_proxy({"PROXY_MAX_TOKENS_FLOOR": "0"})
        self.assertEqual(m._resolve_max_tokens_request(4096), 4096)

    def test_garbled_cap_is_a_tightening_of_the_tool_turn_cap(self):
        self.assertLessEqual(
            proxy.PROXY_TOOL_TURN_MAX_TOKENS_GARBLED, proxy.PROXY_TOOL_TURN_MAX_TOKENS
        )

    def test_default_is_overridable_and_replaces_the_hardcoded_fallback(self):
        m = _load_proxy({"PROXY_DEFAULT_MAX_TOKENS": "12345"})
        out = m.openai_to_anthropic_request(
            {"model": "m", "messages": [{"role": "user", "content": "hi"}]}
        )
        self.assertEqual(out["max_tokens"], 12345)

    def test_an_explicit_client_value_survives_the_conversion(self):
        # NB: only the conversion. build_openai_request may still raise it via
        # the thinking floor — asserted here at the conversion layer only.
        out = proxy.openai_to_anthropic_request(
            {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 512}
        )
        self.assertEqual(out["max_tokens"], 512)

    def test_zero_or_null_means_no_opinion_not_emit_nothing(self):
        for val in (0, None):
            with self.subTest(val=val):
                out = proxy.openai_to_anthropic_request(
                    {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": val}
                )
                self.assertEqual(out["max_tokens"], proxy.PROXY_DEFAULT_MAX_TOKENS)


if __name__ == "__main__":
    unittest.main()
