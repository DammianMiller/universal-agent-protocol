"""Tests for the enforcement-self-protect enforcer (R2)."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "enforcement_self_protect.py"
REPO = Path(__file__).resolve().parents[3]


def run(op, args, env=None):
    e = dict(os.environ)
    e["UAP_REPO_ROOT"] = str(REPO)
    e.pop("UAP_SELF_PROTECT_OFF", None)
    if env:
        e.update(env)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=e,
    )
    out = json.loads(p.stdout) if p.stdout.strip() else {}
    return p.returncode, out


import unittest


class SelfProtectTest(unittest.TestCase):
    def test_blocks_edit_to_policy_enforcer(self):
        rc, out = run("Write", {"file_path": str(REPO / "src/policies/enforcers/delivery_enforcement.py")})
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])

    def test_blocks_edit_to_uap_json(self):
        rc, out = run("Edit", {"file_path": str(REPO / ".uap.json")})
        self.assertEqual(rc, 2)

    def test_blocks_edit_to_policy_tools(self):
        rc, out = run("Write", {"file_path": str(REPO / ".policy-tools/abc_delivery_enforcement.py")})
        self.assertEqual(rc, 2)

    def test_blocks_bash_setting_bypass(self):
        rc, out = run("Bash", {"command": "export UAP_DELIVER_BYPASS=1 && echo hi"})
        self.assertEqual(rc, 2)

    def test_blocks_bash_advisory_relax(self):
        rc, out = run("Bash", {"command": "UAP_ENFORCE_DELIVERY=advisory uap deliver x"})
        self.assertEqual(rc, 2)

    def test_blocks_bash_rm_enforcer(self):
        rc, out = run("Bash", {"command": "rm -f .policy-tools/abc_delivery_enforcement.py"})
        self.assertEqual(rc, 2)

    def test_allows_normal_source_edit(self):
        rc, out = run("Write", {"file_path": str(REPO / "src/app/index.ts")})
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])

    def test_allows_normal_bash(self):
        rc, out = run("Bash", {"command": "npm test"})
        self.assertEqual(rc, 0)

    def test_operator_override_allows(self):
        rc, out = run("Bash", {"command": "export UAP_DELIVER_BYPASS=1"}, env={"UAP_SELF_PROTECT_OFF": "1"})
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
