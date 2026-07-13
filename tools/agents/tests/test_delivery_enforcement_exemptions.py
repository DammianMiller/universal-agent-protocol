#!/usr/bin/env python3
"""EXEMPT_PREFIXES must exempt ONLY what is genuinely un-routable.

`scripts/` and `docs/` used to be exempt — but shell/Python under scripts/ EXECUTES.
It is code, so it must route through deliver and be tested like any other source.
Exempting it left an entire language silently ungated: a model could put its whole
implementation in scripts/ and never be validated.

What remains exempt is deliberate:
  * agent/enforcement infra (.uap/ .opencode/ .claude/ .policy-tools/ …) — the
    hooks that RUN the gate; routing them is a bootstrap deadlock. Guarded by
    enforcement-self-protect instead.
  * src/policies/, policies/ — the policy definitions themselves (same self-reference).
  * test/, tests/ — the deliberate fast feedback loop.
"""
import json, os, subprocess, sys, unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"


def run(path):
    e = {**os.environ, "UAP_ENFORCE_DELIVERY": "block", "UAP_INFERENCE_ENDPOINT": "http://172.17.0.1:8080/v1"}
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE", "UAP_DELIVER_LOCAL_ADVISORY"):
        e.pop(k, None)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", "Write",
         "--args", json.dumps({"file_path": path, "content": "x" * 2000})],
        capture_output=True, text=True, env=e, cwd=str(ENF.parents[3]),
    )
    return p.returncode, p.stdout


class TightenedExemptionsTest(unittest.TestCase):
    def test_scripts_and_docs_are_now_GATED(self):
        # These execute — they are code and must route through deliver.
        for path in ("scripts/deploy.sh", "scripts/build.py", "scripts/tool.ts", "docs/example.py"):
            code, out = run(path)
            self.assertEqual(code, 2, f"{path} must be GATED (it is code) — got {out}")
            self.assertIn("route", out, path)

    def test_agent_enforcement_infra_stays_exempt(self):
        # Routing the hooks that RUN the gate is a bootstrap deadlock; these are
        # guarded by enforcement-self-protect, not by delivery routing.
        for path in (".uap/hook.py", ".opencode/plugin.ts", ".claude/hooks/x.sh", ".policy-tools/e.py"):
            code, out = run(path)
            self.assertEqual(code, 0, f"{path} must stay exempt — got {out}")

    def test_policy_definitions_stay_exempt(self):
        for path in ("src/policies/enforcers/x.py", "policies/custom.py"):
            code, out = run(path)
            self.assertEqual(code, 0, f"{path} must stay exempt — got {out}")

    def test_test_dirs_stay_exempt(self):
        # Deliberate fast feedback loop; deliver still verifies them via the ladder.
        for path in ("test/helper.ts", "tests/fixtures/data.py"):
            code, out = run(path)
            self.assertEqual(code, 0, f"{path} must stay exempt — got {out}")

    def test_ordinary_source_still_gated(self):
        code, out = run("src/app.ts")
        self.assertEqual(code, 2, out)


if __name__ == "__main__":
    unittest.main()
