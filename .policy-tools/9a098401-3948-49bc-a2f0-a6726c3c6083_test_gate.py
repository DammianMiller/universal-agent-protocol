#!/usr/bin/env python3
"""test-gate enforcer: changed services under services|apps need test deltas."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run  # noqa: E402

PR_OPS_RE = re.compile(
    r"\b(pr[-_ ]?ready|pr-create|gh pr create|signoff|ready[-_ ]for[-_ ]review|merge)\b",
    re.I,
)
SVC_RE = re.compile(r"^(services|apps)/([^/]+)/")
TEST_RE = re.compile(
    r"(/tests?/|__tests__/|\.test\.(ts|tsx|js|py)$|_test\.(py|go)$|\.spec\.(ts|tsx|js)$)"
)


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or "").lower()
    if not (PR_OPS_RE.search(op) or PR_OPS_RE.search(cmd)):
        emit(True, "not a PR-ready gate point")

    root = repo_root()
    rc, out, _ = run(
        ["git", "diff", "--name-only", "origin/main...HEAD"], cwd=root, timeout=10
    )
    if rc != 0:
        emit(True, "cannot compute diff vs origin/main")

    changed = [l for l in out.splitlines() if l.strip()]
    svcs_touched: set[str] = set()
    for f in changed:
        m = SVC_RE.match(f)
        if m:
            svcs_touched.add(f"{m.group(1)}/{m.group(2)}")

    if not svcs_touched:
        emit(True, "no services/apps changes in diff")

    svcs_with_tests = {
        s for s in svcs_touched if any(f.startswith(s) and TEST_RE.search(f) for f in changed)
    }
    missing = svcs_touched - svcs_with_tests
    if missing:
        emit(
            False,
            f"test-gate: the following services changed without test deltas: {', '.join(sorted(missing))}",
        )

    emit(True, "all changed services include test deltas")


if __name__ == "__main__":
    main()
