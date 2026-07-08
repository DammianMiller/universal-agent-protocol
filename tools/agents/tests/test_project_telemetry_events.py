"""record_from_request must feed the dashboard live panels, not just analytics.

Live Events / Performance read <project>/agents/data/memory/telemetry.db,
which only the TS producers wrote — plain claude+proxy sessions left those
panels empty forever. The proxy now mirrors each completed turn there.
"""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

pt_path = Path(__file__).resolve().parents[1] / "scripts" / "project_telemetry.py"
spec = importlib.util.spec_from_file_location("project_telemetry", pt_path)
pt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pt)


class ProjectTelemetryEventsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="pt-events-")
        self.root = Path(self._tmp.name)
        # A recordable UAP project: marker + existing memory dir (the writer
        # must never scaffold into arbitrary derived directories).
        (self.root / ".git").mkdir()
        (self.root / "agents" / "data" / "memory").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _body(self):
        # derive_project_dir walks absolute paths echoed in the request.
        return {"messages": [{"role": "user", "content": f"edit {self.root}/src/main.rs"}]}

    def test_turn_writes_analytics_event_and_perf_sample(self):
        ok = pt.record_from_request(
            self._body(),
            "qwen-test",
            {"input_tokens": 1000, "output_tokens": 50},
            duration_ms=1234.5,
        )
        self.assertTrue(ok)
        mem = self.root / "agents" / "data" / "memory"

        con = sqlite3.connect(mem / "model_analytics.db")
        row = con.execute(
            "SELECT modelId, tokensIn, tokensOut, durationMs FROM task_outcomes"
        ).fetchone()
        con.close()
        self.assertEqual(row, ("qwen-test", 1000, 50, 1234))

        con = sqlite3.connect(mem / "telemetry.db")
        ev = con.execute(
            "SELECT category, type, severity, title, metadata FROM dashboard_events"
        ).fetchone()
        perf = con.execute("SELECT metric, duration_ms FROM perf_samples").fetchone()
        con.close()
        self.assertEqual(ev[0:3], ("model", "turn", "info"))
        self.assertIn("qwen-test", ev[3])
        meta = json.loads(ev[4])
        self.assertEqual(meta["tokensIn"], 1000)
        self.assertEqual(meta["tokensOut"], 50)
        self.assertEqual(perf, ("proxy_turn_ms", 1234.5))

    def test_schema_matches_ts_producer_shape(self):
        # The TS side (telemetry-store.ts) CREATE IF NOT EXISTS must no-op on a
        # DB the proxy created first — the column shape has to match exactly.
        pt.record_from_request(self._body(), "m", {"input_tokens": 1, "output_tokens": 1})
        con = sqlite3.connect(self.root / "agents" / "data" / "memory" / "telemetry.db")
        cols = [r[1] for r in con.execute("PRAGMA table_info(dashboard_events)")]
        perf_cols = [r[1] for r in con.execute("PRAGMA table_info(perf_samples)")]
        con.close()
        self.assertEqual(cols, ["id", "ts", "category", "type", "severity", "title", "detail", "metadata"])
        self.assertEqual(perf_cols, ["id", "metric", "duration_ms", "ts"])

    def test_never_scaffolds_memory_dir(self):
        bare = Path(self._tmp.name) / "bare"
        (bare / ".git").mkdir(parents=True)
        body = {"messages": [{"role": "user", "content": f"see {bare}/x.txt"}]}
        self.assertFalse(pt.record_from_request(body, "m", {"input_tokens": 1, "output_tokens": 1}))
        self.assertFalse((bare / "agents").exists())

    def test_zero_duration_skips_perf_sample_but_keeps_event(self):
        pt.record_from_request(self._body(), "m", {"input_tokens": 5, "output_tokens": 5})
        con = sqlite3.connect(self.root / "agents" / "data" / "memory" / "telemetry.db")
        events = con.execute("SELECT count(*) FROM dashboard_events").fetchone()[0]
        perf = con.execute("SELECT count(*) FROM perf_samples").fetchone()[0]
        con.close()
        self.assertEqual(events, 1)
        self.assertEqual(perf, 0)


if __name__ == "__main__":
    unittest.main()
