"""Per-model carve-out for the tool-turn thinking disable.

Observed live (2026-11-20, basalt-27b on the :4000 proxy): the tool-turn
thinking disable is a Flash-Next posture (mandatory thinking burns the
tool-turn budget). On the 27B -- hybrid thinking -- the same global knob
amputates exactly the reasoning that keeps the model out of mechanical
re-issue loops: a session re-emitted the same check call ~15 times at
~2 s intervals (zero prose, zero reasoning_content) until ERROR-LOOP
hard-stopped it with a 400. PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT
restores thinking for exempt (served-id-matching) arms only. The served
ids come from the module's /v1/models cache (arm truth); the CLIENT-named
model must never be able to flip the posture.
"""
import importlib.util
import os
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"

_PRIOR_AUTOLOAD = os.environ.get("UAP_PROXY_ENV_AUTOLOAD")


def tearDownModule():
    if _PRIOR_AUTOLOAD is None:
        os.environ.pop("UAP_PROXY_ENV_AUTOLOAD", None)
    else:
        os.environ["UAP_PROXY_ENV_AUTOLOAD"] = _PRIOR_AUTOLOAD


def load_proxy(**env):
    os.environ["UAP_PROXY_ENV_AUTOLOAD"] = "0"
    for k in (
        "PROXY_DISABLE_THINKING_ALWAYS",
        "PROXY_DISABLE_THINKING_ON_TOOL_TURNS",
        "PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT",
    ):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in env.items()})
    spec = importlib.util.spec_from_file_location("anthropic_proxy_exempt", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ToolTurnThinkingExemptTest(unittest.TestCase):
    def tearDown(self):
        for k in (
            "PROXY_DISABLE_THINKING_ALWAYS",
            "PROXY_DISABLE_THINKING_ON_TOOL_TURNS",
            "PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT",
        ):
            os.environ.pop(k, None)

    def test_exempt_keeps_thinking_on_tool_turns(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        ap._upstream_model_ids = ["Qwen3.8-27B QUASAR NVFP4"]
        self.assertFalse(ap._tool_turn_thinking_disabled())

    def test_exempt_matches_case_insensitive_substring(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        ap._upstream_model_ids = ["qwen3.8-27b-nvidia-nvfp4-qad"]
        self.assertFalse(ap._tool_turn_thinking_disabled())

    def test_flash_next_arms_still_disable(self):
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        for served in ("Qwen3.8-Flash-Next NVIDIA-NVFP4", "qwen3.8-flash-next-ud-q4_k_xl"):
            ap._upstream_model_ids = [served]
            self.assertTrue(ap._tool_turn_thinking_disabled(), served)

    def test_empty_exempt_is_today_behaviour(self):
        ap = load_proxy(PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on")
        ap._upstream_model_ids = ["Qwen3.8-27B QUASAR NVFP4"]
        self.assertTrue(ap._tool_turn_thinking_disabled())

    def test_cold_cache_keeps_today_behaviour_one_request(self):
        # A cold served-ids cache cannot exempt; the next request (cache
        # warmed by the probe path) gets the carve-out.
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        ap._upstream_model_ids = None
        self.assertTrue(ap._tool_turn_thinking_disabled())

    def test_client_named_model_cannot_flip_the_posture(self):
        # build_openai_request runs before wire reconciliation, so the body
        # still holds the CLIENT's id at the switch site; the exemption
        # reads arm truth (served ids) instead. A client naming "27b"
        # against a Flash-Next arm must NOT get thinking back.
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        ap._upstream_model_ids = ["Qwen3.8-Flash-Next NVIDIA-NVFP4"]
        self.assertTrue(ap._tool_turn_thinking_disabled())

    def test_always_wins_over_exempt(self):
        # The operator hard-off must survive the carve-out.
        ap = load_proxy(
            PROXY_DISABLE_THINKING_ALWAYS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS="on",
            PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b",
        )
        ap._upstream_model_ids = ["Qwen3.8-27B QUASAR NVFP4"]
        self.assertTrue(ap._tool_turn_thinking_disabled())

    def test_exempt_harmless_when_tool_turn_disable_off(self):
        ap = load_proxy(PROXY_DISABLE_THINKING_ON_TOOL_TURNS_EXEMPT="27b")
        ap._upstream_model_ids = ["Qwen3.8-27B QUASAR NVFP4"]
        self.assertFalse(ap._tool_turn_thinking_disabled())


if __name__ == "__main__":
    unittest.main()
