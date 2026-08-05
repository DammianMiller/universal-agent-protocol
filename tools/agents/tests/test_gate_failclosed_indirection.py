#!/usr/bin/env python3
"""The enforcement surface must not be reachable by moving the target around.

Two holes, both found by breaking the guard for real rather than reading it:

FINDING 1 — the fail-closed net was blind to Bash.
    SEC_SENSITIVE in uap-policy-gate.sh scanned only the file_path argument, so
    for every Bash call it was 0 unless the command set a bypass var, and the
    "self-protect errored => fail closed" branch never fired for shell ops.
    Deleting .policy-tools/_common.py broke all 29 materialized enforcers at
    import (each does `from _common import ...`) and the next append into
    .uap/evidence/ was ALLOWED.

FINDING 2 — argument indirection walked past the text scan.
    A direct removal naming the path was blocked; the same removal taking its
    targets from a file or a pipe was not. That is how _common.py was deleted.

The first fix for Finding 2 answered the WRONG QUESTION — "is a protected path
mentioned anywhere in this command" — and a parallel review caught it blocking
six ordinary commands (`cp package.json /tmp/x-$(date +%s).json` trips because
package.json NAMES src/policies/...) while five trivial variants still walked
through. It now answers "will a protected path be an ARGUMENT to something
destructive", resolving the argument set where that is knowable and refusing to
guess where it is not.

ACCEPTED RESIDUALS, asserted below so they are decisions and not surprises:
  - a path held in shell state (`P=.policy-tools; rm $P/x`) is unreachable by
    any scan of command TEXT;
  - `grep ... | xargs sed` is allowed, because grep's output is not knowable
    here and guessing from the pattern text is what broke ordinary refactors.
Both are covered by the gate's fail-closed and the _common.py self-heal.
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
        capture_output=True, text=True, env=env, cwd=str(root), timeout=30,
    )
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"allowed": True, "reason": f"<unparseable {p.stdout!r} {p.stderr!r}>"}


class _Sandbox(unittest.TestCase):
    """A repo-shaped tmpdir with the argument-source fixtures the cases use."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".policy-tools").mkdir()
        (self.root / "LIST").write_text(".policy-tools/_common.py\n")
        # One exempt line used to make every other line invisible.
        (self.root / "POISONED").write_text(
            ".policy-tools/_common.py\npolicies/waivers/ok\n")
        (self.root / "TARGET").write_text(".uap/evidence/reads.log\n")
        (self.root / "HARMLESS").write_text("/tmp/a.log\n/tmp/b.log\n")
        # Larger than the read cap: the cap must bound the READ, not skip the
        # file, or padding a list is a one-line bypass.
        (self.root / "PADDED").write_text(
            ".policy-tools/_common.py\n" + "x" * 200_000)
        # Real repo files whose CONTENTS mention protected paths. Naming one of
        # these in an ordinary command must not block it.
        for name in ("package.json", ".gitignore", "CHANGELOG.md"):
            (self.root / name).write_text("mentions src/policies/ and .policy-tools/\n")

    def tearDown(self):
        self._tmp.cleanup()

    def assertBlocked(self, cmd):
        self.assertFalse(run_enforcer("Bash", {"command": cmd}, self.root)["allowed"], cmd)

    def assertAllowed(self, cmd):
        self.assertTrue(run_enforcer("Bash", {"command": cmd}, self.root)["allowed"], cmd)


class TestIndirectionIsNotAnEscape(_Sandbox):
    def test_targets_read_from_a_file(self):
        self.assertBlocked("xargs rm -v < LIST")
        self.assertBlocked("cat LIST | xargs -n1 rm -f")
        self.assertBlocked("head -1 LIST | xargs rm")
        self.assertBlocked("rm $(cat LIST)")

    def test_target_in_a_different_pipeline_stage(self):
        self.assertBlocked("echo .policy-tools/x.py | xargs rm")

    def test_shell_wrappers_do_not_launder_the_verb(self):
        # `bash -c` was the reviewer's headline miss: not a destructive verb, and
        # the payload never reached the per-segment scan.
        self.assertBlocked('bash -c "rm .policy-tools/_common.py"')
        self.assertBlocked('sh -c "rm .policy-tools/_common.py"')
        self.assertBlocked("env rm .policy-tools/_common.py")
        self.assertBlocked("eval rm .policy-tools/_common.py")

    def test_xargs_arg_file_flags(self):
        self.assertBlocked("xargs --arg-file=LIST rm")
        self.assertBlocked("xargs -a LIST rm")

    def test_cd_then_destructive(self):
        # The path and the verb sat in different segments, so neither looked bad.
        self.assertBlocked("cd .policy-tools && rm -f _common.py")

    def test_redirect_target_from_a_substitution(self):
        # Forging gate evidence, laundered through the indirection this fix is
        # about: `>` is not a verb, so the destructive-intent check must count it.
        self.assertBlocked('echo hi > "$(cat TARGET)"')

    def test_exempt_path_does_not_dilute_the_rest(self):
        # PROTECTED_EXEMPT was evaluated over the whole blob, so appending one
        # innocuous line to a deletion list disabled the check entirely.
        self.assertBlocked("xargs rm < POISONED")
        self.assertBlocked("rm -rf .policy-tools # policies/waivers")

    def test_oversized_source_is_still_examined(self):
        # The cap used to SKIP the file, making pad-to-bypass a one-liner.
        self.assertBlocked("xargs rm < PADDED")

    def test_direct_forms_still_blocked(self):
        self.assertBlocked("rm .policy-tools/_common.py")
        self.assertBlocked("rm -rf src/policies/enforcers")
        self.assertBlocked("echo x >> .uap/evidence/reads.log")
        self.assertBlocked("chmod 000 .policy-tools/x.py")


class TestOrdinaryWorkIsNotBlocked(_Sandbox):
    """Over-blocking is the expensive failure: it makes people disable the gate.

    Every command here was BLOCKED by the first implementation and verified by
    execution before this suite existed.
    """

    def test_commands_naming_a_file_whose_contents_mention_protected_paths(self):
        self.assertAllowed("cp package.json /tmp/x-$(date +%s).json")
        self.assertAllowed("cp .gitignore /tmp/g.bak")
        self.assertAllowed("cp CHANGELOG.md /tmp/c.md")

    def test_prose_that_merely_names_a_removal(self):
        self.assertAllowed('git commit -m "fix: block xargs rm against .policy-tools/"')
        self.assertAllowed('echo "do not rm .policy-tools/x $(date)"')

    def test_unknowable_producer_is_allowed_not_guessed(self):
        # grep's output cannot be known here. Inferring it from the pattern text
        # blocked ordinary refactors, so this is a deliberate allow.
        self.assertAllowed("grep -rl policies/ docs/ | xargs sed -i s/a/b/")
        self.assertAllowed("find docs -name '*.md' | xargs grep -l .uap.json")

    def test_everyday_commands(self):
        for cmd in ("rm -rf node_modules", "npm run build", "git status --short",
                    "npm test 2>&1 | tee /tmp/t.log", "xargs rm < HARMLESS",
                    "xargs rm < MISSING-FILE", "echo 0 > .uap/verify-cadence",
                    "cat .uap/pending-deliver.jsonl"):
            self.assertAllowed(cmd)

    def test_accepted_residual_is_asserted_not_assumed(self):
        # Documented limit: shell state is not resolvable from command text.
        # Asserted so a future change that "fixes" it must do so deliberately.
        self.assertAllowed("rm $TMPDIR/scratch")


class TestGateSensitivity(unittest.TestCase):
    """SEC_SENSITIVE decides whether a BROKEN enforcer fails closed."""

    START = 'SEC_SENSITIVE="$(printf \'%s\' "$ARGS" | TOOL="$TOOL" python3 -c \''
    END = "' 2>/dev/null || echo 1)\""

    def sensitive(self, args, tool="Bash"):
        text = GATE.read_text()
        i = text.index(self.START) + len(self.START)
        code = text[i:text.index(self.END, i)]
        p = subprocess.run([sys.executable, "-c", code], input=json.dumps(args),
                           capture_output=True, text=True, timeout=30,
                           env={"TOOL": tool, "PATH": "/usr/bin:/bin"})
        return p.stdout.strip() == "1"

    def test_shell_ops_touching_the_surface(self):
        for cmd in ("rm .policy-tools/_common.py",
                    "echo x >> .uap/evidence/reads.log",
                    "cp /dev/null .uap.json",
                    "sed -i s/x/y/ src/policies/enforcers/a.py",
                    "vi .claude/hooks/uap-policy-gate.sh"):
            self.assertTrue(self.sensitive({"command": cmd}), cmd)

    def test_directory_and_quoted_forms(self):
        # Markers are slash-terminated, so a plain substring test missed the
        # DIRECTORY forms — the most destructive commands scored 0.
        for cmd in ("rm -rf .policy-tools", "rm -rf src/policies", "rm -rf .uap",
                    'rm ".policy-tools/_common.py"', "rm ./.policy-tools/x.py"):
            self.assertTrue(self.sensitive({"command": cmd}), cmd)

    def test_readonly_commands_do_not_arm_fail_closed(self):
        # Arming these turns `cat .uap.json` into a hard block on any checkout
        # where self-protect is not attached — a state this repo has been in.
        for cmd in ("cat .uap.json", "grep -r foo policies/", "ls -la .policy-tools/"):
            self.assertFalse(self.sensitive({"command": cmd}), cmd)

    def test_ordinary_shell_work(self):
        for cmd in ("npm run build", "git status --short", "rm -rf node_modules"):
            self.assertFalse(self.sensitive({"command": cmd}), cmd)

    def test_file_path_coverage_unchanged(self):
        self.assertTrue(self.sensitive({"file_path": "/r/src/policies/enforcers/a.py"}, "Edit"))
        self.assertFalse(self.sensitive({"file_path": "/r/src/cli/memory.ts"}, "Edit"))


class TestGateEndToEnd(unittest.TestCase):
    """Runs the REAL gate script. The previous version grepped for strings — it
    would have passed against a `cp` with its arguments swapped."""

    PID = "11111111-1111-1111-1111-111111111111"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.sb = Path(self._tmp.name)
        for d in (".policy-tools", "agents/data/memory", "src/policies/enforcers",
                  ".uap/evidence", ".claude/hooks"):
            (self.sb / d).mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q"], cwd=self.sb, capture_output=True)

        helper = (
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
        (self.sb / "src/policies/enforcers/_common.py").write_text(helper)
        (self.sb / ".policy-tools/_common.py").write_text(helper)
        (self.sb / f".policy-tools/{self.PID}_enforcement_self_protect.py").write_text(
            "import sys\n"
            "from pathlib import Path\n"
            "sys.path.insert(0, str(Path(__file__).parent))\n"
            "from _common import emit, parse_cli\n"   # dies if the helper is gone
            "op, args = parse_cli()\n"
            "if op in ('Bash', 'bash') and '.uap/evidence' in (args.get('command') or ''):\n"
            "    emit(False, 'BLOCKED')\n"
            "emit(True, 'ok')\n"
        )
        import sqlite3
        db = sqlite3.connect(self.sb / "agents/data/memory/policies.db")
        db.execute("CREATE TABLE policies (id TEXT, name TEXT, category TEXT, level TEXT,"
                   " rawMarkdown TEXT, convertedFormat TEXT, executableTools TEXT, tags TEXT,"
                   " createdAt TEXT, updatedAt TEXT, version INT, isActive INT, priority INT,"
                   " enforcementStage TEXT)")
        db.execute("CREATE TABLE executable_tools (id TEXT, policyId TEXT, toolName TEXT,"
                   " code TEXT, language TEXT, createdAt TEXT)")
        db.execute("CREATE TABLE policy_executions (id TEXT)")
        db.execute("INSERT INTO policies VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,'pre-exec')",
                   (self.PID, "Enforcement Self-Protect", "security", "REQUIRED",
                    "# Enforcement Self-Protect", "", "", "", "", ""))
        db.execute("INSERT INTO executable_tools VALUES (?,?,?,?,?,?)",
                   ("t1", self.PID, "enforcement_self_protect", "", "python", ""))
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
        p = subprocess.run(["bash", str(dst)], input=payload, capture_output=True,
                           text=True, cwd=self.sb, timeout=120)
        return p.returncode

    def test_blocks_when_the_surface_is_healthy(self):
        self.assertEqual(self.gate("echo x >> .uap/evidence/reads.log"), 2)

    def test_helper_is_restored_and_the_op_still_blocked(self):
        # THE INCIDENT: with the helper gone every enforcer dies at import, and
        # the write was allowed. The gate must repair and still block.
        (self.sb / ".policy-tools/_common.py").unlink()
        rc = self.gate("echo x >> .uap/evidence/reads.log")
        self.assertTrue((self.sb / ".policy-tools/_common.py").is_file(),
                        "helper was not restored")
        self.assertEqual(rc, 2)

    def test_fails_closed_when_the_helper_cannot_be_restored(self):
        (self.sb / ".policy-tools/_common.py").unlink()
        (self.sb / "src/policies/enforcers/_common.py").unlink()
        self.assertEqual(self.gate("echo x >> .uap/evidence/reads.log"), 2)

    def test_stays_fail_soft_for_ordinary_work(self):
        # The other half of the contract: a broken surface must not wedge
        # everything. This is what pins the `set -e` behaviour of the new block.
        (self.sb / ".policy-tools/_common.py").unlink()
        (self.sb / "src/policies/enforcers/_common.py").unlink()
        self.assertEqual(self.gate("npm run build"), 0)


class TestGateCopiesStayInSync(unittest.TestCase):
    def test_every_copy_exists_and_is_identical(self):
        # Hook drift has shipped fixes that never reached templates/. `is_file`
        # was previously filtered, so a DELETED copy passed silently.
        for g in GATE_COPIES:
            self.assertTrue(g.is_file(), f"missing gate copy: {g}")
        self.assertEqual(len({g.read_text() for g in GATE_COPIES}), 1,
                         "gate copies have drifted apart")


if __name__ == "__main__":
    unittest.main()
