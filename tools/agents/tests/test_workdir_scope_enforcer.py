#!/usr/bin/env python3
"""Tests for the workdir-scope policy enforcer.

Invoked the way the policy gate invokes it: a subprocess given --operation and
--args, returning {"allowed": bool, "reason": str} on stdout and exit 0/2. The
project roots are supplied via UAP_REPO_ROOT / UAP_WORKTREE_ROOT (as the gate
does), pointed at a temp directory so tests are hermetic.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENFORCER = (
    Path(__file__).resolve().parents[3]
    / "src" / "policies" / "enforcers" / "workdir_scope.py"
)


def run(op, args, root, env_extra=None):
    env = dict(os.environ)
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    env.pop("UAP_WORKDIR_SCOPE_OFF", None)
    env.pop("UAP_WORKDIR_ALLOW", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(
        [sys.executable, str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        capture_output=True, text=True, env=env, cwd=str(root),
    )
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        out = {"allowed": True, "reason": f"<unparseable: {p.stdout!r} {p.stderr!r}>"}
    return out, p.returncode


class TestWorkdirScopeEnforcer(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / ".worktrees" / "001-x").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _allow(self, out, code, msg=""):
        self.assertTrue(out["allowed"], f"{msg}: {out}")
        self.assertEqual(code, 0)

    def _block(self, out, code, msg=""):
        self.assertFalse(out["allowed"], f"{msg}: {out}")
        self.assertEqual(code, 2)
        self.assertIn("workdir-scope", out["reason"])

    # --- file-write tools ---

    def test_write_inside_root_allowed(self):
        out, c = run("Write", {"file_path": str(self.root / "src/a.js")}, self.root)
        self._allow(out, c, "in-root write")

    def test_write_outside_root_blocked(self):
        out, c = run("Write", {"file_path": "/home/cogtek/dev/octopusspace-shooter/x.js"}, self.root)
        self._block(out, c, "out-of-root write")

    def test_relative_path_allowed(self):
        out, c = run("Edit", {"file_path": "src/a.js"}, self.root)
        self._allow(out, c, "relative path")

    def test_scratch_tmp_allowed(self):
        out, c = run("Write", {"file_path": "/tmp/uap-scratch/x"}, self.root)
        self._allow(out, c, "/tmp scratch")

    def test_claude_memory_dir_allowed(self):
        # ~/.claude/projects is the Claude Code harness's auto-memory/session
        # storage; the harness instructs agents to write memories there.
        out, c = run(
            "Write",
            {"file_path": str(Path.home() / ".claude/projects/-x-proj/memory/note.md")},
            self.root,
        )
        self._allow(out, c, "claude memory dir")

    def test_worktree_path_allowed(self):
        out, c = run("Write", {"file_path": str(self.root / ".worktrees/001-x/f.ts")}, self.root)
        self._allow(out, c, "worktree path")

    def test_notebook_edit_outside_blocked(self):
        out, c = run("NotebookEdit", {"notebook_path": "/etc/evil.ipynb"}, self.root)
        self._block(out, c, "notebook outside")

    # --- bash ---

    def test_bash_mkdir_outside_blocked(self):
        out, c = run("Bash", {"command": "mkdir -p /home/cogtek/dev/octopusspace-shooter/js"}, self.root)
        self._block(out, c, "mkdir outside")

    def test_bash_mkdir_inside_allowed(self):
        out, c = run("Bash", {"command": "mkdir -p ./src/new"}, self.root)
        self._allow(out, c, "mkdir inside")

    def test_bash_read_only_allowed(self):
        out, c = run("Bash", {"command": "cat /etc/hosts && ls /usr/bin"}, self.root)
        self._allow(out, c, "read-only command")

    def test_bash_cp_dest_outside_blocked(self):
        out, c = run("Bash", {"command": "cp ./a.txt /var/tmp2/out/b.txt"}, self.root)
        self._block(out, c, "cp dest outside")

    def test_bash_cp_source_outside_dest_inside_allowed(self):
        out, c = run("Bash", {"command": "cp /etc/hosts ./local-hosts"}, self.root)
        self._allow(out, c, "read source outside, write inside")

    def test_bash_redirect_outside_blocked(self):
        out, c = run("Bash", {"command": "echo hi > /opt/somewhere/file"}, self.root)
        self._block(out, c, "redirect outside")

    # --- overrides / non-mutating ---

    def test_scope_off_override_allows(self):
        out, c = run("Write", {"file_path": "/anywhere/x"}, self.root, {"UAP_WORKDIR_SCOPE_OFF": "1"})
        self._allow(out, c, "scope-off override")

    def test_workdir_allow_widens(self):
        out, c = run("Write", {"file_path": "/opt/extra/x"}, self.root, {"UAP_WORKDIR_ALLOW": "/opt/extra"})
        self._allow(out, c, "allow-list widened")

    def test_non_path_op_allowed(self):
        out, c = run("Grep", {"pattern": "foo"}, self.root)
        self._allow(out, c, "non-path op")

    def test_read_op_outside_allowed(self):
        # Reading outside the workdir is fine; only mutations are scoped.
        out, c = run("Read", {"file_path": "/etc/hosts"}, self.root)
        self._allow(out, c, "read outside allowed")


# Redirect operator, built by codepoint: a literal one in this file would be
# read as a redirection by the very enforcer under test.
GT = chr(62)
BS = chr(92)
DQ = chr(34)
SQ = chr(39)
BT = chr(96)
TILDE = chr(126)


class TestWorkdirScopeQuoting(unittest.TestCase):
    """A redirect operator inside quotes is literal text, not a redirect.

    Scanning the raw command string made `sed -n '/a/,/b/p'` unusable whenever
    the range delimiters were angle brackets: the trailing `/p` was read as a
    write to /p. That refused an ordinary conflict-inspection command, and it
    refused the edit that fixes it (observed 2026-08-03).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _allow(self, out, code, label):
        self.assertTrue(out.get("allowed"), f"{label}: {out.get('reason')}")
        self.assertEqual(code, 0, label)

    def _block(self, out, code, label):
        self.assertFalse(out.get("allowed"), f"{label} should be blocked")
        self.assertEqual(code, 2, label)

    # --- the false positive ---

    def test_sed_range_with_angle_delimiters_allowed(self):
        cmd = "sed -n '/" + "<" * 7 + "/,/" + GT * 7 + "/p' CHANGELOG.md"
        out, c = run("Bash", {"command": cmd}, self.root)
        self._allow(out, c, "sed range is not a redirect")

    def test_quoted_redirect_text_allowed(self):
        out, c = run("Bash", {"command": "echo 'writes to /etc/passwd'"}, self.root)
        self._allow(out, c, "quoted text is not a redirect")

    def test_double_quoted_redirect_text_allowed(self):
        out, c = run("Bash", {"command": 'echo "result ' + GT + ' /etc/passwd"'}, self.root)
        self._allow(out, c, "double-quoted text is not a redirect")

    # --- and the detection it must NOT weaken ---

    def test_real_redirect_still_blocked(self):
        out, c = run("Bash", {"command": "echo hi " + GT + " /etc/uap-marker"}, self.root)
        self._block(out, c, "real redirect outside workdir")

    def test_real_append_still_blocked(self):
        out, c = run("Bash", {"command": "echo hi " + GT * 2 + " /etc/uap-marker"}, self.root)
        self._block(out, c, "real append outside workdir")

    def test_quoted_destination_still_blocked(self):
        # The operator is unquoted; only the TARGET is quoted. Masking quoted
        # spans must not lose this one.
        out, c = run("Bash", {"command": 'echo hi ' + GT + ' "/etc/uap-marker"'}, self.root)
        self._block(out, c, "quoted absolute destination")

    # --- escaped quotes must not hide a REAL redirect (security review) ---
    #
    # A naive quote toggle desyncs on an escaped quote and blanks everything
    # after it, including a live redirect. Each of these was ALLOWED by that
    # bug: a containment bypass, strictly worse than the false positive the
    # masking was added to fix.

    def test_escaped_double_quote_does_not_hide_a_redirect(self):
        cmd = ": " + BS + DQ + " " + GT + " /root/uap-probe"
        out, c = self._run_bash(cmd)
        self._block(out, c, "escaped double quote then real redirect")

    def test_escaped_single_quote_does_not_hide_a_redirect(self):
        cmd = ": " + BS + SQ + " " + GT + " /root/uap-probe"
        out, c = self._run_bash(cmd)
        self._block(out, c, "escaped single quote then real redirect")

    def test_ansi_c_quoting_does_not_hide_a_redirect(self):
        cmd = "echo $" + SQ + "a" + BS + SQ + "b" + SQ + " " + GT + " /root/uap-probe"
        out, c = self._run_bash(cmd)
        self._block(out, c, "ANSI-C quoting then real redirect")

    def test_unterminated_quote_falls_back_to_raw_scan(self):
        # The mask cannot be trusted, so over-block rather than under-block.
        cmd = "echo " + DQ + "oops " + GT + " /root/uap-probe"
        out, c = self._run_bash(cmd)
        self._block(out, c, "unterminated quote")

    # --- command substitution EXECUTES inside double quotes ---
    #
    # Masking a quoted span hid these: bash really does perform the redirect
    # (verified), so blanking the span turned a containment gate into a bypass.
    # The masker cannot model substitution, so its presence forces the raw scan.

    def test_command_substitution_in_double_quotes_is_not_hidden(self):
        cmd = "echo " + DQ + "$(id " + GT + " /root/uap-probe)" + DQ
        out, c = self._run_bash(cmd)
        self._block(out, c, "$() inside double quotes")

    def test_backticks_in_double_quotes_are_not_hidden(self):
        cmd = "echo " + DQ + BT + "id " + GT + " /root/uap-probe" + BT + DQ
        out, c = self._run_bash(cmd)
        self._block(out, c, "backticks inside double quotes")

    # --- targets the scanner used to never look at (bash-confirmed writes) ---

    def test_tilde_redirect_target_is_checked(self):
        # _expand() resolves ~ already; the target pattern just never handed it
        # over, so `> ~/x` wrote outside the project unchecked.
        out, c = self._run_bash("echo hi " + GT + " " + TILDE + "/uap-probe")
        self._block(out, c, "tilde redirect target")

    def test_variable_redirect_target_is_checked(self):
        out, c = self._run_bash("echo hi " + GT + " $HOME/uap-probe")
        self._block(out, c, "$HOME redirect target")

    def test_line_continuation_keeps_verb_and_destination_together(self):
        # Bash removes the continuation before word-splitting; the scanner did
        # not, so the destination landed in a segment with no create verb.
        out, c = self._run_bash("mkdir -p " + chr(92) + "\n  /root/uap-probe")
        self._block(out, c, "destination after a line continuation")

    def test_process_substitution_destination_is_checked(self):
        # `> >(tee /outside)` really writes; parens were not segment
        # separators, so tee's argument was invisible to the verb scan.
        out, c = self._run_bash("echo data " + GT + " " + GT + "(tee /root/uap-probe)")
        self._block(out, c, "process substitution destination")

    # --- and the prose that must NOT be mistaken for a redirect ---

    def test_inert_single_quoted_prose_is_not_a_redirect(self):
        # Single quotes suppress substitution, so $( inside them is text. Forcing
        # the conservative raw scan on its account blocked ordinary commit
        # messages that merely discuss shell syntax.
        cmd = ("git commit -m 'See $(uname) docs; example redirect "
               + GT + " /opt/notes explained here'")
        out, c = self._run_bash(cmd)
        self._allow(out, c, "inert prose in a single-quoted message")

    def _run_bash(self, cmd):
        return run("Bash", {"command": cmd}, self.root)

    def test_stderr_redirect_to_dev_null_allowed(self):
        out, c = run("Bash", {"command": "ls 2" + GT + "/dev/null"}, self.root)
        self._allow(out, c, "/dev/null is not an escape")


if __name__ == "__main__":
    unittest.main()
