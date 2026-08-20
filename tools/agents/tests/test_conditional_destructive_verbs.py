"""`sed` and `find` are only destructive when a flag makes them write.

Both sit in DESTRUCTIVE_VERBS, but without a write flag they are stdout filters
-- exactly like `awk` and `grep`, which this enforcer already allows against a
protected path, because READING one is not tampering.

Measured before the fix (2026-08-20): of six read-only ways to inspect a
protected file, five were refused -- `sed -n '1,5p'`, `sed 's/a/b/'`, the same
piped to `wc`, `find <dir> -name '*.py'` and `find <dir> -type f`. Those refusals
protected nothing and cost real work: in one session they blocked READING the
enforcer twice, blocked `cp <protected> /tmp/` (a read FROM a protected path),
and blocked a `gh pr close --comment` whose comment text merely quoted a path.

The predicates fail CLOSED, so the second class below matters more than the
first: every way of making `sed` or `find` write must still be refused.
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "enforcement_self_protect.py"
REPO = Path(__file__).resolve().parents[3]
T = "src/policies/enforcers/enforcement_self_protect.py"
D = "src/policies/enforcers"


def blocked(cmd):
    e = dict(os.environ)
    e["UAP_REPO_ROOT"] = str(REPO)
    e.pop("UAP_SELF_PROTECT_OFF", None)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", "Bash", "--args", json.dumps({"command": cmd})],
        capture_output=True, text=True, env=e,
    )
    return p.returncode != 0


class ReadsAreAllowedTest(unittest.TestCase):
    """A read of a protected file is not tampering, whatever tool does it."""

    def test_sed_without_in_place_is_a_read(self):
        for cmd in (
            "sed -n '1,5p' " + T,
            "sed 's/a/b/' " + T,
            "sed -E 's/a+/b/' " + T,
            "sed -n '1,5p' " + T + " | wc -l",
        ):
            with self.subTest(cmd=cmd):
                self.assertFalse(blocked(cmd), cmd)

    def test_find_without_a_mutating_action_is_a_read(self):
        for cmd in ("find " + D + " -name '*.py'", "find " + D + " -type f"):
            with self.subTest(cmd=cmd):
                self.assertFalse(blocked(cmd), cmd)

    def test_the_readers_that_always_worked_still_work(self):
        # Controls. If these ever start blocking, the regression is upstream of
        # the conditional-verb logic, not in it.
        for cmd in ("cat " + T, "grep -n x " + T, "awk 'NR<5' " + T, "head -5 " + T):
            with self.subTest(cmd=cmd):
                self.assertFalse(blocked(cmd), cmd)


class WritesStayRefusedTest(unittest.TestCase):
    """Every way of making these two verbs write must still be refused."""

    def test_sed_in_place_in_all_its_spellings(self):
        for cmd in (
            "sed -i 's/a/b/' " + T,
            "sed --in-place 's/a/b/' " + T,
            "sed -i.bak 's/a/b/' " + T,        # suffixed backup
            "sed -ni 's/a/b/' " + T,           # bundled short flags
            "sed -Ei 's/a/b/' " + T,           # bundled with -E
            "sed --in-place=.bak 's/a/b/' " + T,
        ):
            with self.subTest(cmd=cmd):
                self.assertTrue(blocked(cmd), cmd)

    def test_find_mutating_actions(self):
        for cmd in (
            "find " + D + " -name '*.py' -delete",
            "find " + D + " -name '*.py' -exec rm {} ;",
            "find " + D + " -execdir rm {} ;",
            "find " + D + " -ok rm {} ;",
            "find " + D + " -fprintf " + T + " %p",
        ):
            with self.subTest(cmd=cmd):
                self.assertTrue(blocked(cmd), cmd)

    def test_unconditional_verbs_are_untouched(self):
        # A verb NOT in CONDITIONAL_VERBS keeps its old, flag-independent
        # treatment. This is the guard against the fix widening past its scope.
        for cmd in (
            "rm " + T,
            "mv " + T + " /tmp/x",
            "cp /tmp/x " + T,
            "echo x | tee " + T,
            "echo x > " + T,
            "chmod 000 " + T,
            "truncate -s 0 " + T,
            "shred " + T,
            "ln -sf /tmp/x " + T,
        ):
            with self.subTest(cmd=cmd):
                self.assertTrue(blocked(cmd), cmd)


class PredicatesFailClosedTest(unittest.TestCase):
    """Unit-level: an unrecognised flag must read as a WRITE, not a read."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("esp", ENF)
        cls.m = importlib.util.module_from_spec(spec)
        sys.modules["esp"] = cls.m
        spec.loader.exec_module(cls.m)

    def test_sed_short_flag_cluster_containing_i_is_a_write(self):
        for toks in (["-i"], ["-i.bak"], ["-ni"], ["-Ei"], ["-i", "s/a/b/"]):
            with self.subTest(toks=toks):
                self.assertTrue(self.m._sed_writes(toks), toks)

    def test_sed_flags_without_i_are_reads(self):
        for toks in (["-n"], ["-E"], ["-r"], ["-e", "s/a/b/"], ["--expression=s/a/b/"]):
            with self.subTest(toks=toks):
                self.assertFalse(self.m._sed_writes(toks), toks)

    def test_sed_backup_suffix_is_not_parsed_as_flags(self):
        # `-n.i` would otherwise look like a write because of the trailing i;
        # everything after the first '.' is the suffix, not a flag cluster.
        self.assertFalse(self.m._sed_writes(["-n.i"]))

    def test_find_exec_family_is_a_write_whatever_it_runs(self):
        # What -exec runs cannot be judged from the flag, so it counts as a write.
        for tok in ("-delete", "-exec", "-execdir", "-ok", "-okdir",
                    "-fprint", "-fprint0", "-fprintf", "-fls"):
            with self.subTest(tok=tok):
                self.assertTrue(self.m._find_writes([tok]))

    def test_find_pure_predicates_are_reads(self):
        for toks in (["-name", "*.py"], ["-type", "f"], ["-maxdepth", "2"], ["-print"]):
            with self.subTest(toks=toks):
                self.assertFalse(self.m._find_writes(toks), toks)

    def test_only_these_two_verbs_are_conditional(self):
        # Widening this map is a security decision; pin the membership so it
        # cannot grow by accident.
        self.assertEqual(set(self.m.CONDITIONAL_VERBS), {"sed", "find"})


if __name__ == "__main__":
    unittest.main()
