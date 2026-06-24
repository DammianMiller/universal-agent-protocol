#!/usr/bin/env python3
"""Tests for the hardened (filesystem-verified, same-directory-only) tool-call
path normalizer.

The heuristic predecessor silently RELOCATED writes across projects/worktrees
(e.g. octopus_invaders/js/config.js -> octopus-invader/space-shooter/js/config.js),
turning a loud self-correcting failure into a silent wrong-write. These tests
pin the conservative contract: only a filename may be repaired, only inside a
directory that already exists on disk, only when exactly one real sibling
matches — and a wrong/garbled directory or any ambiguity is left untouched.
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "toolcall_path_normalizer.py"
    spec = importlib.util.spec_from_file_location("toolcall_path_normalizer", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


norm = _load()


def _touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("x")
    return path


class TestHardenedNormalizer(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    # --- the repairs it SHOULD make (filename only, same real dir) ---

    def test_fixes_case_in_same_directory(self):
        real = _touch(os.path.join(self.root, "proj", "config.js"))
        proposed = os.path.join(self.root, "proj", "Config.js")  # wrong case, doesn't exist
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertTrue(changed)
        self.assertEqual(path, real)

    def test_fixes_dropped_extension_in_same_directory(self):
        real = _touch(os.path.join(self.root, "proj", "config.js"))
        proposed = os.path.join(self.root, "proj", "configjs")  # squash-match
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertTrue(changed)
        self.assertEqual(path, real)

    def test_trims_whitespace_on_real_path(self):
        real = _touch(os.path.join(self.root, "proj", "a.js"))
        path, changed, reason = norm.normalize_tool_path(f"  {real}  ")
        self.assertTrue(changed)
        self.assertEqual(path, real)
        self.assertIn("trimmed", reason)

    # --- the corruption it MUST NOT cause anymore ---

    def test_does_not_relocate_to_a_different_directory(self):
        # config.js exists only in projA; a (non-existent) write to projB/config.js
        # must NOT be snapped into projA — the live octopus-style corruption.
        _touch(os.path.join(self.root, "projA", "config.js"))
        os.makedirs(os.path.join(self.root, "projB"))  # real but has no config.js
        proposed = os.path.join(self.root, "projB", "config.js")
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertFalse(changed)
        self.assertEqual(path, proposed)

    def test_garbled_directory_is_never_guessed(self):
        # The real dir is 'octopus-invader/space-shooter/js'; the model wrote to a
        # DIFFERENT, non-existent dir 'octopus_invaders/js'. Must be a no-op.
        _touch(os.path.join(self.root, "octopus-invader", "space-shooter", "js", "config.js"))
        proposed = os.path.join(self.root, "octopus_invaders", "js", "config.js")
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertFalse(changed)
        self.assertEqual(path, proposed)

    def test_punctuation_only_directory_difference_is_not_crossed(self):
        # 's-space-shooter' vs 's space-shooter' are DIFFERENT real dirs; the old
        # squash() guard treated them as the same. Must not relocate.
        _touch(os.path.join(self.root, "s space-shooter", "css", "styles.css"))
        os.makedirs(os.path.join(self.root, "s-space-shooter", "css"))
        proposed = os.path.join(self.root, "s-space-shooter", "css", "styles.css")
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertFalse(changed)
        self.assertEqual(path, proposed)

    def test_ambiguous_match_is_left_alone(self):
        # Two files squash-match the garbled basename -> ambiguous -> no-op.
        _touch(os.path.join(self.root, "proj", "config.js"))
        _touch(os.path.join(self.root, "proj", "config.ts"))
        proposed = os.path.join(self.root, "proj", "configjs?")  # squashes to 'configjs'/'configts'?
        # Make it genuinely ambiguous: 'config' squashes both 'config.js' and 'config.ts'.
        proposed = os.path.join(self.root, "proj", "config")
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertFalse(changed)
        self.assertEqual(path, proposed)

    def test_legitimate_new_file_passes_through(self):
        # Creating a brand-new file in a real dir with no sibling match -> unchanged.
        os.makedirs(os.path.join(self.root, "proj"))
        proposed = os.path.join(self.root, "proj", "brand_new_helper.js")
        path, changed, _ = norm.normalize_tool_path(proposed)
        self.assertFalse(changed)
        self.assertEqual(path, proposed)

    def test_already_correct_path_unchanged(self):
        real = _touch(os.path.join(self.root, "proj", "a.js"))
        path, changed, _ = norm.normalize_tool_path(real)
        self.assertFalse(changed)
        self.assertEqual(path, real)

    def test_relative_path_is_not_touched(self):
        # No reliable cwd at the proxy -> relative paths pass through untouched.
        path, changed, _ = norm.normalize_tool_path("src/Config.js")
        self.assertFalse(changed)
        self.assertEqual(path, "src/Config.js")

    # --- integration through the public entry point ---

    def test_normalize_tool_uses_applies_and_reports(self):
        real = _touch(os.path.join(self.root, "proj", "config.js"))
        wrong = os.path.join(self.root, "proj", "CONFIG.JS")
        tool_uses = [{"type": "tool_use", "id": "t1", "input": {"file_path": wrong, "content": "y"}}]
        corrections = norm.normalize_tool_uses(tool_uses, known_paths=[])
        self.assertEqual(tool_uses[0]["input"]["file_path"], real)
        self.assertEqual(tool_uses[0]["input"]["content"], "y")  # non-path arg untouched
        self.assertEqual(len(corrections), 1)


if __name__ == "__main__":
    unittest.main()
