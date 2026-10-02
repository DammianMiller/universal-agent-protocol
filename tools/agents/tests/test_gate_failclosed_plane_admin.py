"""The plane-admin guard's failure must not read as consent.

uap-policy-gate.sh is fail-SOFT by design: a broken or absent enforcer must not
wedge every tool call in the session. That same fail-open makes "break the
enforcer" a silent bypass of the control that enforcer implements -- the loop
iterating active policies maps a missing enforcer file, and an enforcer that
errors or emits unparseable output, to ALLOW for everything except the names
must_fail_closed() says otherwise about.

plane_admin_protect guards the plane-admin control surface: policy registration,
the plane-admin rows the gate itself reads out of agents/data/memory/policies.db,
and the .policy-tools/ enforcer copies the gate executes. That surface is mutable
almost exclusively through the shell (`uap policy install/verify`, `sqlite3
agents/data/memory/policies.db ...`, `rm -rf .policy-tools/...`), so a missing or
errored plane-admin enforcer ON A SHELL CALL is a live bypass of the admin
controls. It therefore arms the fail-closed net -- but only for shell-execution
tools (SHELL_OP), for the same reason COMMIT_OP scopes schema_diff_gate to
commit/push: arming it on every Edit would turn one broken enforcer into a
blanket block on all work in the session.

These tests assert the shipped copies of the hook carry that case, and EXECUTE
the extracted shell logic rather than grep for it -- a comment merely mentioning
plane_admin_protect must not satisfy them.
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HOOK_NAME = "uap-policy-gate.sh"
PRIMARY_HOOK = REPO / ".claude" / "hooks" / HOOK_NAME
TEMPLATE_HOOK = REPO / "templates" / "hooks" / HOOK_NAME
POLICY_NAME = "plane_admin_protect"

SHELL_TOOLS = (
    "Bash", "bash", "run_bash", "BashTool", "Shell", "shell", "Terminal",
    "terminal", "execute_command", "run_command", "exec", "local_shell", "command",
)
NON_SHELL_TOOLS = ("Edit", "Write", "MultiEdit", "Read", "Task", "Grep")


def hook_copies() -> list[Path]:
    """Every copy of the hook this repo SHIPS (git-tracked files only).

    Matched on the path RELATIVE to REPO, and limited to tracked files: `uap
    hooks install` output (.uap/omp/, .codex/hooks/, .cursor/hooks/, ...) is
    gitignored, so sweeping it fails on files no PR can commit -- and matching
    the ABSOLUTE path excluded the whole tree whenever REPO was itself a
    worktree, making the sweep pass by iterating nothing.
    """
    tracked = subprocess.run(
        ["git", "ls-files", "--full-name", "*" + HOOK_NAME],
        cwd=REPO, capture_output=True, text=True,
    ).stdout.split()
    return sorted(REPO / t for t in tracked if (REPO / t).is_file())


def _extract(gate: str, start: str, end: str) -> str:
    """Pull a verbatim region out of the hook so the test runs the real code."""
    i = gate.index(start)
    return gate[i:gate.index(end, i) + len(end)]


def must_fail_closed_fn(gate: str) -> str:
    return _extract(gate, "must_fail_closed() {", "\n}\n")


def shell_op_block(gate: str) -> str:
    """The hook's own tool-name -> SHELL_OP decision, verbatim."""
    return _extract(gate, "SHELL_OP=0\n", "esac\n")


def run_bash(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", script], capture_output=True,
                          text=True, timeout=30)


class GateCarriesThePlaneAdminCase(unittest.TestCase):
    """The selector must name the enforcer, not just the two it already knew."""

    def test_the_sweep_actually_finds_the_copies(self):
        """An assertion about a collection is worthless without this one.

        hook_copies() once returned [] inside a worktree and both drift sweeps
        went green while checking nothing.
        """
        found = hook_copies()
        self.assertGreaterEqual(
            len(found), 2,
            f"expected several hook copies under {REPO}, found {[str(p) for p in found]}",
        )
        self.assertIn(PRIMARY_HOOK, found)
        self.assertIn(TEMPLATE_HOOK, found)

    def test_every_shipped_copy_arms_plane_admin_protect(self):
        for copy in hook_copies():
            with self.subTest(copy=str(copy.relative_to(REPO))):
                fn = must_fail_closed_fn(copy.read_text())
                self.assertIn(
                    POLICY_NAME, fn,
                    f"{copy.relative_to(REPO)}: must_fail_closed() has no "
                    f"{POLICY_NAME} case, so a broken plane-admin enforcer fails open",
                )

    def test_the_template_copy_is_not_the_stale_one(self):
        """`uap worktree create` seeds new worktrees from templates/hooks/.

        A fix applied only to .claude/hooks/ is silently reverted the next time
        anyone starts a branch -- a documented failure mode in this repo.
        """
        self.assertTrue(TEMPLATE_HOOK.is_file(), "templates/hooks copy is missing")
        self.assertIn(POLICY_NAME, must_fail_closed_fn(TEMPLATE_HOOK.read_text()))

    def test_the_selector_body_agrees_across_copies(self):
        primary = must_fail_closed_fn(PRIMARY_HOOK.read_text())
        for copy in hook_copies():
            with self.subTest(copy=str(copy.relative_to(REPO))):
                self.assertEqual(
                    must_fail_closed_fn(copy.read_text()), primary,
                    f"{copy.relative_to(REPO)}: must_fail_closed() has drifted "
                    "from .claude/hooks/",
                )

    def test_every_copy_still_parses(self):
        for copy in hook_copies():
            with self.subTest(copy=str(copy.relative_to(REPO))):
                p = subprocess.run(["bash", "-n", str(copy)],
                                   capture_output=True, text=True, timeout=30)
                self.assertEqual(p.returncode, 0, p.stderr[:300])

    def test_the_refusal_names_the_right_enforcer(self):
        """A refusal that names the wrong guard is how a loop survives it.

        Routing this through the generic self-protect wording told the operator
        the self-protect enforcer had failed and pointed at a hatch that does
        not re-arm this case.
        """
        fn = _extract(PRIMARY_HOOK.read_text(), "fail_closed() {", "\n}\n")
        script = (
            "set -euo pipefail\n"
            'record_execution() { echo "RECORDED allowed=$1 policy=$2"; }\n'
            + fn
            + f'\nfail_closed "enforcer errored" "{POLICY_NAME}" || true\n'
        )
        p = run_bash(script)
        self.assertIn("FAIL-CLOSED", p.stderr)
        self.assertIn(POLICY_NAME, p.stderr)
        self.assertIn("RECORDED allowed=0", p.stdout, "the block must leave a compliance row")
        self.assertIn(f"policy={POLICY_NAME}", p.stdout, "the row must name the enforcer")


class PlaneAdminArmsOnlyForShellExecution(unittest.TestCase):
    """The scoping IS the design: shell tools only, and the hatch clears it."""

    def verdict(self, policy: str, shell_op: str, sec: str = "0", commit: str = "0") -> bool:
        script = (
            "set -euo pipefail\n"
            f'SEC_SENSITIVE="{sec}"\nCOMMIT_OP="{commit}"\nSHELL_OP="{shell_op}"\n'
            + must_fail_closed_fn(PRIMARY_HOOK.read_text())
            + f'\nif must_fail_closed "{policy}"; then echo CLOSED; else echo open; fi\n'
        )
        p = run_bash(script)
        self.assertEqual(p.returncode, 0, f"set -e tripped the helper: {p.stderr[:200]}")
        return p.stdout.strip() == "CLOSED"

    def test_it_fails_closed_on_a_shell_call(self):
        self.assertTrue(self.verdict(POLICY_NAME, "1"))

    def test_it_fails_open_on_everything_else(self):
        self.assertFalse(self.verdict(POLICY_NAME, "0"))

    def test_the_hooks_own_tool_test_classifies_shell_tools(self):
        gate = PRIMARY_HOOK.read_text()
        for tool in SHELL_TOOLS:
            with self.subTest(tool=tool):
                script = ("set -euo pipefail\n" + f'TOOL="{tool}"\n' + shell_op_block(gate)
                          + '\nif [[ "$SHELL_OP" == "1" ]]; then echo shell; else echo not-shell; fi\n')
                p = run_bash(script)
                self.assertEqual(p.returncode, 0, p.stderr[:200])
                self.assertEqual(p.stdout.strip(), "shell",
                                 f"{tool} must arm the plane-admin fail-closed net")

    def test_the_hooks_own_tool_test_leaves_edit_and_write_open(self):
        """Otherwise one broken enforcer blocks every edit in the session."""
        gate = PRIMARY_HOOK.read_text()
        for tool in NON_SHELL_TOOLS:
            with self.subTest(tool=tool):
                script = ("set -euo pipefail\n" + f'TOOL="{tool}"\n' + shell_op_block(gate)
                          + '\nif [[ "$SHELL_OP" == "1" ]]; then echo shell; else echo not-shell; fi\n')
                p = run_bash(script)
                self.assertEqual(p.returncode, 0, p.stderr[:200])
                self.assertEqual(p.stdout.strip(), "not-shell",
                                 f"{tool} must NOT arm the plane-admin fail-closed net")

    def test_the_operator_hatch_clears_this_arm_too(self):
        """UAP_SELF_PROTECT_OFF is documented as clearing the whole net.

        Leaving SHELL_OP armed made the override named in the refusal a no-op
        for exactly the case that prints it.
        """
        gate = PRIMARY_HOOK.read_text()
        script = (
            "set -euo pipefail\n"
            'TOOL="Bash"\nSHELL_OP=1\n'
            + shell_op_block(gate)
            + '\nexport UAP_SELF_PROTECT_OFF=1\n'
            + '[[ "${UAP_SELF_PROTECT_OFF:-}" == "1" ]] && SHELL_OP=0\n'
            + must_fail_closed_fn(gate)
            + f'\nif must_fail_closed "{POLICY_NAME}"; then echo CLOSED; else echo open; fi\n'
        )
        p = run_bash(script)
        self.assertEqual(p.returncode, 0, p.stderr[:300])
        self.assertEqual(p.stdout.strip(), "open")

    def test_the_other_two_arms_are_unchanged(self):
        """Adding this case must not have repurposed the existing selectors."""
        self.assertTrue(self.verdict("enforcement_self_protect", "0", sec="1"))
        self.assertFalse(self.verdict("enforcement_self_protect", "1", sec="0"))
        self.assertTrue(self.verdict("schema_diff_gate", "0", commit="1"))
        self.assertFalse(self.verdict("schema_diff_gate", "1", commit="0"))

    def test_an_unrelated_enforcer_still_fails_open(self):
        """Widening this to every enforcer would be a session-wide deadlock."""
        self.assertFalse(self.verdict("worktree_required", "1", sec="1", commit="1"))
        self.assertFalse(self.verdict("delivery_enforcement", "1", sec="1", commit="1"))


class MissingEnforcerFileIsCaught(unittest.TestCase):
    """The call sites, not just the selector: a deleted enforcer must block."""

    def test_the_loop_asks_the_selector_before_continuing(self):
        gate = PRIMARY_HOOK.read_text()
        i = gate.index("enforcer file missing")
        self.assertIn("must_fail_closed", gate[max(0, i - 400):i],
                      "a missing enforcer file must consult the selector, not just skip")

    def test_an_errored_enforcer_is_caught(self):
        gate = PRIMARY_HOOK.read_text()
        i = gate.index('fail_closed "enforcer errored"')
        self.assertIn("must_fail_closed", gate[max(0, i - 400):i],
                      "allowed=2 (errored/unparseable) must consult the selector")


if __name__ == "__main__":
    unittest.main()