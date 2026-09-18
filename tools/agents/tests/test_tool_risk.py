"""Tests for the AutoMode advisory risk classifier (uplift 1.3).

Covers: per-class fixture accuracy against the labeled corpus, evasion
variants (launcher prefixes, chaining, shell-wrap, quoted payloads), benign
lookalikes that must NOT classify destructive, calibration determinism and
the held-out destructive-recall gate, proxy wiring (classifier exception
passes through untouched, env hatch, debug log line, telemetry), and the
latency budget (p95 < 5ms over 10k calls — the 50ms AutoMode budget includes
future model calls; the heuristic floor must be far under).
"""
import copy
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_TESTS = Path(__file__).resolve().parent
_SCRIPTS = _TESTS.parent / "scripts"
_CORPUS = _TESTS / "fixtures" / "tool_risk_cases.json"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


tool_risk = _load("tool_risk", _SCRIPTS / "tool_risk.py")
calibrate = _load("tool_risk_calibrate", _SCRIPTS / "tool_risk_calibrate.py")

# project_telemetry is imported lazily inside the proxy's scan helper; loading
# it here makes monkeypatching land on the same module object the proxy sees.
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
import project_telemetry  # noqa: E402


def _classify(command: str) -> "tool_risk.RiskAssessment":
    return tool_risk.classify_tool_call("Bash", {"command": command})


def _signal_names(assessment) -> list:
    return [s.split(":", 1)[0] for s in assessment.signals]


class CorpusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = calibrate.load_corpus(_CORPUS)

    def test_corpus_size_and_shape(self):
        self.assertGreaterEqual(len(self.cases), 80)
        ids = [c["id"] for c in self.cases]
        self.assertEqual(len(ids), len(set(ids)), "duplicate case ids")

    def test_corpus_covers_all_classes(self):
        for klass in tool_risk.RISK_CLASSES:
            support = sum(1 for c in self.cases if c["expect"] == klass)
            self.assertGreaterEqual(support, 10, f"class {klass} under-represented")

    def test_full_corpus_accuracy(self):
        """Every labeled case classifies to its expected class. This is the
        regression gate; the held-out calibration numbers live in
        docs/performance/automode-risk-calibration.md."""
        misses = []
        for case in self.cases:
            got = tool_risk.classify_tool_call(case["tool"], case["input"]).risk_class
            if got != case["expect"]:
                misses.append(f"{case['id']}: expected {case['expect']}, got {got}")
        self.assertEqual(misses, [], "corpus misclassifications:\n" + "\n".join(misses))

    def test_signals_format_auditable(self):
        """Every signal is 'name:class+weight' so each score point is
        attributable to a named rule."""
        import re
        pat = re.compile(r"^[a-z0-9-]+:(destructive|write|execute|read|network)\+\d+$")
        for case in self.cases:
            a = tool_risk.classify_tool_call(case["tool"], case["input"])
            for sig in a.signals:
                self.assertRegex(sig, pat, f"{case['id']}: malformed signal {sig!r}")


class DestructiveEvasionTest(unittest.TestCase):
    """The evasion shapes the enforcers already know must not slip the scorer."""

    def test_launcher_prefixes(self):
        for cmd in ("sudo rm -rf /data", "nohup rm -rf /data &",
                    "timeout 10 rm -rf /data", "env X=1 rm -rf /data",
                    "nice -n 19 rm -rf /data"):
            a = _classify(cmd)
            self.assertEqual(a.risk_class, "destructive", cmd)
            self.assertIn("rm-recursive", _signal_names(a), cmd)

    def test_chained_commands(self):
        a = _classify("cd /tmp/work && rm -rf *")
        self.assertEqual(a.risk_class, "destructive")
        a = _classify("echo ok; rm -rf ./src | cat")
        self.assertEqual(a.risk_class, "destructive")

    def test_shell_wrap_unwrapping(self):
        for cmd in ("bash -c 'rm -rf ~/projects/x'", 'sh -c "git reset --hard"',
                    "eval 'rm -rf ./store'"):
            a = _classify(cmd)
            self.assertEqual(a.risk_class, "destructive", cmd)

    def test_path_variants_and_self_targets(self):
        for cmd in ("rm -rf .uap/", "rm -rf ./.uap", "rm -rf .git"):
            a = _classify(cmd)
            self.assertEqual(a.risk_class, "destructive", cmd)
            self.assertEqual(a.risk_score, 5, cmd)
            self.assertIn("protected-target", _signal_names(a), cmd)

    def test_interpreter_mediated_delete(self):
        a = _classify("python3 -c \"import shutil; shutil.rmtree('/data')\"")
        self.assertEqual(a.risk_class, "destructive")
        self.assertIn("interpreter-destructive", _signal_names(a))

    def test_hard_destructive_scores_five(self):
        for cmd in ("rm -rf /data", "git push --force origin main",
                    "git reset --hard", "dd if=/dev/zero of=/dev/sda",
                    "mkfs.ext4 /dev/sdb1"):
            self.assertEqual(_classify(cmd).risk_score, 5, cmd)


class BenignLookalikeTest(unittest.TestCase):
    """Lookalikes that must NOT classify destructive (advisory precision keeps
    the signal trustworthy; the fail-closed doctrine only demands destructive
    RECALL, it does not license flagging everything)."""

    def test_ls_rf_is_read(self):
        self.assertEqual(_classify("ls -rf").risk_class, "read")

    def test_force_with_lease_is_network(self):
        a = _classify("git push --force-with-lease origin docs-branch")
        self.assertEqual(a.risk_class, "network")
        self.assertIn("git-push-lease", _signal_names(a))

    def test_hard_force_beats_lease_regardless_of_order(self):
        # git ignores the lease when a plain --force is present, so a
        # co-occurring hard force is destructive in EITHER argument order.
        for cmd in ("git push --force --force-with-lease origin main",
                    "git push --force-with-lease --force origin main",
                    "git push -f --force-with-lease origin main"):
            a = _classify(cmd)
            self.assertEqual(a.risk_class, "destructive", cmd)
            self.assertIn("git-push-force", _signal_names(a), cmd)

    def test_no_force_with_lease_is_an_ordinary_push(self):
        a = _classify("git push --no-force-with-lease origin main")
        self.assertEqual(a.risk_class, "network")
        self.assertIn("git-push", _signal_names(a))

    def test_rm_long_force_is_not_recursive(self):
        a = _classify("rm --force ./important.log")
        self.assertEqual(a.risk_class, "destructive")
        self.assertIn("rm-file", _signal_names(a))
        self.assertNotIn("rm-recursive", _signal_names(a))
        self.assertEqual(a.risk_score, 4)
        a = _classify("rm --recursive ./data")
        self.assertIn("rm-recursive", _signal_names(a))

    def test_quoted_redirect_target_survives(self):
        a = _classify('echo data > "out file.txt"')
        self.assertEqual(a.risk_class, "write")
        self.assertIn("file-redirect", _signal_names(a))
        a = _classify('echo x > ".uap/evidence/y.json"')
        self.assertEqual(a.risk_class, "write")
        self.assertIn("protected-redirect", _signal_names(a))

    def test_scratch_rm_is_write(self):
        for cmd in ("rm -rf ./node_modules/.cache", "rm -rf /tmp/build-scratch",
                    "rm -rf dist"):
            a = _classify(cmd)
            self.assertEqual(a.risk_class, "write", cmd)
            self.assertIn("rm-scratch-target", _signal_names(a), cmd)

    def test_quoted_destructive_prose_is_not_destructive(self):
        self.assertEqual(_classify('echo "rm -rf /" > notes.txt').risk_class, "write")
        self.assertEqual(_classify('grep -r "rm -rf" docs/').risk_class, "read")

    def test_conditional_verbs_without_write_flag_are_reads(self):
        # Enforcer parity: sed without -i and find without -delete/-exec are
        # stdout filters, not mutations.
        self.assertEqual(_classify("sed -n '1,20p' file.py").risk_class, "read")
        self.assertEqual(_classify("find . -name '*.py'").risk_class, "read")

    def test_mixed_scratch_and_real_target_stays_destructive(self):
        a = _classify("rm -rf ./node_modules ./src")
        self.assertEqual(a.risk_class, "destructive")


class EnforcerParityDriftGuardTest(unittest.TestCase):
    """tool_risk deliberately MIRRORS enforcement_self_protect's evasion
    handling (launcher step-over, find-mutating flags, sed -i conditional).
    This test makes copy-divergence a CI failure instead of silent drift:
    if the enforcer's semantics change, these assertions fail until the
    scorer is re-aligned (or the divergence is documented here)."""

    @classmethod
    def setUpClass(cls):
        cls.esp = _load(
            "enforcement_self_protect",
            Path(__file__).resolve().parents[3]
            / "src" / "policies" / "enforcers" / "enforcement_self_protect.py",
        )

    def test_launcher_sets_agree(self):
        # The enforcer's launchers must ALL be stepped over by the scorer.
        # The scorer's one addition is "env": the enforcer handles env via
        # its _WRAPPERS path instead of the launcher list — a documented,
        # asserted divergence, not drift.
        enforcer = set(self.esp._LAUNCHERS)
        scorer = set(tool_risk._LAUNCHERS)
        self.assertLessEqual(enforcer, scorer)
        self.assertEqual(scorer - enforcer, {"env"})

    def test_find_mutating_semantics_agree(self):
        batteries = [
            (["-delete"], True),
            (["-exec", "rm", "{}", "+"], True),
            (["-execdir", "true", ";"], True),
            (["-ok", "rm", "{}", ";"], True),
            (["-okdir", "true", ";"], True),
            (["-fprint", "/tmp/x"], True),
            (["-fprint0", "/tmp/x"], True),
            (["-fprintf", "/tmp/x", "%p"], True),
            (["-fls", "/tmp/x"], True),
            (["-name", "*.py"], False),
            (["-type", "f", "-mtime", "+7"], False),
        ]
        for tokens, enforcer_writes in batteries:
            self.assertEqual(self.esp._find_writes(tokens), enforcer_writes,
                             f"enforcer fixture wrong for {tokens}")
            a = _classify("find /x " + " ".join(tokens))
            scorer_writes = a.risk_class == "destructive"
            self.assertEqual(scorer_writes, enforcer_writes,
                             f"scorer/enforcer disagree on find {' '.join(tokens)}")

    def test_sed_conditional_semantics_agree(self):
        batteries = [
            (["-i", "s/a/b/", "f"], True),
            (["-i.bak", "s/a/b/", "f"], True),
            (["-ni", "-E", "s/a/b/", "f"], True),
            (["-Ei", "s/a/b/", "f"], True),
            (["--in-place", "s/a/b/", "f"], True),
            (["--in-place=.bak", "s/a/b/", "f"], True),
            (["-n", "1,5p", "f"], False),
            (["-e", "s/a/b/", "f"], False),
            (["s/a/b/", "f"], False),
        ]
        for tokens, enforcer_writes in batteries:
            self.assertEqual(self.esp._sed_writes(tokens), enforcer_writes,
                             f"enforcer fixture wrong for {tokens}")
            a = _classify("sed " + " ".join(tokens))
            scorer_writes = a.risk_class == "write"
            self.assertEqual(scorer_writes, enforcer_writes,
                             f"scorer/enforcer disagree on sed {' '.join(tokens)}")


class ClassSemanticsTest(unittest.TestCase):
    def test_read_write_execute_network_representatives(self):
        self.assertEqual(_classify("cat README.md").risk_class, "read")
        self.assertEqual(_classify("cp a b").risk_class, "write")
        self.assertEqual(_classify("pytest -q").risk_class, "execute")
        self.assertEqual(_classify("curl https://example.com").risk_class, "network")

    def test_tool_name_routing(self):
        self.assertEqual(
            tool_risk.classify_tool_call("Read", {"file_path": "x"}).risk_class, "read")
        self.assertEqual(
            tool_risk.classify_tool_call("Edit", {"file_path": "x"}).risk_class, "write")
        self.assertEqual(
            tool_risk.classify_tool_call("WebFetch", {"url": "https://x"}).risk_class,
            "network")

    def test_assessment_shape_and_bounds(self):
        a = _classify("ls")
        self.assertIn(a.risk_class, tool_risk.RISK_CLASSES)
        self.assertGreaterEqual(a.risk_score, 1)
        self.assertLessEqual(a.risk_score, 5)
        self.assertIsInstance(a.signals, list)
        self.assertGreaterEqual(a.latency_ms, 0.0)

    def test_malformed_input_never_raises(self):
        for bad in (None, "rm -rf /", 42, ["rm"]):
            a = tool_risk.classify_tool_call("Bash", bad)
            self.assertIn(a.risk_class, tool_risk.RISK_CLASSES)
        a = tool_risk.classify_tool_call(None, None)
        self.assertEqual(a.risk_class, "execute")  # unknown tool: pessimistic floor
        a = _classify("")
        self.assertEqual(a.risk_score, 1)

    def test_purity_same_input_same_output(self):
        a1 = _classify("sudo rm -rf ./data && git push --force")
        a2 = _classify("sudo rm -rf ./data && git push --force")
        self.assertEqual(a1.risk_class, a2.risk_class)
        self.assertEqual(a1.risk_score, a2.risk_score)
        self.assertEqual(a1.signals, a2.signals)

    def test_fd_duplication_is_not_a_file_write(self):
        # `2>&1` duplicates a descriptor; only the quote-blanked redirect scan
        # stands between it and a false write signal.
        a = _classify("pytest -q 2>&1 | tail -5")
        self.assertNotIn("file-redirect", _signal_names(a))


class CalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = calibrate.load_corpus(_CORPUS)

    def test_split_deterministic(self):
        train1, held1 = calibrate.split_cases(self.cases)
        train2, held2 = calibrate.split_cases(self.cases)
        self.assertEqual([c["id"] for c in held1], [c["id"] for c in held2])
        self.assertEqual([c["id"] for c in train1], [c["id"] for c in train2])
        self.assertTrue(held1, "held-out split must not be empty")

    def test_report_regeneration_determinism(self):
        """Same seed -> same numbers (the calibration doc commits to them)."""
        _t1, held1 = calibrate.split_cases(self.cases)
        _t2, held2 = calibrate.split_cases(self.cases)
        self.assertEqual(calibrate.evaluate(held1), calibrate.evaluate(held2))

    def test_held_out_destructive_recall_is_one(self):
        """The fail-closed gate: a missed destructive call is the unacceptable
        error. False positives are advisory-only cost."""
        _train, held = calibrate.split_cases(self.cases)
        metrics = calibrate.evaluate(held)
        self.assertEqual(metrics["per_class"]["destructive"]["recall"], 1.0)
        self.assertGreater(metrics["per_class"]["destructive"]["support"], 0)

    def test_check_mode_passes(self):
        self.assertEqual(calibrate.main(["--check", "--corpus", str(_CORPUS)]), 0)


class LatencyBenchTest(unittest.TestCase):
    def test_p95_under_5ms_over_10k_calls(self):
        """The 50ms AutoMode budget includes future model calls; the heuristic
        floor must be far under it (pure regex/dict work, microseconds)."""
        cases = calibrate.load_corpus(_CORPUS)
        n = 10_000
        latencies = []
        for i in range(n):
            case = cases[i % len(cases)]
            start = time.perf_counter()
            tool_risk.classify_tool_call(case["tool"], case["input"])
            latencies.append((time.perf_counter() - start) * 1000.0)
        latencies.sort()
        p95 = latencies[int(0.95 * n)]
        self.assertLess(p95, 5.0, f"p95 latency {p95:.3f}ms exceeds 5ms budget")


class ProxyWiringTest(unittest.TestCase):
    """The proxy hook observes and records ONLY: never blocks, never mutates
    the stream, degrades to pass-through + a warning on classifier error."""

    @classmethod
    def setUpClass(cls):
        cls.proxy = _load("anthropic_proxy_automode", _SCRIPTS / "anthropic_proxy.py")

    def test_env_hatch_off_disables(self):
        proxy = self.proxy
        calls = []
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", False), \
                mock.patch.object(proxy, "_automode_classify",
                                  lambda *a: calls.append(a) or None):
            resp = {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                                 "input": {"command": "ls"}}]}
            self.assertEqual(proxy._automode_risk_scan_response(resp, {}), [])
        self.assertEqual(calls, [], "classifier must not run when hatched off")

    def test_env_var_off_at_import(self):
        with mock.patch.dict(os.environ, {"PROXY_AUTOMODE_RISK": "off"}):
            fresh = _load("anthropic_proxy_automode_off",
                          _SCRIPTS / "anthropic_proxy.py")
        self.assertIs(fresh.PROXY_AUTOMODE_RISK, False)

    def test_classifier_exception_passes_stream_through(self):
        """On classifier error: log a warning, skip the call, response dict
        byte-identical. The deterministic enforcers remain the floor."""
        proxy = self.proxy

        def _boom(name, inp):
            raise RuntimeError("classifier exploded")

        resp = {"content": [
            {"type": "text", "text": "removing now"},
            {"type": "tool_use", "id": "t1", "name": "Bash",
             "input": {"command": "rm -rf ./src"}},
        ]}
        before = copy.deepcopy(resp)
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", True), \
                mock.patch.object(proxy, "_AUTOMODE_RISK_OK", True), \
                mock.patch.object(proxy, "_automode_classify", _boom):
            with self.assertLogs(proxy.logger, level="WARNING") as logs:
                results = proxy._automode_risk_scan_response(resp, {})
        self.assertEqual(results, [])
        self.assertEqual(resp, before, "stream must pass through unmodified")
        self.assertTrue(any("AUTOMODE RISK" in line for line in logs.output))

    def test_scan_classifies_and_logs_at_debug(self):
        proxy = self.proxy
        resp = {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                             "input": {"command": "rm -rf ./src"}}]}
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", True), \
                mock.patch.object(proxy, "_AUTOMODE_RISK_OK", True):
            with self.assertLogs(proxy.logger, level="DEBUG") as logs:
                results = proxy._automode_risk_scan_response(resp, {})
        self.assertEqual(len(results), 1)
        _tid, _name, assessment = results[0]
        self.assertEqual(assessment.risk_class, "destructive")
        self.assertTrue(any("AUTOMODE RISK" in line and "destructive" in line
                            for line in logs.output))

    def test_high_risk_calls_record_telemetry(self):
        proxy = self.proxy
        recorded = []
        resp = {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                             "input": {"command": "git push --force origin main"}}]}
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", True), \
                mock.patch.object(proxy, "_AUTOMODE_RISK_OK", True), \
                mock.patch.object(project_telemetry, "derive_project_dir",
                                  return_value="/tmp/x"), \
                mock.patch.object(project_telemetry, "record_risk_event",
                                  lambda *a: recorded.append(a) or True):
            proxy._automode_risk_scan_response(resp, {"messages": []})
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0][2], "destructive")

    def test_low_risk_calls_skip_telemetry(self):
        proxy = self.proxy
        recorded = []
        resp = {"content": [{"type": "tool_use", "id": "t1", "name": "Read",
                             "input": {"file_path": "README.md"}}]}
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", True), \
                mock.patch.object(proxy, "_AUTOMODE_RISK_OK", True), \
                mock.patch.object(project_telemetry, "derive_project_dir",
                                  return_value="/tmp/x"), \
                mock.patch.object(project_telemetry, "record_risk_event",
                                  lambda *a: recorded.append(a) or True):
            proxy._automode_risk_scan_response(resp, {"messages": []})
        self.assertEqual(recorded, [], "routine reads must not flood the feed")

    def test_tool_args_dict_tolerates_truncation(self):
        proxy = self.proxy
        self.assertEqual(proxy._tool_args_dict('{"command": "ls"}'),
                         {"command": "ls"})
        self.assertEqual(proxy._tool_args_dict('{"command": "ls'), {})
        self.assertEqual(proxy._tool_args_dict(""), {})

    def test_record_risk_event_writes_dashboard_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "agents", "data", "memory"))
            ok = project_telemetry.record_risk_event(
                tmp, "Bash", "destructive", 5, ["rm-recursive:destructive+5"], 0.01)
            self.assertTrue(ok)
            import sqlite3
            conn = sqlite3.connect(
                os.path.join(tmp, "agents", "data", "memory", "telemetry.db"))
            try:
                rows = conn.execute(
                    "SELECT category, type, severity, title FROM dashboard_events"
                ).fetchall()
            finally:
                conn.close()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0][0:3], ("automode", "risk.classified", "warning"))

    def test_record_risk_event_never_raises(self):
        self.assertFalse(project_telemetry.record_risk_event(
            "/nonexistent/no-such-project", "Bash", "destructive", 5, []))
        self.assertFalse(project_telemetry.record_risk_event(
            "", "Bash", "destructive", 5, []))

    def test_tool_name_sanitized_at_sinks(self):
        """Model-controlled tool names must not forge log lines or dashboard
        rows: control chars become '?' and the name is capped at 64 chars."""
        proxy = self.proxy
        forged = "Bash\nFORGED-LOG-LINE\x00 " + "x" * 100
        resp = {"content": [{"type": "tool_use", "id": "t1", "name": forged,
                             "input": {"command": "git push --force origin m"}}]}
        recorded = []
        with mock.patch.object(proxy, "PROXY_AUTOMODE_RISK", True), \
                mock.patch.object(proxy, "_AUTOMODE_RISK_OK", True), \
                mock.patch.object(project_telemetry, "derive_project_dir",
                                  return_value="/tmp/x"), \
                mock.patch.object(project_telemetry, "record_risk_event",
                                  lambda *a: recorded.append(a) or True):
            with self.assertLogs(proxy.logger, level="DEBUG") as logs:
                proxy._automode_risk_scan_response(resp, {"messages": []})
        self.assertEqual(len(recorded), 1)
        logged_name = recorded[0][1]
        self.assertNotIn("\n", logged_name)
        self.assertNotIn("\x00", logged_name)
        self.assertLessEqual(len(logged_name), 64)
        self.assertTrue(any("Bash?FORGED-LOG-LINE?" in line
                            for line in logs.output), logs.output)

    def test_startup_warning_when_classifier_import_fails(self):
        """A default-on feature must never be silently dead: when the
        tool_risk import fails, the proxy logs ONE warning at startup
        (import time), naming the disabled capability and the floor."""
        with mock.patch.dict(sys.modules, {"tool_risk": None}), \
                self.assertLogs("uap.anthropic_proxy", level="WARNING") as logs:
            fresh = _load("anthropic_proxy_automode_broken",
                          _SCRIPTS / "anthropic_proxy.py")
        self.assertIs(fresh._AUTOMODE_RISK_OK, False)
        self.assertTrue(any("tool_risk import failed" in line
                            for line in logs.output), logs.output)


if __name__ == "__main__":
    unittest.main()
