"""The Python test gate must actually run the tests it claims to.

`npm run test:enforcers` is an EXPLICIT module list handed to
`python -m unittest`, not discovery. Two silent failure modes follow, and both
had occurred by 2026-07-31:

1. A module exists but is not listed. 37 of 51 were unlisted; 34 of those passed
   perfectly well. The guardrail suites — error-loop, deferral-break,
   stuck-break, session-admission, cycle-break — had no CI coverage at all,
   which is how the same guards kept regressing on green PRs.

2. A module is listed but contains no unittest.TestCase subclasses.
   `python -m unittest` collects nothing from a plain pytest-style class,
   reports "Ran 0 tests / NO TESTS RAN", and exits 0. The suite looks covered
   and asserts nothing.

Both are invisible in a green build, which is exactly why they need a test.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TESTS = Path(__file__).resolve().parent

# Verified failing for their own pre-existing reasons, not by omission. Each
# entry is a debt with a stated cause — not a place to park a newly broken test.
KNOWN_EXCLUDED = {
    "test_anthropic_proxy_streaming": "behaviour drifted from the assertions",
    "test_delivery_enforcement_worktree": "behaviour drifted from the assertions",
    "test_uap_compliance": "needs a populated DB; environment-bound",
}


def _listed_modules() -> set:
    script = json.loads((ROOT / "package.json").read_text())["scripts"]["test:enforcers"]
    return set(re.findall(r"tools\.agents\.tests\.(\w+)\b", script))


def _modules_on_disk() -> set:
    return {p.stem for p in TESTS.glob("test_*.py")}


class TestEveryModuleIsListed(unittest.TestCase):
    def test_no_test_module_is_silently_unlisted(self):
        missing = _modules_on_disk() - _listed_modules() - set(KNOWN_EXCLUDED)
        assert missing == set(), (
            f"these test modules exist but CI never runs them: {sorted(missing)}. "
            "Add them to the test:enforcers script, or record them in "
            "KNOWN_EXCLUDED with the reason they cannot run."
        )

    def test_the_exclusion_list_does_not_name_files_that_are_gone(self):
        # A stale exclusion silently re-opens the hole it was documenting.
        stale = set(KNOWN_EXCLUDED) - _modules_on_disk()
        assert stale == set(), f"KNOWN_EXCLUDED names modules that no longer exist: {sorted(stale)}"

    def test_an_excluded_module_is_not_also_listed(self):
        both = set(KNOWN_EXCLUDED) & _listed_modules()
        assert both == set(), f"listed AND marked excluded — one of the two is wrong: {sorted(both)}"


class TestEveryListedModuleActuallyCollects(unittest.TestCase):
    def test_listed_modules_define_unittest_testcases(self):
        # The "Ran 0 tests" trap: a listed module made of plain classes
        # contributes nothing and still exits 0.
        empty = []
        for name in sorted(_listed_modules()):
            path = TESTS / f"{name}.py"
            if not path.exists():
                continue  # covered by the stale-name test below
            src = path.read_text()
            has_case = re.search(r"class\s+\w+\s*\(\s*[\w.]*TestCase\s*\)", src)
            # A module may instead expose bare `def test_*` at module level,
            # which unittest also does not collect — so that is not a rescue.
            if not has_case:
                empty.append(name)
        assert empty == [], (
            f"listed in test:enforcers but define no unittest.TestCase, so they run "
            f"zero tests and pass: {empty}"
        )

    def test_every_listed_module_exists(self):
        ghosts = {n for n in _listed_modules() if not (TESTS / f"{n}.py").exists()}
        assert ghosts == set(), f"test:enforcers names modules that do not exist: {sorted(ghosts)}"


if __name__ == "__main__":
    unittest.main()
