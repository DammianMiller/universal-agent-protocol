"""Shared path resolution for the tools/agents python surfaces.

The agent data layer (memory + coordination DBs) is SHARED across worktrees
and lives at the MAIN checkout root. `git rev-parse --git-common-dir` points
at the shared .git even from a linked worktree (the same resolution the
session-start hook uses for the coordination DB), so both the CLI and the
compliance suite find ONE data layer no matter which checkout hosts the
file — fixing two stale-root bugs at once: the pre-reorg depth arithmetic
(which resolved to `tools/`, pointing the suite at a nonexistent
`tools/agents/data/`) and worktree blindness (a worktree copy of this file
used to look for data inside the worktree, where none exists).
"""

from pathlib import Path
import subprocess
import sys


def main_checkout_root(file_path: Path) -> Path:
    """Resolve the MAIN checkout root from any file inside the repo
    (main checkout or linked worktree). Falls back to the file's own repo
    root when git is unavailable."""
    suite_root = file_path.resolve()
    try:
        r = subprocess.run(
            ["git", "-C", str(suite_root.parent), "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            gcd = Path(r.stdout.strip())
            if not gcd.is_absolute():
                gcd = suite_root.parent / gcd
            return gcd.parent.resolve()
    except Exception as exc:
        # Loud, never silent: the fallback root is a degraded mode and the
        # operator should see WHY the resolution degraded.
        print(f"[paths] git root resolution failed ({exc}); using the file's own root", file=sys.stderr)
    return suite_root.parent
