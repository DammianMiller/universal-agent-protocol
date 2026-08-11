#!/usr/bin/env python3
"""How big a "trivial" edit is, is a project decision — so it belongs in the repo.

The fast-path budgets (per-edit threshold, cumulative chars, cumulative edits)
were read from the environment only. That meant only whoever launched the agent
could size them, and the choice left no trace: nothing in the repo recorded that
this project had decided a bigger budget, so the next session silently got the
default again.

They now come from `.uap.json` (`delivery.trivialEditChars`,
`delivery.cumulativeChars`, `delivery.cumulativeEdits`), with the environment
still winning where it is set, so a one-session operator override still works.

Both halves of the gate read the SAME setting: the hook that decides fast-path,
and the enforcer that decides refusal. Two numbers for one question would mean
the hook fast-paths an edit the enforcer then refuses.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HOOK = ROOT / "templates" / "hooks" / "fastpath_gate.py"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


hook = _load(HOOK, "fastpath_gate")
enf = _load(ROOT / "src" / "policies" / "enforcers" / "delivery_enforcement.py", "denf")


class Project:
    def __init__(self, delivery: dict | None = None, raw: str | None = None):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        if raw is not None:
            (self.root / ".uap.json").write_text(raw)
        elif delivery is not None:
            (self.root / ".uap.json").write_text(json.dumps({"version": 1, "delivery": delivery}))

    def close(self):
        self.tmp.cleanup()


class HookReadsTheProjectConfig(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("TRIVIAL", "CUM_CHARS", "CUM_EDITS", "UAP_MAIN_ROOT")}
        for k in self.saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_uses_the_documented_default_when_nothing_is_configured(self):
        p = Project()
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 240)
        self.assertEqual(hook._configured("cumulativeChars", "CUM_CHARS", 800), 800)
        p.close()

    def test_reads_the_value_committed_in_uap_json(self):
        p = Project({"trivialEditChars": 800, "cumulativeChars": 6000})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 800)
        self.assertEqual(hook._configured("cumulativeChars", "CUM_CHARS", 800), 6000)
        p.close()

    def test_the_environment_still_wins_over_the_project(self):
        # An operator sizing one session must not have to edit the repo.
        p = Project({"trivialEditChars": 800})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        os.environ["TRIVIAL"] = "50"
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 50)
        p.close()

    def test_a_malformed_override_falls_through_instead_of_crashing(self):
        p = Project({"trivialEditChars": 800})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        os.environ["TRIVIAL"] = "not-a-number"
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 800)
        p.close()

    def test_a_broken_config_does_not_break_the_gate(self):
        # A gate that throws on a malformed config is a gate that blocks all work.
        for raw in ("{not json", "[]", '{"delivery": "nope"}', '{"delivery": {"trivialEditChars": "big"}}'):
            p = Project(raw=raw)
            os.environ["UAP_MAIN_ROOT"] = str(p.root)
            self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 240, raw)
            p.close()

    def test_a_boolean_is_not_a_budget(self):
        # True would otherwise arrive as 1, making every edit non-trivial.
        p = Project({"trivialEditChars": True})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 240)
        p.close()

    def test_a_negative_budget_clamps_rather_than_inverting_the_gate(self):
        p = Project({"cumulativeChars": -5})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(hook._configured("cumulativeChars", "CUM_CHARS", 800), 0)
        p.close()

    def test_a_missing_config_file_is_normal_not_an_error(self):
        p = Project()
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(hook._configured("cumulativeEdits", "CUM_EDITS", 6), 6)
        p.close()


class BothHalvesAgree(unittest.TestCase):
    """The hook decides fast-path; the enforcer decides refusal. One number."""

    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in
                      ("TRIVIAL", "UAP_DELIVER_TRIVIAL_EDIT_CHARS", "UAP_MAIN_ROOT")}
        for k in self.saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_enforcer_and_hook_read_the_same_project_value(self):
        p = Project({"trivialEditChars": 900})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(enf._trivial_edit_chars(), 900)
        self.assertEqual(hook._configured("trivialEditChars", "TRIVIAL", 240), 900)
        p.close()

    def test_enforcer_honours_its_own_env_override_first(self):
        p = Project({"trivialEditChars": 900})
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        os.environ["UAP_DELIVER_TRIVIAL_EDIT_CHARS"] = "120"
        self.assertEqual(enf._trivial_edit_chars(), 120)
        p.close()

    def test_enforcer_falls_back_to_the_same_default(self):
        p = Project()
        os.environ["UAP_MAIN_ROOT"] = str(p.root)
        self.assertEqual(enf._trivial_edit_chars(), 240)
        p.close()


class TheDecisionActuallyUsesIt(unittest.TestCase):
    """Testing the reader is not testing the gate.

    `_configured` can be perfect while the call sites still read the raw
    environment — the decision is what ships, so drive the real entry point.
    """

    def _decide(self, root: Path, payload: dict, env: dict) -> int:
        e = dict(os.environ)
        for k in ("TRIVIAL", "CUM_CHARS", "CUM_EDITS"):
            e.pop(k, None)
        e["UAP_MAIN_ROOT"] = str(root)
        e.update(env)
        r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload),
                           capture_output=True, text=True, cwd=str(root), env=e)
        return r.returncode

    def test_a_project_sized_threshold_changes_the_verdict(self):
        # 400 changed chars: routed under the 240 default, fast-pathed under a
        # project that has decided 800.
        edit = {"file_path": "src/app.ts", "old_string": "x" * 200, "new_string": "y" * 200}
        strict = Project({"trivialEditChars": 240, "cumulativeChars": 100000})
        loose = Project({"trivialEditChars": 800, "cumulativeChars": 100000})
        try:
            self.assertEqual(self._decide(strict.root, edit, {}), 1, "should ROUTE under 240")
            self.assertEqual(self._decide(loose.root, edit, {}), 0, "should FAST-PATH under 800")
        finally:
            strict.close()
            loose.close()

    def test_a_project_sized_cumulative_budget_changes_the_verdict(self):
        # Same small edit repeated: the cumulative budget decides when it routes.
        edit = {"file_path": "src/app.ts", "old_string": "x" * 50, "new_string": "y" * 50}
        tight = Project({"trivialEditChars": 240, "cumulativeChars": 150, "cumulativeEdits": 99})
        roomy = Project({"trivialEditChars": 240, "cumulativeChars": 100000, "cumulativeEdits": 99})
        try:
            self.assertEqual(self._decide(tight.root, edit, {}), 0, "first edit fits")
            self.assertEqual(self._decide(tight.root, edit, {}), 1, "second crosses 150 chars")
            self.assertEqual(self._decide(roomy.root, edit, {}), 0)
            self.assertEqual(self._decide(roomy.root, edit, {}), 0, "still inside a big budget")
        finally:
            tight.close()
            roomy.close()

    def test_the_environment_still_overrides_the_project_end_to_end(self):
        edit = {"file_path": "src/app.ts", "old_string": "x" * 200, "new_string": "y" * 200}
        p = Project({"trivialEditChars": 800, "cumulativeChars": 100000})
        try:
            self.assertEqual(self._decide(p.root, edit, {}), 0)
            self.assertEqual(self._decide(p.root, edit, {"TRIVIAL": "100"}), 1)
        finally:
            p.close()


class EveryInstalledCopyCarriesIt(unittest.TestCase):
    """Hook template drift: a fix that never reaches templates/ is reverted the
    next time a worktree is created, and a fix only in templates/ never runs."""

    def test_all_copies_read_the_config(self):
        # Filter on the path RELATIVE to the root: this test may itself be
        # running inside .worktrees/, so matching the absolute path excluded
        # every copy and the assertion silently passed on an empty list.
        copies = []
        for p in ROOT.rglob("fastpath_gate.py"):
            rel = str(p.relative_to(ROOT))
            if "node_modules" in rel or rel.startswith(".worktrees"):
                continue
            copies.append(p)
        self.assertGreater(len(copies), 1, "expected a template plus installed copies")
        for p in copies:
            self.assertIn("_configured(", p.read_text(), f"{p} still reads env only")


if __name__ == "__main__":
    unittest.main()
