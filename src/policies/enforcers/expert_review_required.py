#!/usr/bin/env python3
"""expert-review-required enforcer: a parallel expert review must precede ship.

Blocks ship actions (git commit / git push / gh pr create / merge / pr-ready /
signoff) unless a review artifact exists for the current branch AND covers the
current HEAD. This makes the `parallel-expert-review` skill's "REQUIRED by
policy" claim real rather than advisory.

Review artifact: .uap/reviews/<branch-slug>.json, written by the
parallel-expert-review flow on consolidation. Recognised shape:
    { "head": "<sha>", "verdict": "approve|...", "reviewers": [...] }
If the artifact carries a `head` that differs from the current HEAD, the review
is stale and the op is blocked.

Fail-open: if branch/HEAD cannot be resolved, the op is allowed — non-UAP repos
and detached states are unaffected. Override: set UAP_NO_REVIEW=1 to bypass.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, run  # noqa: E402

SHIP_PATTERNS = (
    re.compile(r"\bgit\s+(commit|push)\b"),
    re.compile(r"\bgh\s+pr\s+create\b"),
    re.compile(r"\b(merge|pr[-_ ]?ready|signoff|ready[-_ ]for[-_ ]review)\b", re.I),
)


def branch_slug(root: Path) -> str | None:
    # symbolic-ref resolves the branch name even on an unborn branch (no commits
    # yet); rev-parse --abbrev-ref returns "HEAD" in that state.
    rc, out, _ = run(["git", "symbolic-ref", "--short", "HEAD"], cwd=root)
    if rc == 0 and out.strip():
        return out.strip().replace("/", "-")
    rc, out, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
    if rc != 0:
        return None
    name = out.strip()
    if not name or name == "HEAD":  # detached
        return None
    return name.replace("/", "-")


def head_sha(root: Path) -> str | None:
    rc, out, _ = run(["git", "rev-parse", "HEAD"], cwd=root)
    return out.strip() if rc == 0 and out.strip() else None


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_NO_REVIEW") == "1":
        emit(True, "UAP_NO_REVIEW override set")

    op_l = op.lower()
    if op_l != "bash":
        emit(True, "not a ship operation")

    cmd = args.get("command") or args.get("cmd") or ""
    if not any(p.search(cmd) for p in SHIP_PATTERNS):
        emit(True, "not a ship action")

    root = repo_root()
    slug = branch_slug(root)
    if slug is None:
        emit(True, "branch not resolvable (detached/non-git) — fail-open")

    review = root / ".uap" / "reviews" / f"{slug}.json"
    if not review.exists():
        emit(
            False,
            f"expert-review-required: no review artifact at .uap/reviews/{slug}.json. "
            "Run the parallel-expert-review skill (code-quality, security, performance, "
            "docs, test-coverage reviewers) and record the consolidated verdict before "
            "shipping. Override for one-off meta-work: UAP_NO_REVIEW=1.",
        )

    # Artifact exists — check it is not stale relative to current HEAD.
    head = head_sha(root)
    try:
        data = json.loads(review.read_text())
    except Exception:  # noqa: BLE001
        data = {}

    reviewed_head = data.get("head") if isinstance(data, dict) else None
    if reviewed_head and head and reviewed_head != head:
        emit(
            False,
            f"expert-review-required: review at .uap/reviews/{slug}.json covers "
            f"{reviewed_head[:8]} but HEAD is {head[:8]} — the review is stale. "
            "Re-run the parallel expert review for the current changes. "
            "Override: UAP_NO_REVIEW=1.",
        )

    emit(
        True,
        f"expert-review satisfied (.uap/reviews/{slug}.json"
        + (f", head {reviewed_head[:8]}" if reviewed_head else "")
        + ")",
    )


if __name__ == "__main__":
    main()
