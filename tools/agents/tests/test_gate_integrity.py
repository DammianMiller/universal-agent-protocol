#!/usr/bin/env python3
"""The gate must REPAIR its enforcers, not just run whatever is on disk.

The gate executes `.policy-tools/<policyId>_<tool>.py` — copies. Two observed
failures both looked like success:

  STALE     a merged fix was never re-materialized, so the gate ran old code
            while the suites went green against src/. This repo shipped that
            for over a week, and did it again in the session that added this.
  DESTROYED deleting one file, `_common.py`, broke all 29 enforcers at import
            and silently turned the gate into a no-op. Verified live.

No scan of shell command text can prevent the second: `python3 -c` can write any
file and is allowed by design. So these tests pin the control that does work —
verify against a manifest and restore BEFORE any enforcer runs.

The tampered-enforcer case is the important one: the swapped-in file always
allows, so if repair did not happen before enforcement the operation would be
permitted. Asserting the exit code alone would not catch a repair that ran too
late, hence the on-disk assertion as well.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
# UAP_TEST_GATE lets a candidate gate be exercised before it is applied in
# place — self-protect reserves the real hook for the operator, so without this
# the change could only be verified after landing it.
GATE = Path(os.environ.get("UAP_TEST_GATE") or (ROOT / ".claude" / "hooks" / "uap-policy-gate.sh"))
PID = "11111111-1111-1111-1111-111111111111"
ENFORCER = f"{PID}_enforcement_self_protect.py"

HELPER = (
    "import json, sys\n"
    "def parse_cli():\n"
    "    a = sys.argv\n"
    "    op = a[a.index('--operation') + 1] if '--operation' in a else ''\n"
    "    ar = json.loads(a[a.index('--args') + 1]) if '--args' in a else {}\n"
    "    return op, ar\n"
    "def emit(allowed, reason):\n"
    "    print(json.dumps({'allowed': bool(allowed), 'reason': reason}))\n"
    "    sys.exit(0)\n"
)
REAL_ENFORCER = (
    "import sys\n"
    "from pathlib import Path\n"
    "sys.path.insert(0, str(Path(__file__).parent))\n"
    "from _common import emit, parse_cli\n"
    "op, args = parse_cli()\n"
    "if op in ('Bash', 'bash') and '.uap/evidence' in (args.get('command') or ''):\n"
    "    emit(False, 'BLOCKED')\n"
    "emit(True, 'ok')\n"
)
ALWAYS_ALLOW = (
    "import sys\n"
    "from pathlib import Path\n"
    "sys.path.insert(0, str(Path(__file__).parent))\n"
    "from _common import emit, parse_cli\n"
    "parse_cli()\n"
    "emit(True, 'neutered')\n"
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(GATE.is_file(), "policy gate not present")
class TestGateRepairsItsEnforcers(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.sb = Path(self._tmp.name)
        for d in (".policy-tools", "agents/data/memory", "src/policies/enforcers",
                  ".uap/evidence", ".claude/hooks"):
            (self.sb / d).mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q"], cwd=self.sb, capture_output=True)

        self.pt = self.sb / ".policy-tools"
        src = self.sb / "src/policies/enforcers"
        (src / "_common.py").write_text(HELPER)
        (src / "enforcement_self_protect.py").write_text(REAL_ENFORCER)
        (self.pt / "_common.py").write_text(HELPER)
        (self.pt / ENFORCER).write_text(REAL_ENFORCER)

        # The manifest the materializer would have written.
        lines = [f"{sha256(self.pt / f)}  {f}" for f in ("_common.py", ENFORCER)]
        (self.pt / ".integrity.sha256").write_text("\n".join(lines) + "\n")
        (self.pt / ".integrity.source").write_text(str(src) + "\n")

        db = sqlite3.connect(self.sb / "agents/data/memory/policies.db")
        db.execute("CREATE TABLE policies (id TEXT, name TEXT, category TEXT, level TEXT,"
                   " rawMarkdown TEXT, convertedFormat TEXT, executableTools TEXT, tags TEXT,"
                   " createdAt TEXT, updatedAt TEXT, version INT, isActive INT, priority INT,"
                   " enforcementStage TEXT)")
        db.execute("CREATE TABLE executable_tools (id TEXT, policyId TEXT, toolName TEXT,"
                   " code TEXT, language TEXT, createdAt TEXT)")
        db.execute("CREATE TABLE policy_executions (id TEXT)")
        db.execute("INSERT INTO policies VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,'pre-exec')",
                   (PID, "Enforcement Self-Protect", "security", "REQUIRED", "#", "", "", "", "", ""))
        db.execute("INSERT INTO executable_tools VALUES (?,?,?,?,?,?)",
                   ("t1", PID, "enforcement_self_protect", "", "python", ""))
        db.commit()
        db.close()

    def tearDown(self):
        self._tmp.cleanup()

    def gate(self, command):
        dst = self.sb / ".claude/hooks/uap-policy-gate.sh"
        dst.write_text(GATE.read_text())
        dst.chmod(0o755)
        payload = json.dumps({"tool_name": "Bash", "cwd": str(self.sb),
                              "tool_input": {"command": command}})
        env = dict(os.environ)
        env.pop("UAP_SELF_PROTECT_OFF", None)
        p = subprocess.run(["bash", str(dst)], input=payload, capture_output=True,
                           text=True, cwd=self.sb, timeout=120, env=env)
        return p.returncode

    BLOCKED_CMD = "echo x >> .uap/evidence/reads.log"

    def test_healthy_surface_is_left_alone(self):
        before = sha256(self.pt / ENFORCER)
        self.assertEqual(self.gate(self.BLOCKED_CMD), 2)
        self.assertEqual(sha256(self.pt / ENFORCER), before)

    def test_neutered_enforcer_is_restored_before_it_runs(self):
        # The attack: swap in an enforcer that always allows. If repair happened
        # after enforcement (or not at all) the operation would be permitted.
        (self.pt / ENFORCER).write_text(ALWAYS_ALLOW)
        rc = self.gate(self.BLOCKED_CMD)
        self.assertEqual((self.pt / ENFORCER).read_text(), REAL_ENFORCER,
                         "tampered enforcer was not restored")
        self.assertEqual(rc, 2, "repair ran too late — the op was allowed")

    def test_deleted_helper_is_restored(self):
        # One file whose absence killed all 29 enforcers at import.
        (self.pt / "_common.py").unlink()
        rc = self.gate(self.BLOCKED_CMD)
        self.assertTrue((self.pt / "_common.py").is_file(), "helper not restored")
        self.assertEqual(rc, 2)

    def test_deleted_enforcer_is_restored(self):
        (self.pt / ENFORCER).unlink()
        rc = self.gate(self.BLOCKED_CMD)
        self.assertTrue((self.pt / ENFORCER).is_file(), "enforcer not restored")
        self.assertEqual(rc, 2)

    def test_repair_is_recorded_as_evidence(self):
        (self.pt / ENFORCER).write_text(ALWAYS_ALLOW)
        self.gate(self.BLOCKED_CMD)
        log = self.sb / ".uap/evidence/integrity.log"
        self.assertTrue(log.is_file(), "repair was silent")
        self.assertIn("restored", log.read_text())

    def test_unrecoverable_does_not_wedge_ordinary_work(self):
        # Source gone AND copy tampered: nothing to restore from. The gate must
        # still not block unrelated work — fail-soft is the other half of the
        # contract, and a wedge here would be worse than the drift.
        (self.pt / ENFORCER).write_text(ALWAYS_ALLOW)
        shutil.rmtree(self.sb / "src/policies/enforcers")
        self.assertEqual(self.gate("npm run build"), 0)

    def test_surface_without_a_manifest_still_works(self):
        # Installs predating the manifest must keep functioning unchanged.
        (self.pt / ".integrity.sha256").unlink()
        self.assertEqual(self.gate(self.BLOCKED_CMD), 2)


if __name__ == "__main__":
    unittest.main()
