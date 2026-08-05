#!/usr/bin/env python3
"""Two holes found by breaking the guard for real, not by reading it.

FINDING 1 — the fail-closed net was blind to Bash.
    SEC_SENSITIVE in uap-policy-gate.sh scanned only the file_path argument. For
    every Bash call it was therefore 0 unless the command set a bypass var, so
    the "self-protect errored => fail closed" branch never fired for shell
    operations. Deleting .policy-tools/_common.py broke all 29 materialized
    enforcers at import (each does `from _common import ...`), and the very next
    `>> .uap/evidence/reads.log` was ALLOWED. That is a live, verified bypass of
    the control that guards the enforcement surface itself.

FINDING 2 — argument indirection walked past the text scan.
    `rm .policy-tools/x` was blocked. `xargs rm < list` was not, because the
    path never appears at a destructive verb's command position — the only place
    the per-segment scan looks. This is how _common.py actually got deleted.

Both are the same shape as the `G=git; $G push` gap already documented for
expert-review-required: the guard reads command TEXT, the shell resolves VALUES.
The residual (a path hidden in a shell variable) is accepted deliberately —
refusing every destructive command containing a variable would block ordinary
work for no real gain. The gate's fail-closed and the _common.py self-heal are
what cover it.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ENFORCERS = ROOT / "src" / "policies" / "enforcers"
SELF_PROTECT = ENFORCERS / "enforcement_self_protect.py"
GATE = ROOT / ".claude" / "hooks" / "uap-policy-gate.sh"
GATE_COPIES = [
    ROOT / ".claude" / "hooks" / "uap-policy-gate.sh",
    ROOT / ".factory" / "hooks" / "uap-policy-gate.sh",
    ROOT / ".omp" / "hooks" / "uap-policy-gate.sh",
    ROOT / "templates" / "hooks" / "uap-policy-gate.sh",
]


def run_enforcer(op, args, root):
    env = dict(os.environ)
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    env["PYTHONPATH"] = str(ENFORCERS)
    env.pop("UAP_SELF_PROTECT_OFF", None)
    p = subprocess.run(
        [sys.executable, str(SELF_PROTECT), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=env, cwd=str(root),
    )
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"allowed": True, "reason": f"<unparseable {p.stdout!r} {p.stderr!r}>"}


def blocked(cmd, root):
    return run_enforcer("Bash", {"command": cmd}, root)["allowed"] is False


class TestIndirectionIsNotAnEscape(unittest.TestCase):
    """A destructive op must not become invisible by moving its target."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".policy-tools").mkdir()
        self.list = self.root / "orphans.txt"
        self.list.write_text(".policy-tools/aaa_enforcement_self_protect.py\n"
                             ".policy-tools/_common.py\n")
        self.harmless = self.root / "harmless.txt"
        self.harmless.write_text("/tmp/a.log\n/tmp/b.log\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_targets_read_from_a_file_are_resolved(self):
        # The exact command that deleted _common.py and disabled every enforcer.
        self.assertTrue(blocked("xargs rm -v < orphans.txt", self.root))
        self.assertTrue(blocked("cat orphans.txt | xargs -n1 rm -f", self.root))
        self.assertTrue(blocked("rm $(cat orphans.txt)", self.root))

    def test_target_in_a_different_segment_is_resolved(self):
        # The per-segment scan sees `echo <path>` (harmless verb) and `xargs rm`
        # (no path) and clears both. The command as a whole is a deletion.
        self.assertTrue(blocked("echo .policy-tools/x.py | xargs rm", self.root))
        self.assertTrue(blocked("head -1 orphans.txt | xargs rm", self.root))

    def test_eval_does_not_launder_the_verb(self):
        self.assertTrue(blocked("eval rm .policy-tools/_common.py", self.root))

    def test_direct_forms_still_blocked(self):
        # The narrowing must not cost the coverage that already worked.
        self.assertTrue(blocked("rm .policy-tools/_common.py", self.root))
        self.assertTrue(blocked("rm -rf src/policies/enforcers", self.root))
        self.assertTrue(blocked("echo x >> .uap/evidence/reads.log", self.root))

    def test_ordinary_work_still_allowed(self):
        # Over-blocking is a real cost: an indirection construct plus ANY
        # destructive verb is common in normal shell use.
        for cmd in (
            "xargs rm < harmless.txt",
            "cat notes.md | xargs echo",
            "rm -rf node_modules",
            "rm $TMPDIR/scratch",
            "find . -name '*.ts' | xargs grep -l foo",
            "echo 'do not rm .policy-tools/x'",
            "npm run build",
        ):
            self.assertFalse(blocked(cmd, self.root), cmd)

    def test_unreadable_source_does_not_crash_or_block(self):
        self.assertFalse(blocked("xargs rm < nope-missing.txt", self.root))


class TestGateFailsClosedOnShellOps(unittest.TestCase):
    """SEC_SENSITIVE decides whether a broken enforcer fails closed."""

    SNIPPET_START = ('SEC_SENSITIVE="$(printf \'%s\' "$ARGS" | '
                     'TOOL="$TOOL" python3 -c \'')
    SNIPPET_END = "' 2>/dev/null || echo 1)\""

    def sensitive(self, args, tool="Bash"):
        text = GATE.read_text()
        i = text.index(self.SNIPPET_START) + len(self.SNIPPET_START)
        code = text[i:text.index(self.SNIPPET_END, i)]
        p = subprocess.run([sys.executable, "-c", code], input=json.dumps(args),
                           capture_output=True, text=True,
                           env={"TOOL": tool, "PATH": "/usr/bin:/bin"})
        return p.stdout.strip() == "1"

    def test_shell_ops_touching_the_surface_are_sensitive(self):
        # Each of these was 0 before: the command string was never scanned.
        for cmd in (
            "rm .policy-tools/_common.py",
            "echo x >> .uap/evidence/reads.log",
            "cp /dev/null .uap.json",
            "sed -i s/x/y/ src/policies/enforcers/a.py",
            "vi .claude/hooks/uap-policy-gate.sh",
        ):
            self.assertTrue(self.sensitive({"command": cmd}), cmd)

    def test_relative_paths_match(self):
        # The markers are slash-anchored ("/.policy-tools/"), so a bare relative
        # path needs the same normalisation the file_path argument gets. Missing
        # this silently dropped exactly the deletions above.
        self.assertTrue(self.sensitive({"command": "rm .policy-tools/x.py"}))
        self.assertTrue(self.sensitive({"command": "rm ./.policy-tools/x.py"}))

    def test_ordinary_shell_work_is_not_sensitive(self):
        for cmd in ("npm run build", "git status --short", "rm -rf node_modules", "ls -la"):
            self.assertFalse(self.sensitive({"command": cmd}), cmd)

    def test_file_path_coverage_unchanged(self):
        self.assertTrue(self.sensitive({"file_path": "/r/src/policies/enforcers/a.py"}, "Edit"))
        self.assertFalse(self.sensitive({"file_path": "/r/src/cli/memory.ts"}, "Edit"))


class TestGateSelfHealsItsHelper(unittest.TestCase):
    def test_every_copy_restores_common_and_fails_closed(self):
        # _common.py is a single point of failure for all 29 enforcers, so the
        # gate repairs it before enforcing rather than only noticing it is gone.
        for gate in GATE_COPIES:
            src = gate.read_text()
            self.assertIn("_common.py", src, f"{gate}: no helper check")
            self.assertIn("enforcer helper _common.py missing", src,
                          f"{gate}: no fail-closed for an unrecoverable helper")

    def test_all_gate_copies_are_identical(self):
        # Hook drift has shipped fixes that never reached the templates before.
        bodies = {g.read_text() for g in GATE_COPIES if g.is_file()}
        self.assertEqual(len(bodies), 1, "gate copies have drifted apart")


if __name__ == "__main__":
    unittest.main()
