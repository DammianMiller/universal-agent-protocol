#!/usr/bin/env python3
"""Tests for proxy-side path containment — recovering the workdir and snapping a
small quant's GARBLED absolute paths back onto it (the failure where it mangles
the prefix: /home/cogtek -> /home/cogtec, octopus_invaders -> octus_invaders).
Safe under the OS sandbox, which contains any mis-snap to the workdir.
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


def _load():
    # this file: tools/agents/tests/ -> module: tools/agents/scripts/
    p = Path(__file__).resolve().parents[1] / "scripts" / "toolcall_path_normalizer.py"
    spec = importlib.util.spec_from_file_location("toolcall_path_normalizer", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


N = _load()


def _tu(tid, **inp):
    return {"type": "tool_use", "id": tid, "name": "Write", "input": inp}


class TestDeriveWorkdir(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.wd = os.path.join(self._tmp.name, "octopus_invaders")
        os.makedirs(os.path.join(self.wd, "space-shooter"))
        os.makedirs(os.path.join(self.wd, ".git"))  # project-root marker

    def tearDown(self):
        self._tmp.cleanup()

    def test_recovers_workdir_from_correct_and_garbled_known_paths(self):
        known = [
            os.path.join(self.wd, "space-shooter", "js", "game.js"),  # correct (parent exists)
            self.wd.replace("octopus_invaders", "octus_invaders") + "/x.js",  # garble (no exist)
            "/home/cogtec/dev/octopus_invaders/y.js",  # garble (no exist)
        ]
        self.assertEqual(N.derive_workdir(known), self.wd)

    def test_uses_hint_text_when_known_all_garbled(self):
        known = ["/home/cogtec/dev/octus_invaders/a.js"]  # all garbled
        hint = f"running in {self.wd} now"
        self.assertEqual(N.derive_workdir(known, hint), self.wd)

    def test_returns_empty_when_nothing_exists(self):
        self.assertEqual(N.derive_workdir(["/home/nope/x/y.js"]), "")


class TestContainToWorkdir(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.wd = os.path.join(self._tmp.name, "octopus_invaders")
        os.makedirs(self.wd)

    def tearDown(self):
        self._tmp.cleanup()

    def test_garbled_prefix_contained(self):
        p = "/home/cogtec/dev/octopus_invaders/space-shooter/js/game.js"
        new, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertTrue(changed)
        self.assertEqual(new, self.wd + "/space-shooter/js/game.js")

    def test_garbled_workdir_name_contained(self):
        for bad in ("octus_invaders", "octpus_invaders", "octopus-invaders", "octopus_invders"):
            p = f"/home/cogtec/dev/{bad}/space-shooter/css/styles.css"
            new, changed, _ = N.contain_to_workdir(p, self.wd)
            self.assertTrue(changed, bad)
            self.assertEqual(new, self.wd + "/space-shooter/css/styles.css", bad)

    def test_already_inside_unchanged(self):
        p = self.wd + "/space-shooter/js/game.js"
        _, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertFalse(changed)

    def test_real_existing_path_elsewhere_left_alone(self):
        other = os.path.join(self._tmp.name, "real_other")
        os.makedirs(other)
        open(os.path.join(other, "f.txt"), "w").write("x")
        p = os.path.join(other, "f.txt")
        _, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertFalse(changed)

    def test_unrelated_nonexistent_path_not_contained(self):
        # No component fuzzy-matches the workdir name -> leave it (sandbox blocks).
        p = "/etc/cron.d/totally_unrelated"
        _, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertFalse(changed)


class TestContainToolUses(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.wd = os.path.join(self._tmp.name, "octopus_invaders")
        os.makedirs(self.wd)

    def tearDown(self):
        self._tmp.cleanup()

    def test_contains_write_path_and_bash_command(self):
        tus = [
            _tu("t1", file_path="/home/cogtec/dev/octus_invaders/space-shooter/js/game.js", content="x"),
            {"type": "tool_use", "id": "t2", "name": "Bash",
             "input": {"command": "mkdir -p /home/cogtk/dev/octopus_invaders/space-shooter/css && echo done"}},
        ]
        corr = N.contain_tool_uses(tus, self.wd)
        self.assertEqual(tus[0]["input"]["file_path"], self.wd + "/space-shooter/js/game.js")
        self.assertIn(self.wd + "/space-shooter/css", tus[1]["input"]["command"])
        self.assertTrue(tus[1]["input"]["command"].startswith("mkdir -p "))
        self.assertEqual(len(corr), 2)

    def test_noop_without_workdir(self):
        tus = [_tu("t1", file_path="/home/cogtec/dev/octus_invaders/a.js")]
        self.assertEqual(N.contain_tool_uses(tus, ""), [])


if __name__ == "__main__":
    unittest.main()
