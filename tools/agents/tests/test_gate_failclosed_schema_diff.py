"""The schema-diff gate's failure must not read as consent.

Two residuals left over from the inline-check pivot (PR #733), both in files
the agent that wrote that change could not edit:

  1. `UAP_SCHEMA_DIFF_INLINE=1` was the only gate switch of its shape absent
     from self-protect's BYPASS_PATTERNS. It no longer allows anything on its
     own -- it skips the inline checker and lands in the fallback -- but it
     still WEAKENS the control, and an inline assignment is written by the
     constrained party into its own command line. Every comparable switch
     (UAP_SELF_PROTECT_OFF, UAP_NO_REVIEW, UAP_DELIVER_NO_LOCK, ...) is
     refused inline for exactly that reason.

  2. uap-policy-gate.sh maps an errored or missing enforcer to ALLOW for
     everything except enforcement_self_protect. schema_diff_gate is the only
     thing standing between a breaking schema change and history, so a crash
     in it was a silent bypass. It now fails closed -- but only on a commit or
     push, so a broken schema enforcer cannot block every shell command in a
     session.

The drift test at the bottom is the one that will actually catch a regression:
the hook has NINE copies in this repo, and `uap worktree create` seeds new
worktrees from templates/hooks/, so patching only .claude/hooks/ silently
reverts the fix on the next worktree.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENFORCERS = REPO / "src" / "policies" / "enforcers"
SELF_PROTECT = ENFORCERS / "enforcement_self_protect.py"
PRIMARY_HOOK = REPO / ".claude" / "hooks" / "uap-policy-gate.sh"
HOOK_NAME = "uap-policy-gate.sh"


def hook_copies() -> list[Path]:
    """Every copy of the hook in this checkout.

    Exclusions are matched on the path RELATIVE to REPO. Matching the absolute
    path excluded the entire tree whenever REPO was itself a worktree, since
    every path under .worktrees/240-x/ contains ".worktrees" -- so this
    returned [] exactly where it runs, and the two sweeps below passed by
    iterating nothing. Caught by running it for real; a scratch copy in /tmp
    could not reproduce it.
    """
    tracked = subprocess.run(
        ["git", "ls-files", "--full-name", "*" + HOOK_NAME],
        cwd=REPO, capture_output=True, text=True,
    ).stdout.split()
    # TRACKED copies only. An rglob also swept `uap hooks install` output --
    # .uap/omp/ and .codex|.cursor|.forge|.opencode/hooks/ are all gitignored --
    # so on any machine whose installed hooks predate a change, the drift
    # assertions failed on files no PR can commit. What matters here is that
    # every copy the repo SHIPS stays in step, templates/hooks/ above all.
    return sorted(REPO / t for t in tracked if (REPO / t).is_file())


def run_self_protect(command: str, root: Path) -> tuple[bool, str]:
    env = {
        "UAP_REPO_ROOT": str(root),
        "UAP_WORKTREE_ROOT": str(root),
        "PYTHONPATH": str(ENFORCERS),
        "PATH": "/usr/bin:/bin",
    }
    r = subprocess.run(
        [sys.executable, str(SELF_PROTECT), "--operation", "Bash",
         "--args", json.dumps({"command": command})],
        cwd=root, env=env, capture_output=True, text=True, timeout=60,
    )
    try:
        payload = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return False, f"unparseable: {r.stdout[:120]}"
    return payload.get("allowed", True), payload.get("reason", "")


class InlineGuardIsABypassPattern(unittest.TestCase):
    def test_setting_it_inline_is_refused(self):
        allowed, reason = run_self_protect(
            "UAP_SCHEMA_DIFF_INLINE=1 git commit -m x", REPO
        )
        self.assertFalse(allowed, f"an inline off-switch must be refused: {reason}")

    def test_a_comparable_switch_behaves_the_same(self):
        """Anchors the assertion above to existing, agreed behaviour."""
        allowed, _ = run_self_protect("UAP_NO_REVIEW=1 git commit -m x", REPO)
        self.assertFalse(allowed)

    def test_merely_naming_the_variable_is_not_refused(self):
        """Docs, commit messages and greps must keep working.

        The pattern requires an assignment to 1, not the bare name -- the same
        distinction that made GATELESS_FLAG_RE scan `scannable_command`
        instead of raw text after bare flag names started refusing honest work.
        """
        for cmd in (
            "echo the UAP_SCHEMA_DIFF_INLINE guard is documented",
            "grep -rn UAP_SCHEMA_DIFF_INLINE src/",
        ):
            with self.subTest(cmd=cmd):
                allowed, reason = run_self_protect(cmd, REPO)
                self.assertTrue(allowed, f"{cmd} must stay allowed: {reason}")


class HookFailsClosedOnCommits(unittest.TestCase):
    """The hook's own logic, extracted and executed rather than eyeballed."""

    def commit_op(self, command: str) -> str:
        gate = PRIMARY_HOOK.read_text()
        start = 'COMMIT_OP="$(printf \'%s\' "$ARGS" | python3 -c \''
        end = "' 2>/dev/null || echo 1)\""
        i = gate.index(start) + len(start)
        code = gate[i:gate.index(end, i)]
        p = subprocess.run(
            [sys.executable, "-c", code],
            input=json.dumps({"command": command}),
            capture_output=True, text=True, timeout=30,
            env={"PATH": "/usr/bin:/bin"},
        )
        return p.stdout.strip()

    def must_fail_closed(self, tool: str, sec: str, commit: str) -> bool:
        gate = PRIMARY_HOOK.read_text()
        start = gate.index("must_fail_closed() {")
        fn = gate[start:gate.index("\n}\n", start) + 3]
        script = (
            "set -euo pipefail\n"
            f'SEC_SENSITIVE="{sec}"\nCOMMIT_OP="{commit}"\n'
            + fn
            + f'\nif must_fail_closed "{tool}"; then echo CLOSED; else echo open; fi\n'
        )
        p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, f"set -e tripped: {p.stderr[:200]}")
        return p.stdout.strip() == "CLOSED"

    def test_commit_and_push_are_recognised(self):
        for cmd in ("git commit -m x", "git push origin master", "git commit -am x && echo ok"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.commit_op(cmd), "1")

    def test_ordinary_commands_are_not(self):
        # Scoped deliberately: a broken schema enforcer must not turn every
        # shell command in the session into a hard block.
        for cmd in ("ls -la", "npm test", "cat README.md"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.commit_op(cmd), "0")

    def test_the_schema_gate_fails_closed_on_a_commit(self):
        self.assertTrue(self.must_fail_closed("schema_diff_gate", "0", "1"))

    def test_the_schema_gate_does_not_fail_closed_otherwise(self):
        self.assertFalse(self.must_fail_closed("schema_diff_gate", "0", "0"))

    def test_self_protect_keeps_its_existing_condition(self):
        self.assertTrue(self.must_fail_closed("enforcement_self_protect", "1", "0"))
        self.assertFalse(self.must_fail_closed("enforcement_self_protect", "0", "0"))

    def test_an_unrelated_enforcer_still_fails_open(self):
        """Widening this to every enforcer would be a session-wide deadlock."""
        self.assertFalse(self.must_fail_closed("worktree_required", "1", "1"))

    def test_the_hook_parses(self):
        for copy in hook_copies():
            with self.subTest(copy=str(copy.relative_to(REPO))):
                p = subprocess.run(["bash", "-n", str(copy)], capture_output=True, text=True)
                self.assertEqual(p.returncode, 0, p.stderr[:200])


class HookCopiesDoNotDrift(unittest.TestCase):
    """Nine copies, and the one that matters most is the one nobody edits.

    `uap worktree create` seeds a new worktree from templates/hooks/, so a fix
    applied only to .claude/hooks/ is reverted the next time anyone starts a
    branch -- a documented failure in this repo. Any change to the gate has to
    land in all of them.
    """

    def test_the_sweep_actually_finds_the_copies(self):
        """Guards the two sweeps below against passing on an empty list.

        hook_copies() returned [] in a worktree because its exclusions matched
        the absolute path, and both drift tests went green while checking
        nothing. An assertion about a collection is worthless without an
        assertion that the collection is non-empty.
        """
        found = hook_copies()
        self.assertGreaterEqual(
            len(found), 2,
            f"expected several hook copies under {REPO}, found {[str(p) for p in found]}",
        )
        self.assertIn(PRIMARY_HOOK, found)

    def test_every_copy_is_identical_to_the_primary(self):
        primary = PRIMARY_HOOK.read_text()
        for copy in hook_copies():
            with self.subTest(copy=str(copy.relative_to(REPO))):
                self.assertEqual(
                    copy.read_text(), primary,
                    f"{copy.relative_to(REPO)} has drifted from .claude/hooks/",
                )

    def test_the_template_copy_carries_the_fail_closed_logic(self):
        template = REPO / "templates" / "hooks" / HOOK_NAME
        self.assertTrue(template.is_file(), "templates/hooks copy is missing")
        self.assertIn(
            "must_fail_closed", template.read_text(),
            "new worktrees would be seeded with a gate that fails open",
        )

class FailClosedIsAuditable(unittest.TestCase):
    """The most serious verdict the gate can reach was the one leaving no trace.

    fail_closed() exits, and it exited before record_execution ever ran --
    measured, policy_executions was unchanged across a fail-closed block while
    ordinary blocks recorded. The compliance view therefore showed zero blocks
    for exactly the failure mode most worth seeing.
    """

    def fail_closed_fn(self) -> str:
        gate = PRIMARY_HOOK.read_text()
        start = gate.index("fail_closed() {")
        return gate[start:gate.index("\n}\n", start) + 3]

    def test_it_records_before_exiting(self):
        script = (
            "set -euo pipefail\n"
            'record_execution() { echo "RECORDED allowed=$1 policy=$2 reason=$3"; }\n'
            + self.fail_closed_fn()
            + '\nfail_closed "enforcer errored" "schema_diff_gate" || true\n'
        )
        p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertIn("RECORDED allowed=0", p.stdout)
        self.assertIn("policy=schema_diff_gate", p.stdout, "the row must name the enforcer")
        self.assertIn("FAIL-CLOSED", p.stdout)

    def test_it_still_works_before_record_execution_exists(self):
        """The earliest call sites fire before that function is defined.

        `policies.db not found` and `sqlite3 not on PATH` both call fail_closed
        from above record_execution's definition -- and in those states there is
        nothing to write to anyway. An unguarded call would turn the refusal
        into a bash error.
        """
        script = "set -euo pipefail\n" + self.fail_closed_fn() + '\nfail_closed "policies.db not found" || true\n'
        p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertIn("FAIL-CLOSED", p.stderr)
        self.assertNotIn("command not found", p.stderr)


class EnforcersAreBounded(unittest.TestCase):
    """A hung enforcer stalled the hook until the harness killed the process.

    A killed HOOK is not a fail-closed -- it is an unbounded stall whose outcome
    is decided somewhere else entirely. Measured at 20.2s with a sleeping
    enforcer before this.
    """

    def test_the_invocation_is_wrapped(self):
        gate = PRIMARY_HOOK.read_text()
        self.assertIn("TIMEOUT_BIN", gate)
        self.assertIn('"${ENFORCER_TIMEOUT}s" python3 "$enforcer"', gate)

    def test_it_degrades_to_the_shipped_behaviour_without_a_timeout_binary(self):
        """macOS spells it gtimeout; with neither, unbounded is what shipped."""
        gate = PRIMARY_HOOK.read_text()
        self.assertIn("command -v timeout || command -v gtimeout || true", gate)
        self.assertIn('if [[ -n "$TIMEOUT_BIN" ]]; then', gate)

    def test_the_timeout_layers_nest_innermost_shortest(self):
        """The arithmetic that makes the bound meaningful rather than decorative.

        The schema enforcer may run its checker twice (index and worktree). If
        that worst case can exceed the hook's per-enforcer bound, a slow but
        healthy check is killed and -- on a commit -- refused. Previously
        2 x 15s met the 30s budget exactly, with nothing left over.
        """
        gate = PRIMARY_HOOK.read_text()
        enforcer = (REPO / "src" / "policies" / "enforcers" / "schema_diff_gate.py").read_text()
        hook_bound = int(
            re.search(r'ENFORCER_TIMEOUT="\$\{UAP_ENFORCER_TIMEOUT:-(\d+)\}"', gate).group(1)
        )
        inline = float(re.search(r"INLINE_TIMEOUT = ([\d.]+)", enforcer).group(1))
        self.assertLess(
            inline * 2, hook_bound,
            "the enforcer's worst case must fit inside the hook's bound, or a "
            "slow healthy check becomes a refusal",
        )


class GateCallSitesAreWired(unittest.TestCase):
    """Drives the REAL hook script.

    Everything above extracts a bash fragment and runs it, which cannot notice
    if the fragment is never CALLED. Delete `must_fail_closed` from either call
    site, or move the COMMIT_OP assignment below the loop, and every other test
    here still passes. This one fails.
    """

    PID = "22222222-2222-2222-2222-222222222222"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="gate-e2e-")
        self.sb = Path(self._tmp.name)
        for d in (".policy-tools", "agents/data/memory", ".claude/hooks"):
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
        (self.sb / ".policy-tools/_common.py").write_text(helper)

        db = sqlite3.connect(self.sb / "agents/data/memory/policies.db")
        db.execute("CREATE TABLE policies (id TEXT, name TEXT, category TEXT, level TEXT,"
                   " rawMarkdown TEXT, convertedFormat TEXT, executableTools TEXT, tags TEXT,"
                   " createdAt TEXT, updatedAt TEXT, version INT, isActive INT, priority INT,"
                   " enforcementStage TEXT)")
        db.execute("CREATE TABLE executable_tools (id TEXT, policyId TEXT, toolName TEXT,"
                   " code TEXT, language TEXT, createdAt TEXT)")
        db.execute("CREATE TABLE policy_executions (id TEXT)")
        db.execute("INSERT INTO policies VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,'pre-exec')",
                   (self.PID, "Schema Diff Gate", "quality", "REQUIRED",
                    "# Schema Diff Gate", "", "", "", "", ""))
        db.execute("INSERT INTO executable_tools VALUES (?,?,?,?,?,?)",
                   ("t1", self.PID, "schema_diff_gate", "", "python", ""))
        db.commit()
        db.close()

    def tearDown(self):
        self._tmp.cleanup()

    def install_enforcer(self, body: str | None) -> None:
        p = self.sb / f".policy-tools/{self.PID}_schema_diff_gate.py"
        if body is None:
            if p.exists():
                p.unlink()
            return
        p.write_text(body)

    def gate(self, command: str, env_extra: dict | None = None) -> int:
        dst = self.sb / ".claude/hooks/uap-policy-gate.sh"
        dst.write_text(PRIMARY_HOOK.read_text())
        dst.chmod(0o755)
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(env_extra or {})
        payload = json.dumps({"tool_name": "Bash", "cwd": str(self.sb),
                              "tool_input": {"command": command}})
        p = subprocess.run(["bash", str(dst)], input=payload, capture_output=True,
                           text=True, cwd=self.sb, env=env, timeout=180)
        return p.returncode

    BROKEN = "raise SystemExit('boom')\n"
    HEALTHY = (
        "import json\n"
        "print(json.dumps({'allowed': True, 'reason': 'ok'}))\n"
    )

    def test_a_broken_enforcer_refuses_a_commit(self):
        self.install_enforcer(self.BROKEN)
        self.assertEqual(self.gate("git commit -m x"), 2)

    def test_a_missing_enforcer_refuses_a_commit(self):
        self.install_enforcer(None)
        self.assertEqual(self.gate("git commit -m x"), 2)

    def test_a_broken_enforcer_does_not_block_ordinary_work(self):
        """The scoping that keeps this from being a session-wide deadlock."""
        self.install_enforcer(self.BROKEN)
        for command in ("ls -la", "npm test", "git status", "git commit --help"):
            with self.subTest(command=command):
                self.assertEqual(self.gate(command), 0, command)

    def test_the_operator_hatch_actually_clears_it(self):
        """The refusal names this override, so it has to work.

        It cleared SEC_SENSITIVE only, so for a schema-gate fail-closed it did
        nothing -- every commit refused, with the message pointing at a switch
        that had no effect on the branch printing it.
        """
        self.install_enforcer(self.BROKEN)
        self.assertEqual(self.gate("git commit -m x"), 2)
        self.assertEqual(
            self.gate("git commit -m x", {"UAP_SELF_PROTECT_OFF": "1"}), 0,
            "the advertised override must clear the schema-gate branch too",
        )

    def test_a_healthy_enforcer_is_unaffected(self):
        self.install_enforcer(self.HEALTHY)
        self.assertEqual(self.gate("git commit -m x"), 0)

if __name__ == "__main__":
    unittest.main()
