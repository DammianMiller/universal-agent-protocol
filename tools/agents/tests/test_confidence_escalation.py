"""Tests for the serving-layer recipe runtime (Confidence #1/#5, Fusion #3, selector #2)."""
import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path

mod_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "confidence_escalation.py"
spec = importlib.util.spec_from_file_location("confidence_escalation", mod_path)
ce = importlib.util.module_from_spec(spec)
sys.modules["confidence_escalation"] = ce
import tempfile, os as _os2
_os2.environ["UAP_RECIPE_SIGNAL_DIR"] = tempfile.mkdtemp(prefix="uap-sig-")
spec.loader.exec_module(ce)


def S(enabled=True, recipe="auto", signal="heuristic", threshold=0.5, fusion_n=3,
      auto_chars=600, model="opus", endpoint="http://x/", key="k", remom_quorum=2):
    return ce.Settings(enabled=enabled, recipe=recipe, signal=signal, threshold=threshold,
                       fusion_n=fusion_n, remom_quorum=remom_quorum, auto_fusion_chars=auto_chars,
                       model=model, endpoint=endpoint, api_key=key)


def resp(text):
    return {"content": [{"type": "text", "text": text}]}


def body(user="hi"):
    return {"model": "qwen", "max_tokens": 100, "messages": [{"role": "user", "content": user}]}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class HelpersTest(unittest.TestCase):
    def test_text_confidence(self):
        self.assertEqual(ce.text_confidence(""), 0.0)
        self.assertEqual(ce.text_confidence("I don't know"), 0.2)
        self.assertGreater(ce.text_confidence("A thorough complete answer to the question."), 0.5)

    def test_parse_verify_score(self):
        self.assertAlmostEqual(ce.parse_verify_score("8"), 0.8)
        self.assertEqual(ce.parse_verify_score("score: 3 of 10"), 0.3)
        self.assertIsNone(ce.parse_verify_score("n/a"))

    def test_parse_judge_index(self):
        self.assertEqual(ce.parse_judge_index("The best is [2]", 3), 2)
        self.assertIsNone(ce.parse_judge_index("9", 3))

    def test_fusion_variants(self):
        v = ce.build_fusion_variants({"model": "qwen", "messages": []}, 3)
        self.assertEqual(len(v), 2)  # n-1 (primary is candidate 0)
        self.assertEqual([x["temperature"] for x in v], [0.4, 0.6])


class SignalsTest(unittest.TestCase):  # reactor-aligned signals
    def test_complexity_port(self):
        # faithful to query-complexity.ts: "and then" multi-step + tech + file + 2 actions
        self.assertEqual(ce.query_complexity("fix the bug in src/a.ts and then update the tests"), "complex")
        self.assertEqual(ce.query_complexity("add a button"), "simple")
        self.assertEqual(ce.query_complexity("implement a redis rate limiter"), "simple")
        self.assertIn(ce.query_complexity("implement a redis rate limiter with tests and config"), ("moderate", "complex"))

    def test_task_shape(self):
        self.assertEqual(ce.task_shape("prove that x is even"), "reasoning")
        self.assertEqual(ce.task_shape("Which is right? A) x B) y"), "reasoning")
        self.assertEqual(ce.task_shape("refactor the function in app.ts"), "code")
        self.assertEqual(ce.task_shape("what is the capital of france?"), "qa")
        self.assertEqual(ce.task_shape("tell me a story"), "general")


class SelectorTest(unittest.TestCase):  # #2 task-shaped
    def test_disabled_or_tools_single(self):
        self.assertEqual(ce.select_recipe(body(), S(enabled=False), False), "single")
        self.assertEqual(ce.select_recipe(body(), S(), True), "single")

    def test_explicit_recipe_overrides_signals(self):
        self.assertEqual(ce.select_recipe(body("add a button"), S(recipe="fusion"), False), "fusion")
        self.assertEqual(ce.select_recipe(body("prove x is even"), S(recipe="confidence"), False), "confidence")

    def test_complex_task_routes_to_fusion(self):
        self.assertEqual(
            ce.select_recipe(body("fix the bug in src/a.ts and then update the tests"), S(recipe="auto"), False),
            "fusion",
        )

    def test_reasoning_task_routes_to_fusion(self):
        self.assertEqual(ce.select_recipe(body("prove that the sum of two evens is even"), S(recipe="auto"), False), "fusion")

    def test_simple_task_routes_to_confidence(self):
        self.assertEqual(ce.select_recipe(body("add a button"), S(recipe="auto"), False), "confidence")

    def test_no_backend_never_fusion(self):
        self.assertEqual(ce.select_recipe(body("fix the bug in a.ts and then update tests"), S(recipe="auto", endpoint=""), False), "confidence")


class ApplyConfidenceTest(unittest.TestCase):  # #1 / #5
    def test_low_confidence_escalates(self):
        async def judge(p): return resp("ESCALATED ANSWER")
        out = run(ce.apply_recipe(resp("I cannot help"), body(), {}, S(recipe="confidence"),
                                  False, None, judge))
        self.assertEqual(ce.extract_text(out), "ESCALATED ANSWER")

    def test_high_confidence_keeps_primary(self):
        async def judge(p): raise AssertionError("should not be called")
        out = run(ce.apply_recipe(resp("A complete confident answer here."), body(), {},
                                  S(recipe="confidence"), False, None, judge))
        self.assertEqual(ce.extract_text(out), "A complete confident answer here.")

    def test_selfverify_uses_judge_score(self):  # #5
        calls = {"n": 0}
        async def judge(p):
            calls["n"] += 1
            return resp("9")  # high score -> no escalation
        out = run(ce.apply_recipe(resp("short"), body(), {}, S(recipe="confidence", signal="selfverify"),
                                  False, None, judge))
        self.assertEqual(calls["n"], 1)  # verify call happened
        self.assertEqual(ce.extract_text(out), "short")  # high score, kept primary


class ApplyFusionTest(unittest.TestCase):  # #3
    def test_fusion_fans_out_and_judge_picks(self):
        async def primary(v): return resp("candidate-1")
        async def judge(p): return resp("1")  # pick index 1
        out = run(ce.apply_recipe(resp("candidate-0"), body(), {"model": "qwen", "messages": []},
                                  S(recipe="fusion", fusion_n=2), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "candidate-1")

    def test_fusion_judge_failure_falls_back_to_primary(self):
        async def primary(v): return resp("c1")
        async def judge(p): return None  # judge failed
        out = run(ce.apply_recipe(resp("c0"), body(), {"model": "qwen", "messages": []},
                                  S(recipe="fusion", fusion_n=2), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "c0")



class CrossProcessSignalTest(unittest.TestCase):  # reactor -> proxy
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix="uap-sig-test-")

    def _write(self, name, sig):
        import json, os
        with open(os.path.join(self.d, name), "w") as f:
            json.dump(sig, f)

    def test_prompt_hash_match_consumed(self):
        text = "build the thing"
        h = ce.prompt_hash(text)
        self._write(h + ".json", {"ts": __import__("time").time(), "recipe": "fusion"})
        sig = ce.load_reactor_signal(text, signal_dir=self.d)
        self.assertEqual(sig["recipe"], "fusion")

    def test_stale_signal_ignored(self):
        text = "old prompt"
        self._write(ce.prompt_hash(text) + ".json", {"ts": 1, "recipe": "fusion"})
        self.assertIsNone(ce.load_reactor_signal(text, signal_dir=self.d, ttl=180.0))

    def test_latest_fallback(self):
        self._write("latest.json", {"ts": __import__("time").time(), "recipe": "fusion"})
        sig = ce.load_reactor_signal("anything not hashed", signal_dir=self.d)
        self.assertEqual(sig["recipe"], "fusion")

    def test_select_recipe_uses_reactor_recommendation(self):
        text = "add a button"  # self-extract would say confidence (simple)
        self._write(ce.prompt_hash(text) + ".json",
                    {"ts": __import__("time").time(), "recipe": "fusion"})
        import os
        prev = os.environ.get("UAP_RECIPE_SIGNAL_DIR")
        os.environ["UAP_RECIPE_SIGNAL_DIR"] = self.d
        try:
            r = ce.select_recipe(body(text), S(recipe="auto"), False)
        finally:
            if prev is None:
                os.environ.pop("UAP_RECIPE_SIGNAL_DIR", None)
            else:
                os.environ["UAP_RECIPE_SIGNAL_DIR"] = prev
        self.assertEqual(r, "fusion")  # reactor signal overrides the simple self-classification



class ApplyRatingsTest(unittest.TestCase):  # Ratings
    def test_picks_highest_rated_candidate(self):
        async def primary(v): return resp("cand-1")
        scores = iter(["3", "9"])  # primary rated 3, fanout rated 9
        async def judge(p): return resp(next(scores))
        out = run(ce.apply_recipe(resp("cand-0"), body(), {"model": "q", "messages": []},
                                  S(recipe="ratings", fusion_n=2), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "cand-1")


class ApplyReMoMTest(unittest.TestCase):  # ReMoM
    def test_synthesizes_when_quorum_met(self):
        async def primary(v): return resp("evidence B")
        async def judge(p): return resp("MERGED ANSWER")
        out = run(ce.apply_recipe(resp("evidence A"), body(), {"model": "q", "messages": []},
                                  S(recipe="remom", fusion_n=2), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "MERGED ANSWER")

    def test_falls_back_to_best_evidence_when_synthesis_fails(self):
        async def primary(v): return resp("a longer, more complete candidate answer")
        async def judge(p): return None  # synthesis failed
        out = run(ce.apply_recipe(resp("short"), body(), {"model": "q", "messages": []},
                                  S(recipe="remom", fusion_n=2), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "a longer, more complete candidate answer")


class WorkflowTest(unittest.TestCase):
    def test_workflow_passes_through(self):  # Workflows = deliver's job
        async def primary(v): return resp("x")
        async def judge(p): return resp("y")
        out = run(ce.apply_recipe(resp("PRIMARY"), body(), {}, S(recipe="workflow"), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "PRIMARY")


class SettingsExtTest(unittest.TestCase):
    def test_remom_quorum_default(self):
        import os, tempfile
        for k in ("PROXY_REMOM_QUORUM",): os.environ.pop(k, None)
        self.assertEqual(ce.Settings.from_env().remom_quorum, 2)

    def test_new_recipes_valid(self):
        import os
        for r in ("ratings", "remom", "workflow"):
            os.environ["PROXY_RECIPE"] = r
            try:
                self.assertEqual(ce.Settings.from_env().recipe, r)
            finally:
                os.environ.pop("PROXY_RECIPE", None)


class JudgeGatingTest(unittest.TestCase):  # #2 stronger non-self judge
    def test_judge_available_distinct_vs_self(self):
        s = S(model="opus")  # judge=opus, primary=qwen -> distinct
        self.assertTrue(s.judge_available("qwen"))
        self.assertFalse(s.judge_available("opus"))          # self-judge blocked
        self.assertFalse(S(model="qwen").judge_available("qwen"))
        self.assertTrue(s.judge_available(""))               # unknown primary -> allow
        self.assertFalse(S(model="", endpoint="").judge_available("qwen"))  # unconfigured

    def test_allow_self_judge_override(self):
        s = ce.Settings(enabled=True, recipe="fusion", signal="heuristic", threshold=0.5,
                        fusion_n=2, remom_quorum=2, auto_fusion_chars=600, model="qwen",
                        endpoint="http://x/", api_key="k", allow_self_judge=True)
        self.assertTrue(s.judge_available("qwen"))

    def test_self_judge_downgrades_fusion_without_calling_judge(self):
        async def primary(v): raise AssertionError("fan-out must not run on self-judge")
        async def judge(p): raise AssertionError("judge must not be called on self-judge")
        # judge model == primary model ("qwen") -> downgrade to single
        out = run(ce.apply_recipe(resp("c0"), body(), {"model": "qwen", "messages": []},
                                  S(recipe="fusion", fusion_n=2, model="qwen"), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "c0")

    def test_distinct_judge_still_runs_fusion(self):
        async def primary(v): return resp("c1")
        async def judge(p): return resp("1")
        out = run(ce.apply_recipe(resp("c0"), body(), {"model": "qwen", "messages": []},
                                  S(recipe="fusion", fusion_n=2, model="opus"), False, primary, judge))
        self.assertEqual(ce.extract_text(out), "c1")

    def test_select_recipe_skips_fusion_on_self_judge(self):
        b = {"model": "qwen", "messages": [{"role": "user",
             "content": "prove the theorem and analyze why x is even"}]}
        self.assertEqual(ce.select_recipe(b, S(recipe="auto", model="qwen"), False), "confidence")
        self.assertEqual(ce.select_recipe(b, S(recipe="auto", model="opus"), False), "fusion")


class AdaptationSignalTest(unittest.TestCase):  # LLM-Self-Tuning real-time adaptor (P4)
    def setUp(self):
        import tempfile, os
        self.d = tempfile.mkdtemp(prefix="uap-adapt-test-")
        # Isolate the reactor-signal dir so it never pre-empts our selection.
        self.empty = tempfile.mkdtemp(prefix="uap-empty-sig-")
        self._prev_recipe = os.environ.get("UAP_RECIPE_SIGNAL_DIR")
        self._prev_adapt = os.environ.get("PROXY_REALTIME_ADAPT")
        os.environ["UAP_RECIPE_SIGNAL_DIR"] = self.empty

    def tearDown(self):
        import os
        if self._prev_recipe is None:
            os.environ.pop("UAP_RECIPE_SIGNAL_DIR", None)
        else:
            os.environ["UAP_RECIPE_SIGNAL_DIR"] = self._prev_recipe
        if self._prev_adapt is None:
            os.environ.pop("PROXY_REALTIME_ADAPT", None)
        else:
            os.environ["PROXY_REALTIME_ADAPT"] = self._prev_adapt

    def _write(self, name, sig):
        import json, os
        with open(os.path.join(self.d, name), "w") as f:
            json.dump(sig, f)

    def test_load_fresh_stale_missing(self):
        import time
        self._write("s1.json", {"ts": time.time(), "escalate": True})
        self.assertTrue(ce.load_adaptation_signal("s1", signal_dir=self.d)["escalate"])
        self._write("old.json", {"ts": 1, "escalate": True})
        self.assertIsNone(ce.load_adaptation_signal("old", signal_dir=self.d, ttl=180.0))
        self.assertIsNone(ce.load_adaptation_signal("nope", signal_dir=self.d))

    def test_latest_fallback_and_sanitized_id(self):
        import time
        self._write("latest.json", {"ts": time.time(), "recipe": "fusion"})
        self.assertEqual(ce.load_adaptation_signal(signal_dir=self.d)["recipe"], "fusion")

    def test_opt_in_escalation(self):
        import os, time
        os.environ["UAP_ADAPTATION_SIGNAL_DIR"] = self.d
        self._write("latest.json", {"ts": time.time(), "escalate": True})
        try:
            # Disabled: a short prompt stays on the cheaper 'confidence' recipe.
            os.environ["PROXY_REALTIME_ADAPT"] = "0"
            self.assertEqual(ce.select_recipe(body("add a button"), S(recipe="auto"), False), "confidence")
            # Enabled: the fresh adaptation signal escalates this turn to fusion.
            os.environ["PROXY_REALTIME_ADAPT"] = "1"
            self.assertEqual(ce.select_recipe(body("add a button"), S(recipe="auto"), False), "fusion")
        finally:
            os.environ.pop("UAP_ADAPTATION_SIGNAL_DIR", None)

    def test_no_escalation_without_judge(self):
        import os, time
        os.environ["UAP_ADAPTATION_SIGNAL_DIR"] = self.d
        os.environ["PROXY_REALTIME_ADAPT"] = "1"
        self._write("latest.json", {"ts": time.time(), "escalate": True})
        try:
            # judge == primary model → no distinct judge → never escalate to fusion.
            self.assertNotEqual(
                ce.select_recipe(body("add a button"), S(recipe="auto", model="qwen"), False),
                "fusion",
            )
        finally:
            os.environ.pop("UAP_ADAPTATION_SIGNAL_DIR", None)


if __name__ == "__main__":
    unittest.main()
