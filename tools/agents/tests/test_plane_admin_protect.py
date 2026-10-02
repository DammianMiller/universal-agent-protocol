"""Tests for plane-admin-protect: credential-mutation guard on the Plane stack.

Covers the three things that make this enforcer trustworthy:
  - it catches the observed incident spelling (docker exec ... changepassword)
    and the bash -c wrapper,
  - it does NOT refuse commands that merely NAME a credential verb in prose
    (commit message, memory store, heredoc body) — the false positives that
    make an agent route around a gate,
  - the owner waiver fails CLOSED (exit 2, allowed=false) on expired / missing
    expiry / unreadable, rather than crashing (exit 1) or silently allowing.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "plane_admin_protect.py"

MUTATION = "docker exec plane-app-api-1 python manage.py changepassword admin@pay2u.com.au"


def run(root, command, op="Bash"):
    e = dict(os.environ)
    e["UAP_REPO_ROOT"] = str(root)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", op,
         "--args", json.dumps({"command": command})],
        capture_output=True, text=True, env=e,
    )
    out = json.loads(p.stdout) if p.stdout.strip() else {}
    return p.returncode, out


def write_waiver(root, days):
    w = root / "policies" / "waivers" / "plane-admin-reset"
    w.parent.mkdir(parents=True, exist_ok=True)
    w.write_text(f"owner approved reset\nexpires: {(date.today() + timedelta(days=days)).isoformat()}\n")
    return w


class PlaneAdminProtectTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_non_shell_operation_allowed(self):
        rc, out = run(self.root, MUTATION, op="Edit")
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])

    def test_observed_incident_blocked(self):
        rc, out = run(self.root, MUTATION)
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])
        self.assertIn("changepassword", out["reason"])
        self.assertEqual(out.get("route"), "owner-waiver")
        self.assertIn("waiverHint", out)

    def test_bash_c_wrapped_mutation_blocked(self):
        rc, out = run(self.root, 'bash -c "docker exec plane-app-api-1 manage.py set_password admin"')
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])

    def test_read_only_plane_command_allowed(self):
        rc, out = run(self.root, "kubectl logs plane-app-worker")
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])

    def test_prose_naming_verb_not_blocked(self):
        rc, out = run(self.root, 'git commit -m "refused to passwd /opt/plane admin"')
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])
        rc, out = run(self.root, 'uap memory store "never set_password on plane-db"')
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])

    def test_heredoc_body_naming_verb_not_blocked(self):
        cmd = "python3 - <<PY\n# would createsuperuser on plane-db\nprint(1)\nPY"
        rc, out = run(self.root, cmd)
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])

    def test_valid_waiver_allows(self):
        write_waiver(self.root, 3)
        rc, out = run(self.root, MUTATION)
        self.assertEqual(rc, 0)
        self.assertTrue(out["allowed"])
        self.assertIn("waiver valid until", out["reason"])

    def test_expired_waiver_fails_closed(self):
        write_waiver(self.root, -3)
        rc, out = run(self.root, MUTATION)
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])
        self.assertIn("expired", out["reason"])

    def test_waiver_missing_expiry_fails_closed(self):
        w = self.root / "policies" / "waivers" / "plane-admin-reset"
        w.parent.mkdir(parents=True, exist_ok=True)
        w.write_text("owner approved reset\n")
        rc, out = run(self.root, MUTATION)
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])
        self.assertIn("expires", out["reason"])

    def test_unreadable_waiver_fails_closed_not_crash(self):
        w = write_waiver(self.root, 3)
        w.chmod(0)
        try:
            rc, out = run(self.root, MUTATION)
        finally:
            w.chmod(0o644)
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])
        self.assertIn("could not be read", out["reason"])


if __name__ == "__main__":
    unittest.main()