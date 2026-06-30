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
spec.loader.exec_module(ce)


def S(enabled=True, recipe="auto", signal="heuristic", threshold=0.5, fusion_n=3,
      auto_chars=600, model="opus", endpoint="http://x/", key="k"):
    return ce.Settings(enabled=enabled, recipe=recipe, signal=signal, threshold=threshold,
                       fusion_n=fusion_n, auto_fusion_chars=auto_chars, model=model,
                       endpoint=endpoint, api_key=key)


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


if __name__ == "__main__":
    unittest.main()
