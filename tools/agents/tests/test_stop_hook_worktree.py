"""Tests for Option A2: worktree-aware & scaffold-clean stop.sh hook."""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
STOP_SH = REPO_ROOT / "templates" / "hooks" / "stop.sh"


def _git(cwd: Path, *args: str):
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


class StopHookWorktreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "repo"
        self.bin_dir = Path(self.tmp.name) / "bin"
        self.log_file = Path(self.tmp.name) / "uap-verify.log"
        self.root.mkdir()
        self.bin_dir.mkdir()

        _git(self.root, "init", "-b", "main")
        _git(self.root, "config", "user.email", "test@example.com")
        _git(self.root, "config", "user.name", "Test User")
        (self.root / "README.md").write_text("# Demo\n", encoding="utf-8")
        _git(self.root, "add", "README.md")
        _git(self.root, "commit", "-m", "init")

    def tearDown(self):
        self.tmp.cleanup()

    def _install_fake_uap(self, verify_exit: int = 0):
        fake = self.bin_dir / "uap"
        fake.write_text(
            "#!/usr/bin/env bash\n"
            "if [ \"$1\" = \"verify\" ] && [ \"$2\" = \"--help\" ]; then\n"
            "  echo 'usage: uap verify --runtime-only --user-paths-auto --acceptance-auto --dir <dir>'\n"
            "  exit 0\n"
            "fi\n"
            f"printf '%s\\n' \"$*\" >> \"{self.log_file}\"\n"
            "if [ \"$1\" = \"verify\" ]; then\n"
            f"  echo 'FAKE_VERIFY_EXIT={verify_exit}'\n"
            f"  exit {verify_exit}\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

    def _run_stop(self):
        env = dict(os.environ)
        env["CLAUDE_PROJECT_DIR"] = str(self.root)
        env["PATH"] = f"{self.bin_dir}:{env.get('PATH', '')}"
        env["UAP_VERIFY_ON_STOP"] = "1"
        return subprocess.run(
            ["bash", str(STOP_SH)],
            input="",
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_ignores_untracked_uap_scaffolding_on_readonly_session(self):
        self._install_fake_uap(verify_exit=1)
        (self.root / ".factory" / "hooks").mkdir(parents=True)
        (self.root / ".factory" / "hooks" / "helper.js").write_text("console.log(1);\n", encoding="utf-8")
        (self.root / "agents" / "scripts").mkdir(parents=True)
        (self.root / "agents" / "scripts" / "tool.py").write_text("print(1)\n", encoding="utf-8")
        (self.root / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
        (self.root / "CLAUDE.md").write_text("# Claude\n", encoding="utf-8")

        res = self._run_stop()
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertFalse(self.log_file.exists(), "uap verify must NOT run for UAP scaffolding changes")

    def test_detects_modified_source_inside_linked_worktree_and_verifies_worktree(self):
        self._install_fake_uap(verify_exit=1)
        wt = self.root / ".worktrees" / "001-feature"
        wt.parent.mkdir(parents=True, exist_ok=True)
        _git(self.root, "worktree", "add", "-b", "feature/001-feature", str(wt))

        # Write a Python source file inside the linked worktree (main root stays clean)
        (wt / "app.py").write_text("def run():\n    return 42\n", encoding="utf-8")

        res = self._run_stop()
        self.assertEqual(res.returncode, 2, msg=res.stdout + res.stderr)
        self.assertTrue(self.log_file.exists(), "uap verify must run against modified worktree")
        logged = self.log_file.read_text(encoding="utf-8")
        self.assertIn(str(wt), logged)

    def test_allows_stop_when_worktree_verify_passes(self):
        self._install_fake_uap(verify_exit=0)
        wt = self.root / ".worktrees" / "002-clean"
        wt.parent.mkdir(parents=True, exist_ok=True)
        _git(self.root, "worktree", "add", "-b", "feature/002-clean", str(wt))
        (wt / "scene.jsx").write_text("export default function Scene() { return null; }\n", encoding="utf-8")

        res = self._run_stop()
        self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
        self.assertTrue(self.log_file.exists())
        self.assertIn(str(wt), self.log_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
