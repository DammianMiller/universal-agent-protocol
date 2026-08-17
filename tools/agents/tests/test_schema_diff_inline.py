"""Tests for the inline-check pivot in the schema-diff gate.

The gate used to ask "is there a marker saying somebody ran the checker?" and
spent three review rounds trying to bind that marker to the bytes being
committed. It now runs the checker itself, on the exact bytes the command will
store.

Nearly every test here exists because an adversarial review got past an earlier
version of this code and the transcript is in the docstring. The through-line:
the gate must believe the checker ONLY when the checker demonstrably read the
right bytes and understood them. "No breaking changes" from something that
could not open the file, or had no analyser for it, or answered about a
different blob, is not an all-clear -- and every one of those was, at some
point, reported to the operator as one.

The checker is stubbed at the path the gate invokes, so these also pin the
invocation contract: --paths-from, --source, and the verdict shape.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENFORCER = REPO / "src" / "policies" / "enforcers" / "schema_diff_gate.py"

WATCHED = "migrations/001_add_table.sql"
BASE_SQL = "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n"
BREAKING_SQL = "CREATE TABLE t (id INTEGER PRIMARY KEY);\n"


def run_gate(op: str, args: dict, root: Path, env_extra: dict | None = None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["UAP_REPO_ROOT"] = str(root)
    env["UAP_WORKTREE_ROOT"] = str(root)
    env.update(env_extra or {})
    r = subprocess.run(
        ["python3", str(ENFORCER), "--operation", op, "--args", json.dumps(args)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    try:
        payload = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        payload = {}
    return payload.get("allowed", False), payload.get("reason", "")


@unittest.skipIf(shutil.which("node") is None, "node is required to stub the checker")
class InlineSchemaDiffTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="schema-inline-")
        self.root = Path(self._tmp.name)
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        # The gate only prefers a tree-local dist/ when the tree IS the UAP
        # checkout; see test_a_local_build_in_someone_elses_repo_is_not_run.
        (self.root / "package.json").write_text('{"name":"@miller-tech/uap"}\n')
        (self.root / "migrations").mkdir()
        (self.root / WATCHED).write_text(BASE_SQL)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(git + ["commit", "-q", "-m", "base"], cwd=self.root, check=True)
        (self.root / WATCHED).write_text(BREAKING_SQL)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers ------------------------------------------------------------

    def staged_sha(self, path: str = WATCHED) -> str:
        return subprocess.run(
            ["git", "rev-parse", f":{path}"],
            cwd=self.root, capture_output=True, text=True, check=True,
        ).stdout.strip()

    def stub_checker(self, payload, *, log_argv: bool = False):
        """Install a fake checker where the gate looks for it.

        `payload` is emitted verbatim as the last stdout line: a dict for a
        well-formed verdict, a string to test how the gate handles noise.
        """
        bin_dir = self.root / "dist" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        body = payload if isinstance(payload, str) else json.dumps(payload)
        # Logged relative to cwd, not via an env var: the gate allowlists the
        # child's environment (it must not hand an agent's credentials to a
        # subprocess chosen partly by filesystem contents), so ARGV_LOG would
        # never arrive.
        prelude = (
            "require('fs').appendFileSync('argv.log', "
            "JSON.stringify(process.argv.slice(2)) + '\\n');"
            if log_argv
            else ""
        )
        (bin_dir / "cli.js").write_text(f"{prelude}\nconsole.log({json.dumps(body)});\n")

    def verdict(self, *, breaking=(), sha=None, analysed=True, contract=1, path=WATCHED):
        return {
            "contract": contract,
            "ran": True,
            "base": "HEAD",
            "files": [
                {
                    "path": path,
                    "sha": self.staged_sha() if sha is None else sha,
                    "analysed": analysed,
                    "breaking": list(breaking),
                }
            ],
        }

    BREAK = ['Field "t.name" (TEXT) was removed']

    def commit(self, command="git commit -m x", **env):
        return run_gate("Bash", {"command": command}, self.root, env_extra=env or None)

    # -- the pivot ----------------------------------------------------------

    def test_a_clean_inline_run_clears_the_gate_with_no_marker_at_all(self):
        """The point of the change: evidence is produced, not looked up."""
        self.stub_checker(self.verdict())
        allowed, reason = self.commit()
        self.assertTrue(allowed, reason)
        self.assertIn("no breaking changes", reason)

    def test_a_breaking_change_is_refused_and_named(self):
        self.stub_checker(self.verdict(breaking=self.BREAK))
        allowed, reason = self.commit()
        self.assertFalse(allowed, "a breaking schema change must not commit")
        self.assertIn("BREAKING", reason)
        self.assertIn("t.name", reason, "the refusal must say what broke")

    # -- believing the checker ----------------------------------------------

    def test_a_verdict_about_different_bytes_is_not_an_answer(self):
        """The sha is re-derived, not taken on trust.

        The first version compared the paths it sent against the paths echoed
        back -- two copies of its own argument. That can fail on a whitespace
        artefact and on nothing else, so it could not detect the case it was
        written for: a checker reporting clean for bytes it never read.
        """
        self.stub_checker(self.verdict(sha="0" * 40))
        allowed, reason = self.commit()
        self.assertFalse(allowed, f"sha mismatch must not clear the gate: {reason}")
        self.assertIn("uap schema-diff", reason, "must fall back to the shipped remedy")

    def test_a_file_no_analyser_understood_is_not_clean(self):
        """`analysed: false` is the helm/spock case, and it is the big one.

        WATCHED_RE covers infra/helm_charts/** and infra/postgres-spock/**,
        which are YAML; the differ has branches for .ts/.js, .sql and .json
        only. Those paths produced an empty change list, and the gate published
        it as "schema-diff ran ... no breaking changes" -- an affirmative
        safety claim about a file nothing could parse, replacing master's
        requirement that a human run the checker first.
        """
        self.stub_checker(self.verdict(analysed=False))
        allowed, reason = self.commit()
        self.assertFalse(allowed, f"unanalysed must not read as clean: {reason}")

    def test_a_verdict_in_an_unknown_contract_is_not_an_answer(self):
        self.stub_checker(self.verdict(contract=99))
        allowed, _ = self.commit()
        self.assertFalse(allowed, "an unrecognised verdict shape must not clear the gate")

    def test_a_missing_entry_is_not_an_answer(self):
        """Silence about a watched path is not a clean bill of health."""
        self.stub_checker({"contract": 1, "ran": True, "base": "HEAD", "files": []})
        allowed, _ = self.commit()
        self.assertFalse(allowed)

    def test_ran_false_is_not_an_answer(self):
        self.stub_checker({"contract": 1, "ran": False, "base": "HEAD", "files": []})
        allowed, _ = self.commit()
        self.assertFalse(allowed)

    def test_noise_on_stdout_is_not_an_answer(self):
        self.stub_checker("not json at all")
        allowed, _ = self.commit()
        self.assertFalse(allowed)

    def test_a_malformed_verdict_cannot_crash_the_gate_open(self):
        """A crash IS an allow.

        .claude/hooks/uap-policy-gate.sh maps a non-zero exit or unparseable
        output to allowed for every enforcer except self-protect. Two shapes
        reachable from a future CLI raised TypeError out of main(): a
        `breaking` that is a bool rather than a list, and `files` entries that
        are objects where strings were expected.
        """
        for payload in (
            {"contract": 1, "ran": True, "files": [{"path": WATCHED, "sha": "x", "analysed": True, "breaking": True}]},
            {"contract": 1, "ran": True, "files": [{"path": WATCHED, "sha": "x", "analysed": True, "breaking": {"a": 1}}]},
            {"contract": 1, "ran": True, "files": ["not-an-object"]},
            {"contract": 1, "ran": True, "files": {"not": "a list"}},
        ):
            with self.subTest(payload=payload):
                self.stub_checker(payload)
                allowed, reason = self.commit()
                self.assertFalse(allowed, f"malformed verdict cleared the gate: {reason}")
                self.assertNotEqual(reason, "", "the gate must answer, not die silently")

    def test_a_missing_checker_leaves_the_shipped_behaviour_untouched(self):
        allowed, reason = self.commit()
        self.assertFalse(allowed, f"missing checker must not open the gate: {reason}")
        self.assertIn("uap schema-diff", reason)

    # -- what gets examined --------------------------------------------------

    def test_the_gate_names_the_paths_and_the_source(self):
        log = self.root / "argv.log"
        self.stub_checker(self.verdict(), log_argv=True)
        self.commit()
        argv = json.loads(log.read_text().splitlines()[0])
        self.assertIn("--json", argv)
        self.assertIn("--source", argv)
        self.assertEqual(argv[argv.index("--source") + 1], "index")
        # Paths travel in a NUL-separated file, never on the command line: a
        # comma split one path into two, and git C-quotes newlines and unicode
        # into strings that name no file at all -- which the checker then
        # reported clean.
        self.assertIn("--paths-from", argv)
        self.assertEqual(
            Path(argv[argv.index("--paths-from") + 1]).name.startswith("uap-schema-paths-"),
            True,
        )

    def test_a_diverging_worktree_is_checked_as_well_as_the_index(self):
        """Both candidate byte-strings, because the command form cannot be read.

        `git commit -- <path>`, `--only`, `--include`, `-o` and `-i` all store
        the WORKTREE copy and contain no `-a`; meanwhile the `-A` in
        `git add -A && git commit` matched the old short-flag test and pushed
        the gate to the worktree for a commit that stores the index. Both
        directions were demonstrated bypasses, so the inference is gone.
        """
        (self.root / WATCHED).write_text(BASE_SQL + "-- diverged\n")  # unstaged
        log = self.root / "argv.log"
        self.stub_checker(self.verdict(), log_argv=True)
        self.commit()
        sources = [
            json.loads(line)[json.loads(line).index("--source") + 1]
            for line in log.read_text().splitlines()
            if line.strip()
        ]
        self.assertEqual(sorted(sources), ["index", "worktree"])

    def test_only_one_check_when_index_and_worktree_agree(self):
        """The common case must not pay for the rare one."""
        log = self.root / "argv.log"
        self.stub_checker(self.verdict(), log_argv=True)
        self.commit()
        self.assertEqual(len([x for x in log.read_text().splitlines() if x.strip()]), 1)

    # -- the escape hatch ----------------------------------------------------

    def _write_waiver(self, body: str, *, commit: bool) -> None:
        waivers = self.root / "policies" / "waivers"
        waivers.mkdir(parents=True, exist_ok=True)
        (waivers / "deliberate-schema-diff.md").write_text(body)
        if commit:
            subprocess.run(["git", "add", "policies"], cwd=self.root, check=True)
            subprocess.run(
                ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
                 "-m", "waiver", "--only", "policies"],
                cwd=self.root, check=True,
            )

    def test_a_committed_waiver_naming_the_path_clears_a_breaking_change(self):
        self.stub_checker(self.verdict(breaking=self.BREAK))
        self._write_waiver(f"Deliberate: dropping name from {WATCHED}\n", commit=True)
        allowed, reason = self.commit()
        self.assertTrue(allowed, reason)
        self.assertIn("waived", reason)

    def test_an_uncommitted_waiver_does_not(self):
        """`touch policies/waivers/x-schema-diff.md` was a total off-switch.

        The check was Path.is_file() on the working tree, and
        enforcement_self_protect deliberately exempts policies/waivers/ so that
        agents CAN write there -- a carve-out justified when a waiver only
        satisfied expert-review. An empty, never-committed file cleared every
        breaking change. Verified.
        """
        self.stub_checker(self.verdict(breaking=self.BREAK))
        self._write_waiver("", commit=False)
        allowed, reason = self.commit()
        self.assertFalse(allowed, f"an uncommitted waiver must not clear it: {reason}")

    def test_a_waiver_for_a_different_path_does_not(self):
        self.stub_checker(self.verdict(breaking=self.BREAK))
        self._write_waiver("Deliberate: migrations/999_unrelated.sql\n", commit=True)
        allowed, reason = self.commit()
        self.assertFalse(allowed, f"a waiver must name what it excuses: {reason}")

    # -- the gate's own subprocess ------------------------------------------

    def test_the_inline_guard_stands_down_but_does_not_allow(self):
        """The 2026-07-08 self-deadlock mechanism, without a new off-switch.

        The guard has to exist so a nested gate does not call the checker
        recursively. It must not ALLOW, though: the variable travels with the
        shell, and the first version emitted allowed:true before looking at
        anything, which made `UAP_SCHEMA_DIFF_INLINE=1` a complete disable for
        a security control -- and unlike every comparable switch it was not in
        self-protect's BYPASS_PATTERNS. Skipping to the fallback costs a forger
        exactly what they already had.
        """
        self.stub_checker(self.verdict(breaking=self.BREAK))
        allowed, reason = self.commit(UAP_SCHEMA_DIFF_INLINE="1")
        self.assertFalse(allowed, f"the guard must not be an off-switch: {reason}")
        self.assertIn("uap schema-diff", reason, "it should land in the fallback")


@unittest.skipIf(shutil.which("node") is None, "node is required to stub the checker")
class CheckerProvenanceTest(unittest.TestCase):
    """Where the verdict comes from is part of the trust boundary."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="schema-prov-")
        self.root = Path(self._tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        (self.root / "migrations").mkdir()
        (self.root / WATCHED).write_text(BASE_SQL)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"],
            cwd=self.root, check=True,
        )
        (self.root / WATCHED).write_text(BREAKING_SQL)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        bin_dir = self.root / "dist" / "bin"
        bin_dir.mkdir(parents=True)
        # A rubber stamp: three lines, and it attests to anything.
        (bin_dir / "cli.js").write_text(
            "console.log(JSON.stringify({contract:1,ran:true,base:'HEAD',files:"
            "[{path:'" + WATCHED + "',sha:'x',analysed:true,breaking:[]}]}));\n"
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_local_build_in_someone_elses_repo_is_not_run(self):
        """dist/bin/cli.js is gitignored build output in any Node project.

        Preferring it handed the verdict to a file inside the tree being gated
        -- an easier forgery than the marker row this design replaced, and in a
        consumer repo it means committing a migration executes that project's
        unrelated build output. It is only trusted when the tree IS the UAP
        checkout, where it is the same artefact `npm i -g .` installs.
        """
        (self.root / "package.json").write_text('{"name":"totally-normal-app"}\n')
        allowed, reason = run_gate("Bash", {"command": "git commit -m x"}, self.root)
        self.assertFalse(allowed, f"a foreign dist/ must not be the oracle: {reason}")

    def test_no_package_json_is_also_not_the_uap_checkout(self):
        allowed, reason = run_gate("Bash", {"command": "git commit -m x"}, self.root)
        self.assertFalse(allowed, f"unidentified tree must not be trusted: {reason}")


if __name__ == "__main__":
    unittest.main()
