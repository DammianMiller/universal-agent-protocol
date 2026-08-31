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

    def test_blocks_edit_to_policies_db(self):
        # The inversion fix (F2): the enforcement registry the gates READ must
        # be at least as protected as the artifact paths the gates demand.
        rc, out = run("Edit", {"file_path": str(REPO / "agents/data/memory/policies.db")})
        self.assertEqual(rc, 2)
        self.assertFalse(out["allowed"])

    def test_blocks_bash_rm_policies_db(self):
        rc, out = run("Bash", {"command": "rm -f agents/data/memory/policies.db"})
        self.assertEqual(rc, 2)

    def test_allows_uap_policy_cli_bash(self):
        # Policy management goes through the CLI process, not direct file ops;
        # a command that merely RUNS `uap policy` must not trip the DB guard.
        rc, out = run("Bash", {"command": "uap policy list"})
        self.assertEqual(rc, 0)

    def test_blocks_edit_to_operator_overrides(self):
        # F3: the signed override file is operator-only; the "/.uap/" marker
        # already refuses Edit/Write. Pin it so a future carve-out cannot
        # silently reopen the self-mint path.
        rc, out = run("Write", {"file_path": str(REPO / ".uap/operator-overrides.json")})
        self.assertEqual(rc, 2)

    def test_blocks_bash_redirect_creating_operator_overrides(self):
        # F3: the file-op marker does not cover shell redirects — without this
        # target entry `echo …> .uap/operator-overrides.json` self-mints the
        # bypass the file exists to restrict to the operator.
        rc, out = run("Bash", {"command": 'echo "{}" > .uap/operator-overrides.json'})
        self.assertEqual(rc, 2)

    def test_blocks_bash_rm_operator_overrides(self):
        rc, out = run("Bash", {"command": "rm -f .uap/operator-overrides.json"})
        self.assertEqual(rc, 2)

    def test_blocks_bash_forging_liveness_cache(self):
        # F1: the degrade consult trusts this file — a forged entry downgrades
        # a blocking policy to advisory, so writing it directly must be refused.
        # The legitimate writer is `uap policy liveness`, whose command text
        # never names the file.
        rc, out = run("Bash", {"command": 'echo "{}" > .uap/policy-liveness.json'})
        self.assertEqual(rc, 2)

    def test_allows_uap_policy_liveness_cli(self):
        rc, out = run("Bash", {"command": "uap policy liveness --quiet"})
        self.assertEqual(rc, 0)

    def test_allows_reading_operator_overrides(self):
        rc, out = run("Bash", {"command": "cat .uap/operator-overrides.json"})
        self.assertEqual(rc, 0)

    def test_blocks_python_minting_operator_overrides(self):
        # Security review (deliver-hardening, 2026-07-13): an interpreter-
        # mediated write carries no destructive verb and no redirect, so the
        # redirect/verb scans miss it — and before the root-ownership check
        # this one command minted a full bypass. Blocked on sight now.
        rc, out = run("Bash", {"command":
            'python3 -c \'import json; json.dump({"deliverBypass": True}, open(".uap/operator-overrides.json", "w"))\''})
        self.assertEqual(rc, 2)

    def test_blocks_python_forging_liveness_cache(self):
        rc, out = run("Bash", {"command":
            'python3 -c \'open(".uap/policy-liveness.json", "w").write("{}")\''})
        self.assertEqual(rc, 2)

    def test_blocks_node_writing_trust_anchor(self):
        rc, out = run("Bash", {"command":
            'node -e \'require("fs").writeFileSync(".uap/operator-overrides.json", "{}")\''})
        self.assertEqual(rc, 2)

    def test_blocks_bash_c_wrapped_python_mint(self):
        # The rule fires on the full command text, so a shell wrapper does not
        # hide the write.
        rc, out = run("Bash", {"command":
            'bash -c "python3 -c \'open(".uap/operator-overrides.json", "w")\'"'})
        self.assertEqual(rc, 2)

    def test_allows_python_READING_a_trust_anchor(self):
        # Reads must stay cheap: no write primitive, no interpreter-write rule.
        rc, out = run("Bash", {"command":
            'python3 -c \'import json; print(json.load(open(".uap/policy-liveness.json")))\''})
        self.assertEqual(rc, 0)

    def test_allows_python_write_to_ordinary_uap_state(self):
        # The narrow list is deliberate: runtime state under .uap/ stays
        # writable, only the two trust anchors get the interpreter rule.
        rc, out = run("Bash", {"command":
            'python3 -c \'open(".uap/verify-cadence", "w").write("0")\''})
        self.assertEqual(rc, 0)

    def test_blocks_bash_setting_bypass(self):
        rc, out = run("Bash", {"command": "export UAP_DELIVER_BYPASS=1 && echo hi"})
        self.assertEqual(rc, 2)

    def test_blocks_bash_advisory_relax(self):
        rc, out = run("Bash", {"command": "UAP_ENFORCE_DELIVERY=advisory uap deliver x"})
        self.assertEqual(rc, 2)

    def test_blocks_inline_single_flight_bypass(self):
        """Single-flight is a DATA-SAFETY control, not a preference.

        deliver runs each candidate in a git worktree, and two runs against one
        repo are not safe together. Observed live (octopus_invaders_v3,
        2026-07-31): the agent ran `UAP_DELIVER_NO_LOCK=1 uap deliver ...`, two
        runs overlapped for seven minutes, and the untracked tree they were both
        building disappeared. It had never been committed, so nothing could
        recover it.
        """
        rc, out = run("Bash", {"command": "UAP_DELIVER_NO_LOCK=1 uap deliver -- build it"})
        self.assertEqual(rc, 2)

    def test_blocks_exported_single_flight_bypass(self):
        rc, out = run("Bash", {"command": "export UAP_DELIVER_NO_LOCK=1 && uap deliver -- x"})
        self.assertEqual(rc, 2)

    def test_allows_merely_mentioning_the_override(self):
        # The env var remains a real OPERATOR hatch; only the agent writing it
        # into its own command line is refused. Talking about it is not doing it.
        rc, out = run("Bash", {"command": "echo 'UAP_DELIVER_NO_LOCK is an operator override'"})
        self.assertEqual(rc, 0)

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
