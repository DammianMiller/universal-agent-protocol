"""/v1/models must advertise the context window for locally-served models.

Regression (hermes, 2026-08-04): the endpoint returned bare {"id","object"}
rows. Hermes HAS a context compressor and probes for context_length /
context_window / max_context_length / max_model_len / n_ctx, found none, and its
model cache held no entry for our model — so the compressor never engaged. It
sent 470 messages / 219,957 tokens against a 130,048 window (169%) and the proxy
CRITICAL PRUNEd 290 of them; 61 such events in 18 hours. Raising the window from
86,784 to 130,048 had not helped, because the growth was never sized to the
window at all.

A client that cannot discover the window cannot size its history to it.
"""
import asyncio
import importlib.util
import os
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"


def load_proxy(window="130048", passthrough=None, measured=True):
    """Import a fresh proxy module under the given env (constants bind at import).

    `measured` mirrors what a real startup leaves behind: True once /slots (or
    an explicit setting) supplied the window, False when it is the hardcoded
    guess. /v1/models only publishes a measured window.
    """
    os.environ["PROXY_CONTEXT_WINDOW"] = window
    # Pin the forcing scale: `auto` is the default, but a developer shell or a
    # systemd unit exporting a fixed value would silently change what
    # _count_tokens_scale returns and fail these tests for unrelated reasons.
    os.environ["PROXY_COUNT_TOKENS_SCALE"] = "auto"
    if passthrough is None:
        os.environ.pop("ANTHROPIC_PASSTHROUGH_MODELS", None)
    else:
        os.environ["ANTHROPIC_PASSTHROUGH_MODELS"] = passthrough
    spec = importlib.util.spec_from_file_location("anthropic_proxy_ctx", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod._context_window_measured = measured
    return mod


class ModelsAdvertiseContextWindowTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("PROXY_CONTEXT_WINDOW", None)
        os.environ.pop("ANTHROPIC_PASSTHROUGH_MODELS", None)
        os.environ.pop("PROXY_COUNT_TOKENS_SCALE", None)

    def test_local_model_carries_the_window(self):
        ap = load_proxy()
        e = ap._model_entry("qwen36-35b-a3b-iq4xs")
        self.assertEqual(e["context_length"], 130048)

    def test_every_probed_key_is_emitted(self):
        # There is no standard key. Clients disagree, so emit the common
        # spellings — missing the one a client happens to read is the same
        # failure as advertising nothing.
        ap = load_proxy()
        e = ap._model_entry("qwen36-35b-a3b-iq4xs")
        for key in ("context_length", "context_window", "max_context_length",
                    "max_model_len", "n_ctx"):
            self.assertEqual(e.get(key), 130048, key)

    def test_passthrough_models_do_not_get_the_local_window(self):
        # A model that round-trips to api.anthropic.com has a much larger window.
        # Stamping the local llama.cpp figure on it would make clients truncate
        # needlessly — worse than the bug being fixed.
        ap = load_proxy(passthrough=None)  # default patterns: Claude passes through
        ap.default_context_window = 199680  # exercise the DETECTED arm, not the fallback
        for mid in ("claude-sonnet-4-6", "claude-haiku-4-5-20251001"):
            self.assertNotIn("context_length", ap._model_entry(mid), mid)

    def test_local_only_sentinel_means_every_id_is_local(self):
        ap = load_proxy(passthrough="__local_only__")
        ap.default_context_window = 199680
        for mid in ap.ADVERTISED_MODEL_IDS:
            self.assertEqual(ap._model_entry(mid).get("context_length"), 199680, mid)

    def test_unknown_window_advertises_nothing(self):
        # Better to say nothing than to assert a wrong number. "Unknown" means
        # BOTH: no setting and no detected rail.
        ap = load_proxy(window="0", measured=False)
        ap.default_context_window = 0
        self.assertEqual(
            ap._model_entry("qwen36-35b-a3b-iq4xs"), {"id": "qwen36-35b-a3b-iq4xs", "object": "model"}
        )

    def test_a_guessed_window_is_never_published_as_fact(self):
        # detect_context_window falls back to a hardcoded 131072 when the
        # upstream is unreachable. The pruner may use that as a backstop, but
        # advertising it would state a number nobody measured — the very
        # failure this endpoint exists to prevent. Boot with llama down.
        ap = load_proxy(window="0", measured=False)
        ap.default_context_window = 131072
        self.assertEqual(
            ap._model_entry("qwen36-35b-a3b-iq4xs"), {"id": "qwen36-35b-a3b-iq4xs", "object": "model"}
        )

    def test_advertises_the_detected_rail_when_no_pin_is_set(self):
        # Detection (from /slots) is the normal case: PROXY_CONTEXT_WINDOW=0 is
        # what tells the launcher to auto-detect. Advertising nothing there left
        # exactly the clients this endpoint exists for — the ones that size
        # themselves from it — back on their own defaults.
        ap = load_proxy(window="0")
        ap.default_context_window = 199680
        self.assertEqual(ap._model_entry("qwen36-35b-a3b-iq4xs")["context_length"], 199680)

    def test_detected_rail_wins_over_a_stale_pin(self):
        # THE BUG (live, 2026-08-16): the pin said 65,536 while the proxy
        # enforced the detected 199,680. Clients were told the small number and
        # compacted against it; the pruner guarded the large one. Whatever the
        # number is, the advertised and enforced windows must be the same one.
        ap = load_proxy(window="65536")
        ap.default_context_window = 199680
        self.assertEqual(ap._model_entry("qwen36-35b-a3b-iq4xs")["context_length"], 199680)
        self.assertEqual(ap._effective_context_window(), 199680)

    def test_pin_is_the_fallback_until_detection_lands(self):
        # At startup, before the first /slots probe, the pin is all there is.
        ap = load_proxy(window="65536")
        ap.default_context_window = 0
        self.assertEqual(ap._model_entry("qwen36-35b-a3b-iq4xs")["context_length"], 65536)
        self.assertEqual(ap._effective_context_window(), 65536)

    def test_advertised_window_equals_the_forcing_scale_denominator(self):
        # The compaction-forcing scale and the advertisement are two halves of
        # one contract: the client is told a window AND handed counts scaled to
        # make it compact inside that window. Derived from different numbers,
        # they fight — the 65,536/199,680 split had clients compacting at ~18%
        # of the rail.
        ap = load_proxy(window="65536")
        ap.default_context_window = 199680
        advertised = ap._model_entry("qwen36-35b-a3b-iq4xs")["context_length"]
        frac = ap.PROXY_COMPACT_TARGET_FRACTION
        if not (0 < frac < 1):
            frac = min(0.9, ap.PROXY_CONTEXT_PRUNE_THRESHOLD * 0.95)
        expected = ap.PROXY_CLIENT_ASSUMED_WINDOW / (advertised * frac)
        self.assertAlmostEqual(ap._count_tokens_scale(), max(1.0, expected), places=6)

    def test_entry_always_keeps_the_openai_shape(self):
        ap = load_proxy()
        for mid in ap.ADVERTISED_MODEL_IDS:
            e = ap._model_entry(mid)
            self.assertEqual(e["id"], mid)
            self.assertEqual(e["object"], "model")


class DetectContextWindowTest(unittest.TestCase):
    """Startup resolution: ask the server first, settings are the fallback."""

    def tearDown(self):
        os.environ.pop("PROXY_CONTEXT_WINDOW", None)
        os.environ.pop("PROXY_COUNT_TOKENS_SCALE", None)

    @staticmethod
    def _client(n_ctx=None, fail=False):
        class _Resp:
            status_code = 200

            def json(self):
                return [{"n_ctx": n_ctx}, {"n_ctx": n_ctx}]

        class _Client:
            async def get(self, url, timeout=None):
                if fail:
                    raise RuntimeError("connection refused")
                return _Resp()

        return _Client()

    def test_probes_the_server_even_when_a_fallback_is_configured(self):
        # Previously the configured value short-circuited the probe, so a stale
        # setting governed /v1/models until the first /v1/messages — and SDK
        # clients read /v1/models before sending anything.
        ap = load_proxy(window="65536", measured=False)
        w = asyncio.run(ap.detect_context_window(self._client(n_ctx=199680)))
        self.assertEqual(w, 199680)
        self.assertTrue(ap._context_window_measured)

    def test_falls_back_to_the_configured_value_when_the_probe_fails(self):
        ap = load_proxy(window="65536", measured=False)
        w = asyncio.run(ap.detect_context_window(self._client(fail=True)))
        self.assertEqual(w, 65536)
        # An operator setting is an assertion, so it may be published.
        self.assertTrue(ap._context_window_measured)

    def test_last_resort_guess_is_marked_unmeasured(self):
        ap = load_proxy(window="0", measured=True)
        w = asyncio.run(ap.detect_context_window(self._client(fail=True)))
        self.assertEqual(w, 131072)
        self.assertFalse(ap._context_window_measured)
        self.assertEqual(
            ap._model_entry("qwen36-35b-a3b-iq4xs"), {"id": "qwen36-35b-a3b-iq4xs", "object": "model"}
        )


if __name__ == "__main__":
    unittest.main()
