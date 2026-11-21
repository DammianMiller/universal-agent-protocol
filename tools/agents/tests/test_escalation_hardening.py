"""Tests for Option A3 & C2: hardened thrash detection, behavioral vs compile-only
gate separation, Droid Create/old_str support, and delivery.autoEscalate.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ENFORCER = REPO_ROOT / "src" / "policies" / "enforcers" / "delivery_enforcement.py"
TRACKER = REPO_ROOT / "templates" / "hooks" / "escalation_tracker.py"
AUTOROUTE = REPO_ROOT / "templates" / "hooks" / "deliver_autoroute.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class EscalationHardeningTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".git").mkdir()
        (self.root / "src").mkdir()
        self.tracker = _load_module("escalation_tracker_test", TRACKER)
        self.autoroute = _load_module("deliver_autoroute_test", AUTOROUTE)

    def tearDown(self):
        self.tmp.cleanup()

    def _hermetic_env(self, extra=None):
        env = dict(os.environ)
        for k in (
            "UAP_ENFORCE_DELIVERY",
            "UAP_DELIVER_ACTIVE",
            "UAP_DELIVER_BYPASS",
            "UAP_DELIVER_LOCAL_MODE",
            "UAP_DELIVER_ESCALATE_CONSECUTIVE_FILE_EDITS",
            "UAP_DELIVER_AUTO_ESCALATE",
        ):
            env.pop(k, None)
        env["UAP_REPO_ROOT"] = str(self.root)
        env["UAP_MAIN_ROOT"] = str(self.root)
        if extra:
            env.update(extra)
        return env

    def _run_enforcer(self, op: str, args: dict, env_extra=None):
        extra = {"UAP_ENFORCE_DELIVERY": "escalate"}
        if env_extra:
            extra.update(env_extra)
        res = subprocess.run(
            [sys.executable, str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
            env=self._hermetic_env(extra),
            capture_output=True,
            text=True,
            check=False,
        )
        return res.returncode, json.loads(res.stdout or "{}")

    def test_classify_gate_kind_separates_behavioral_from_compile_only(self):
        self.assertEqual(self.tracker.classify_gate_kind("npm run build"), "compile")
        self.assertEqual(self.tracker.classify_gate_kind("npx tsc --noEmit"), "compile")
        self.assertEqual(self.tracker.classify_gate_kind("cargo check"), "compile")
        self.assertEqual(self.tracker.classify_gate_kind("pytest -q"), "behavioral")
        self.assertEqual(self.tracker.classify_gate_kind("npx vitest run"), "behavioral")
        self.assertEqual(self.tracker.classify_gate_kind("uap verify --runtime-only"), "behavioral")
        self.assertEqual(self.tracker.classify_gate_kind("ls -la"), "none")

    def test_compile_pass_never_clears_edits_since_green_but_behavioral_pass_does(self):
        self.tracker.record_edit("src/Scene.jsx", root=self.root)
        self.tracker.record_edit("src/Scene.jsx", root=self.root)
        self.tracker.record_pass("bash", root=self.root, kind="compile")
        st = self.tracker.load_state(root=self.root)
        self.assertEqual(st["edits_since_green"].get("src/Scene.jsx"), 2)
        self.assertEqual(st.get("recent_edit_files"), ["src/Scene.jsx", "src/Scene.jsx"])

        self.tracker.record_pass("bash", root=self.root, kind="behavioral")
        st2 = self.tracker.load_state(root=self.root)
        self.assertEqual(st2["edits_since_green"], {})
        self.assertEqual(st2.get("recent_edit_files"), [])

    def test_droid_create_is_gated_and_escalates_churn_despite_compile_builds(self):
        # Put a blueprint on disk to verify C2 hint enrichment too.
        (self.root / ".uap").mkdir(exist_ok=True)
        (self.root / ".uap" / "blueprint.md").write_text("# Blueprint\n- Subsystem A\n", encoding="utf-8")

        args = {"file_path": str(self.root / "src" / "Scene.jsx"), "content": "export const x = 1;\n" * 20}
        for _ in range(6):
            rc, verdict = self._run_enforcer("Create", args)
            self.assertEqual(rc, 0)
            self.assertTrue(verdict["allowed"])
            # Simulate model running `npm run build` between every rewrite via real CLI
            subprocess.run(
                [
                    sys.executable,
                    str(TRACKER),
                    "classify-bash",
                    "--command",
                    "npm run build",
                    "--output",
                    "built in 120ms\nbuild succeeded",
                ],
                env=self._hermetic_env(),
                check=True,
                capture_output=True,
                text=True,
            )

        # 7th consecutive Create on the same file MUST escalate on churn despite green builds
        rc, verdict = self._run_enforcer("Create", args)
        self.assertEqual(rc, 2)
        self.assertFalse(verdict["allowed"])
        self.assertEqual(verdict.get("escalation"), "churn")
        self.assertIn(".uap/blueprint.md", verdict.get("deliverHint", ""))

    def test_deliver_autoroute_recognizes_droid_old_str_and_auto_escalate_config(self):
        (self.root / ".uap.json").write_text(
            json.dumps({"delivery": {"autoEscalate": True}}),
            encoding="utf-8",
        )
        self.assertTrue(self.autoroute._auto_escalate_enabled(self.root))

        out = {
            "allowed": False,
            "route": "deliver",
            "escalation": "churn",
            "reason": "ESCALATE: churn on src/Scene.jsx",
            "deliverHint": "Converge src/Scene.jsx cleanly",
        }
        decision = self.autoroute.decide(
            out,
            tool="Edit",
            args={"file_path": "src/Scene.jsx", "old_str": "const a = 1;", "new_str": "const a = 2;"},
            autoroute_on=True,
            seen_files=set(),
            replay_on=False,
            deliver_inflight=False,
        )
        self.assertTrue(decision["spawn"])
        self.assertEqual(decision["intent"]["edit"]["old_string"], "const a = 1;")
        self.assertEqual(decision["intent"]["edit"]["new_string"], "const a = 2;")

        # Single-flight lock must suppress duplicate spawn
        inflight_decision = self.autoroute.decide(
            out,
            tool="Edit",
            args={"file_path": "src/Scene.jsx", "old_str": "const a = 1;", "new_str": "const a = 2;"},
            autoroute_on=True,
            seen_files=set(),
            replay_on=False,
            deliver_inflight=True,
        )
        self.assertFalse(inflight_decision["spawn"])


if __name__ == "__main__":
    unittest.main()
