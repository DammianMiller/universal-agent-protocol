"""Tests for project_telemetry: per-project proxy routing/cost telemetry."""
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "project_telemetry.py"
    spec = importlib.util.spec_from_file_location("project_telemetry", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


pt = _load()


def _make_project(root: str) -> str:
    os.makedirs(os.path.join(root, "agents", "data", "memory"), exist_ok=True)
    return root


class DeriveProjectDir(unittest.TestCase):
    def test_finds_project_root_from_paths_in_messages(self):
        with tempfile.TemporaryDirectory() as d:
            proj = _make_project(os.path.join(d, "project-x"))
            body = {"messages": [
                {"role": "user", "content": "run the build"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "input": {"file_path": f"{proj}/src/app.ts"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "content": f"wrote {proj}/src/app.ts and {proj}/README.md"},
                ]},
            ]}
            self.assertEqual(pt.derive_project_dir(body), proj)

    def test_returns_none_when_no_project_paths(self):
        self.assertIsNone(pt.derive_project_dir({"messages": [
            {"role": "user", "content": "hello, no paths here"}]}))

    def test_fail_open_on_garbage(self):
        for bad in (None, {}, {"messages": None}, {"messages": [1, 2, 3]}, "nope"):
            self.assertIsNone(pt.derive_project_dir(bad if isinstance(bad, dict) else {"messages": bad}))


class RecordTaskOutcome(unittest.TestCase):
    def _count_and_sums(self, proj):
        db = os.path.join(proj, "agents", "data", "memory", "model_analytics.db")
        c = sqlite3.connect(db)
        row = c.execute("SELECT COUNT(*), SUM(tokensIn), SUM(tokensOut), SUM(cost) FROM task_outcomes").fetchone()
        c.close()
        return row

    def test_writes_dashboard_compatible_row(self):
        with tempfile.TemporaryDirectory() as d:
            proj = _make_project(os.path.join(d, "p"))
            ok = pt.record_task_outcome(proj, "qwen36-a3b", 1000, 500)
            self.assertTrue(ok)
            n, ti, to, cost = self._count_and_sums(proj)
            self.assertEqual(n, 1)
            self.assertEqual(ti, 1000)
            self.assertEqual(to, 500)
            self.assertEqual(cost, 0.0)  # local model is zero-cost; dashboard computes counterfactual

    def test_skips_when_no_memory_dir(self):
        with tempfile.TemporaryDirectory() as d:
            # no agents/data/memory created
            self.assertFalse(pt.record_task_outcome(os.path.join(d, "bare"), "m", 100, 50))

    def test_skips_when_zero_tokens(self):
        with tempfile.TemporaryDirectory() as d:
            proj = _make_project(os.path.join(d, "p"))
            self.assertFalse(pt.record_task_outcome(proj, "m", 0, 0))

    def test_appends_multiple_rows(self):
        with tempfile.TemporaryDirectory() as d:
            proj = _make_project(os.path.join(d, "p"))
            pt.record_task_outcome(proj, "m", 10, 5)
            pt.record_task_outcome(proj, "m", 20, 7)
            n, ti, to, _ = self._count_and_sums(proj)
            self.assertEqual((n, ti, to), (2, 30, 12))


class RecordFromRequest(unittest.TestCase):
    def test_end_to_end_derive_and_write(self):
        with tempfile.TemporaryDirectory() as d:
            proj = _make_project(os.path.join(d, "proj"))
            body = {"messages": [{"role": "user", "content": [
                {"type": "tool_result", "content": f"ls {proj}/src returned app.ts"}]}]}
            ok = pt.record_from_request(body, "qwen36", {"input_tokens": 1234, "output_tokens": 88})
            self.assertTrue(ok)
            c = sqlite3.connect(os.path.join(proj, "agents", "data", "memory", "model_analytics.db"))
            n = c.execute("SELECT COUNT(*) FROM task_outcomes WHERE modelId='qwen36'").fetchone()[0]
            c.close()
            self.assertEqual(n, 1)

    def test_fail_open_returns_false_never_raises(self):
        self.assertFalse(pt.record_from_request(None, "m", None))
        self.assertFalse(pt.record_from_request({"messages": []}, "m", {"input_tokens": 5}))


if __name__ == "__main__":
    unittest.main()
