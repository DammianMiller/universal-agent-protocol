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

    def test_garbled_subdir_corrected_against_disk(self):
        # space-shooter exists on disk; a write to garbled space-shootr is fixed.
        os.makedirs(os.path.join(self.wd, "space-shooter", "js"))
        p = self.wd + "/space-shootr/js/game.js"  # in-workdir but garbled subdir
        new, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertTrue(changed)
        self.assertEqual(new, self.wd + "/space-shooter/js/game.js")

    def test_garbled_prefix_and_subdir_both_corrected(self):
        os.makedirs(os.path.join(self.wd, "space-shooter", "css"))
        p = "/home/cogtec/dev/octus_invaders/space-shootr/css/styles.css"
        new, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertTrue(changed)
        self.assertEqual(new, self.wd + "/space-shooter/css/styles.css")

    def test_new_subdir_left_when_no_disk_match(self):
        # First write that legitimately creates a new dir -> not fuzzy-mangled.
        p = self.wd + "/space-shooter/js/game.js"
        new, changed, _ = N.contain_to_workdir(p, self.wd)
        self.assertFalse(changed)  # nothing to correct; left as-is
        self.assertEqual(new, p)


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

    def _wd(self, *parts):
        # Journal geometry: the 2026-10-18 incident workdir .../p37/e2e made
        # the 'e2e' basename ANCHOR the container path /tmp/e2e/..., which is
        # what let containment misclassify it as a garbled host path. Tests
        # must reproduce that anchor or they do not discriminate.
        wd = os.path.join(self._tmp.name, *parts)
        os.makedirs(wd, exist_ok=True)
        return wd

    def test_docker_exec_container_paths_left_alone(self):
        # Regression 2026-10-18, journal geometry exactly: the session
        # workdir .../p37/e2e anchored the container path /tmp/e2e/... and
        # pre-fix code snapped it onto the workdir -- an 11-hour
        # deterministic-failure loop. The fix passes the command verbatim.
        wd = self._wd("p37", "e2e")
        cmd = ("docker exec p37koral bash -lc "
               "'cat /tmp/e2e/koral-p59probe_proda4.log'")
        tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": cmd}}]
        self.assertEqual(N.contain_tool_uses(tus, wd), [])
        self.assertEqual(tus[0]["input"]["command"], cmd)

    def test_container_exec_variants_left_alone(self):
        # Every variant uses the anchoring geometry so each discriminates:
        # pre-fix, each gets snapped (1 correction); post-fix, all pass
        # verbatim. DOCKER pins the case-insensitive match.
        wd = self._wd("p37", "e2e")
        for cmd in (
            "kubectl -n prod exec koral-0 -- cat /tmp/e2e/app.log",
            "docker compose exec koral cat /tmp/e2e/config.yaml",
            "docker-compose exec koral cat /tmp/e2e/config.yaml",
            "sudo podman exec ctr1 ls /tmp/e2e/data",
            "DOCKER exec ctr1 cat /tmp/e2e/UP.LOG",
        ):
            tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                    "input": {"command": cmd}}]
            self.assertEqual(N.contain_tool_uses(tus, wd), [], msg=cmd)
            self.assertEqual(tus[0]["input"]["command"], cmd)

    def test_host_path_before_docker_exec_still_contained(self):
        # Boundary is the END of the exec word: the garbled HOST path
        # before the subcommand still snaps; the container path after it
        # passes verbatim. Full-command equality so any drift fails.
        wd = self._wd("e2e")
        cmd = ("mkdir -p /home/cogtk/dev/e2e/css && "
               "docker exec koral cat /tmp/e2e/x.log")
        tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": cmd}}]
        corr = N.contain_tool_uses(tus, wd)
        self.assertEqual(tus[0]["input"]["command"],
                         f"mkdir -p {wd}/css && docker exec koral cat /tmp/e2e/x.log")
        self.assertEqual(len(corr), 1)

    def test_engine_flag_path_before_exec_still_contained(self):
        # Pins the END-of-exec-word boundary: a host-side engine flag
        # (kubectl --kubeconfig=...) sits before the subcommand and stays
        # contained; the container payload after it is exempt.
        wd = self._wd("e2e")
        cmd = ("kubectl --kubeconfig=/home/cogtk/dev/e2e/kc.conf exec koral-0 "
               "-- cat /tmp/e2e/x.log")
        tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": cmd}}]
        corr = N.contain_tool_uses(tus, wd)
        self.assertEqual(tus[0]["input"]["command"],
                         f"kubectl --kubeconfig={wd}/kc.conf exec koral-0 "
                         "-- cat /tmp/e2e/x.log")
        self.assertEqual(len(corr), 1)

    def test_exec_exempt_scope_is_sticky_to_end_of_command(self):
        # Pinned semantics (architect + security reviews): once a
        # container-exec boundary is found, the exemption covers the whole
        # remainder, INCLUDING later host-side segments after &&. Narrowing
        # to the next separator would need quote-awareness a regex cannot
        # provide (bash -lc 'cat /a; cat /b') and would reintroduce the
        # incident class. Fail-safe: an exempted garble errors loudly.
        wd = self._wd("e2e")
        cmd = ("docker exec koral cat /tmp/e2e/x.log "
               "&& cat /home/cogtk/dev/e2e/creds.txt")
        tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": cmd}}]
        self.assertEqual(N.contain_tool_uses(tus, wd), [])
        self.assertEqual(tus[0]["input"]["command"], cmd)

    def test_exec_decoy_still_triggers_exemption(self):
        # A quoted "docker exec" decoy triggers the exemption too -- accepted
        # fail-safe semantics: the worst case is an un-healed garble failing
        # loudly (pre-normalizer behavior), never a wrong-write.
        wd = self._wd("e2e")
        cmd = 'echo "docker exec" && cat /tmp/e2e/creds.txt'
        tus = [{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": cmd}}]
        self.assertEqual(N.contain_tool_uses(tus, wd), [])
        self.assertEqual(tus[0]["input"]["command"], cmd)


if __name__ == "__main__":
    unittest.main()
