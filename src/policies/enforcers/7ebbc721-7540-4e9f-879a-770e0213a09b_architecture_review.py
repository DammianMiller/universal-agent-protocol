#!/usr/bin/env python3
"""architecture-review-required enforcer.

Triggered when merge / PR-ready operations are attempted and the diff
touches qualifying paths. Requires either:
  - An ADR file under docs/architecture/adr/ added or modified in the same diff, OR
  - An active waiver under policies/waivers/ matching this policy slug
"""
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

# Paths whose modification triggers the architecture-review requirement.
TRIGGER_PATTERNS = [
    re.compile(r"^src/types/"),
    re.compile(r".*/schemas/"),
    re.compile(r"^src/index\.ts$"),
    re.compile(r"^docs/architecture/(?!adr/)"),  # docs/architecture/ but NOT the adr/ we want
    re.compile(r"^src/coordination/(capability|pattern)-router\.ts$"),
]

ADR_PATH_RE = re.compile(r"^docs/architecture/adr/.+\.md$")
WAIVER_RE = re.compile(r"^policies/waivers/.*architecture-review.*\.md$", re.I)


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or "").lower()

    if not (PR_OPS_RE.search(op) or PR_OPS_RE.search(cmd)):
        emit(True, "not a PR-ready gate point")

    root = repo_root()
    rc, out, _ = run(
        ["git", "diff", "--name-only", "origin/master...HEAD"], cwd=root, timeout=10
    )
    if rc != 0:
        # Try origin/main as fallback
        rc, out, _ = run(
            ["git", "diff", "--name-only", "origin/main...HEAD"], cwd=root, timeout=10
        )
    if rc != 0:
        emit(True, "cannot compute diff vs upstream; allowing")

    changed = [line for line in out.splitlines() if line.strip()]

    # Detect qualifying changes
    triggered = []
    for f in changed:
        for pat in TRIGGER_PATTERNS:
            if pat.match(f):
                triggered.append(f)
                break

    if not triggered:
        emit(True, "no architecture-qualifying paths touched in diff")

    # Look for an ADR in the diff
    adr_present = any(ADR_PATH_RE.match(f) for f in changed)

    # Look for an active waiver
    waiver_present = False
    waivers_dir = root / "policies" / "waivers"
    if waivers_dir.exists():
        for waiver in waivers_dir.glob("*architecture-review*.md"):
            if waiver.is_file():
                waiver_present = True
                break

    if adr_present or waiver_present:
        emit(
            True,
            f"architecture-review satisfied "
            f"({'adr-in-diff' if adr_present else 'active-waiver'})",
            adr=adr_present,
            waiver=waiver_present,
            triggers=sorted(set(triggered)),
        )

    emit(
        False,
        "architecture-review-required: diff touches "
        f"{', '.join(sorted(set(triggered))[:3])} but no ADR under "
        "docs/architecture/adr/ and no active waiver. "
        "Add an ADR or request a waiver from compliance-officer.",
        triggers=sorted(set(triggered)),
    )


if __name__ == "__main__":
    main()
