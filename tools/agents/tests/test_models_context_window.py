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
import importlib.util
import os
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"


def load_proxy(window="130048", passthrough=None):
    """Import a fresh proxy module under the given env (constants bind at import)."""
    os.environ["PROXY_CONTEXT_WINDOW"] = window
    if passthrough is None:
        os.environ.pop("ANTHROPIC_PASSTHROUGH_MODELS", None)
    else:
        os.environ["ANTHROPIC_PASSTHROUGH_MODELS"] = passthrough
    spec = importlib.util.spec_from_file_location("anthropic_proxy_ctx", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ModelsAdvertiseContextWindowTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("PROXY_CONTEXT_WINDOW", None)
        os.environ.pop("ANTHROPIC_PASSTHROUGH_MODELS", None)

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
        for mid in ("claude-sonnet-4-6", "claude-haiku-4-5-20251001"):
            self.assertNotIn("context_length", ap._model_entry(mid), mid)

    def test_local_only_sentinel_means_every_id_is_local(self):
        ap = load_proxy(passthrough="__local_only__")
        for mid in ap.ADVERTISED_MODEL_IDS:
            self.assertEqual(ap._model_entry(mid).get("context_length"), 130048, mid)

    def test_unset_window_advertises_nothing(self):
        # Better to say nothing than to assert a wrong number.
        ap = load_proxy(window="0")
        self.assertEqual(
            ap._model_entry("qwen36-35b-a3b-iq4xs"), {"id": "qwen36-35b-a3b-iq4xs", "object": "model"}
        )

    def test_entry_always_keeps_the_openai_shape(self):
        ap = load_proxy()
        for mid in ap.ADVERTISED_MODEL_IDS:
            e = ap._model_entry(mid)
            self.assertEqual(e["id"], mid)
            self.assertEqual(e["object"], "model")


if __name__ == "__main__":
    unittest.main()
