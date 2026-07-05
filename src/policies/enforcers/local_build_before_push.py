#!/usr/bin/env python3
"""local-build-before-push enforcer.

Blocks `git push` / `gh pr create` / `gh pr merge` when the local branch
contains C++ API source changes that have not been verified by a local
Docker `--target builder` compile. The policy exists because the project's
"compilation check via Docker" CI workflow takes ~50 min from scratch and
~10-20 min cached, while running the same Dockerfile locally takes ~2-5 min
cached. The pentest-remediation saga (2026-05-20) burned several CI cycles
on a jwt-cpp v0.7.0 API mismatch and a sequence of wrong-audience IaC pins
that local builds would have caught immediately.

The pass marker is `.uap/local-build-pass.txt`, written by
`scripts/uap-local-build.sh` after a successful Docker builder-stage build.
The marker contains the verified HEAD SHA; this enforcer allows the push
only when the current HEAD matches.

Bypass: set `UAP_SKIP_LOCAL_BUILD=1` (the override should be justified in
the commit message — there are legitimate cases like remote-only secrets).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run  # noqa: E402

MARKER = ".uap/local-build-pass.txt"

# A push that only touches files outside these prefixes does not need the
# local C++ compile gate. Adjust if more code paths gain expensive builds.
BUILDABLE_PREFIXES = (
    "apps/api/src/",
    "apps/api/include/",
    "apps/api/CMakeLists.txt",
    "apps/api/Dockerfile",
    "apps/api/Dockerfile.optimized",
    "apps/api/Dockerfile.test",
    "apps/api/Dockerfile.ubuntu",
)

# Bash command substrings that trigger the gate. Kept narrow to avoid
# false-positives on unrelated git commands.
PUSH_TRIGGERS = (
    "git push",
    "gh pr create",
    "gh pr merge",
)


def _wants_gate(cmd_lower: str) -> bool:
    return any(trigger in cmd_lower for trigger in PUSH_TRIGGERS)


def _changed_files(root: Path) -> list[str]:
    """Files changed on the current branch vs origin/main."""
    # Make sure we have an origin/main ref to compare against; if not,
    # fall back to comparing against HEAD~10 or HEAD itself.
    rc, _, _ = run(["git", "show-ref", "--verify", "--quiet",
                    "refs/remotes/origin/main"], cwd=root)
    base = "origin/main" if rc == 0 else "HEAD~10"
    rc, out, _ = run(["git", "diff", "--name-only", f"{base}..HEAD"], cwd=root)
    if rc != 0:
        return []
    return [line for line in out.splitlines() if line]


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or args.get("cmd") or "").strip()
    if not cmd or op.lower() != "bash":
        emit(True, "not a Bash command")

    cmd_lower = cmd.lower()
    if not _wants_gate(cmd_lower):
        emit(True, "not a push/PR-create/PR-merge command")

    if os.environ.get("UAP_SKIP_LOCAL_BUILD") == "1":
        emit(True, "UAP_SKIP_LOCAL_BUILD=1 override (justify in commit msg)")

    root = repo_root()

    changed = _changed_files(root)
    needs_build = any(
        f.startswith(p) for f in changed for p in BUILDABLE_PREFIXES
    )
    if not needs_build:
        emit(True, "no buildable C++ API source changes — gate not required")

    rc, head_sha, _ = run(["git", "rev-parse", "HEAD"], cwd=root)
    head_sha = head_sha.strip()
    if not head_sha:
        emit(True, "could not resolve HEAD (allowing)")

    marker_path = root / MARKER
    if marker_path.exists():
        try:
            marker_text = marker_path.read_text()
        except OSError:
            marker_text = ""
        if head_sha in marker_text:
            emit(True, f"local-build-pass marker matches HEAD={head_sha[:10]}")

    short_changed = ", ".join(sorted({
        next((p for p in BUILDABLE_PREFIXES if f.startswith(p)), f)
        for f in changed
    }))[:200]

    emit(
        False,
        "local-build-before-push: apps/api/ source changed "
        f"({short_changed}) but no local-build-pass marker found for "
        f"HEAD={head_sha[:10]}. Run the same Docker compile gate that CI "
        "uses locally:\n"
        "  bash scripts/uap-local-build.sh\n"
        "Cached build takes ~2-5 min; CI takes ~10-50 min. If local build "
        "is genuinely not feasible (e.g. cluster-only secret), set "
        "UAP_SKIP_LOCAL_BUILD=1 and justify in the commit message.",
    )


if __name__ == "__main__":
    main()
