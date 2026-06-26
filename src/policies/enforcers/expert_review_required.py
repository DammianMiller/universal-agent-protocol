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

# Ship verbs are anchored to their tool prefix so that the bare tokens "merge"
# or "signoff" inside read-only commands (git diff --merge-base, rg merge,
# cat docs/merge-strategy.md) do not trip the gate.
SHIP_PATTERNS = (
    re.compile(r"\bgit\s+(commit|push|merge)\b"),
    re.compile(r"\bgh\s+pr\s+(create|merge|ready)\b"),
    re.compile(r"\b(pr[-_ ]?ready|sign[-_ ]?off|ready[-_ ]for[-_ ]review)\b", re.I),
)

# Risk-scope: a parallel expert review is required only for *substantive* diffs.
# A diff that touches ONLY low-risk surfaces (frontend/styles, docs, config,
# tests, assets) ships freely — trivial/frontend PRs aren't gated. High-risk
# paths (infra/IaC, CI/CD, schemas/contracts, DB migrations, the policy engine)
# always require review, even with a low-risk extension.
LOW_RISK_EXT = {
    ".css", ".scss", ".sass", ".less", ".html", ".astro", ".vue", ".svelte",
    ".tsx", ".jsx", ".md", ".mdx", ".txt", ".csv", ".svg", ".png", ".jpg",
    ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
    ".json", ".yaml", ".yml", ".toml", ".lock", ".lockb",
}
LOW_RISK_DIR_RE = re.compile(
    r"(^|/)(docs|public|assets|static|stories|__tests__|tests?|e2e|fixtures)/", re.I
)
HIGH_RISK_PATH_RE = re.compile(
    r"(^|/)(infra|terraform|helm|helm_charts|k8s|kubernetes)/"
    r"|\.tf$|\.tfvars$|\.tf\.json$"
    r"|(^|/)\.github/workflows/"
    r"|(^|/)migrations?/|\.sql$"
    r"|(^|/)schemas/|^src/types/|\.proto$"
    r"|(^|/)[Dd]ockerfile|docker-compose"
    r"|^src/policies/",
)


def _changed_files(root: Path) -> list[str] | None:
    """Files changed vs the upstream base, or None if no base is resolvable
    (detached / no upstream — the caller then falls back to requiring review)."""
    for base in ("origin/master", "origin/main", "master", "main"):
        rc, out, _ = run(["git", "diff", "--name-only", f"{base}...HEAD"], cwd=root, timeout=10)
        if rc == 0:
            return [ln.strip() for ln in out.splitlines() if ln.strip()]
    return None


def _is_low_risk(f: str) -> bool:
    if HIGH_RISK_PATH_RE.search(f):
        return False
    if LOW_RISK_DIR_RE.search(f):
        return True
    return Path(f).suffix.lower() in LOW_RISK_EXT


def _active_waiver(root: Path) -> bool:
    """A committable, env-free bypass: an active waiver file. Works in harnesses
    that strip env vars (where UAP_NO_REVIEW=1 cannot be set)."""
    wdir = root / "policies" / "waivers"
    if wdir.exists():
        for w in wdir.glob("*expert-review*.md"):
            if w.is_file():
                return True
    return (root / ".uap" / "reviews" / "WAIVER").exists()


def current_branch(root: Path) -> str | None:
    # symbolic-ref resolves the branch name even on an unborn branch (no commits
    # yet); rev-parse --abbrev-ref returns "HEAD" in that state.
    rc, out, _ = run(["git", "symbolic-ref", "--short", "HEAD"], cwd=root)
    if rc == 0 and out.strip():
        return out.strip()
    rc, out, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
    if rc == 0 and out.strip() and out.strip() != "HEAD":
        return out.strip()
    return None


def slug_for(branch: str) -> str:
    """Injective filename slug for a branch ref.

    A naive `/`->`-` substitution collapses distinct refs (`feature/foo` and
    `feature-foo`, which can coexist) onto the same artifact, silently bypassing
    the gate. Percent-encode `%` first, then `/`, so the mapping is reversible
    and collision-free: `feature/foo` -> `feature%2Ffoo`, `feature-foo` stays
    `feature-foo`.
    """
    return branch.replace("%", "%25").replace("/", "%2F")


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
    branch = current_branch(root)
    if branch is None:
        emit(True, "branch not resolvable (detached/non-git) — fail-open")
    slug = slug_for(branch)

    # Env-free bypass: an active waiver file (works where UAP_NO_REVIEW=1 can't).
    if _active_waiver(root):
        emit(True, "expert-review waived (policies/waivers/*expert-review*.md or .uap/reviews/WAIVER)")

    # Risk-scope: if the diff vs upstream touches ONLY low-risk surfaces
    # (frontend/styles, docs, config, tests, assets) — no infra/IaC, CI, schemas,
    # migrations, or policy code — the change ships without a parallel review.
    # When the base diff is not resolvable (None) we do NOT skip: we can't prove
    # the change is low-risk, so the review requirement below still applies.
    changed = _changed_files(root)
    if changed and all(_is_low_risk(f) for f in changed):
        emit(
            True,
            f"low-risk diff ({len(changed)} file(s): frontend/docs/config/tests only) "
            "— parallel expert review not required",
        )

    review = root / ".uap" / "reviews" / f"{slug}.json"
    if not review.exists():
        emit(
            False,
            f"expert-review-required: no review artifact at .uap/reviews/{slug}.json. "
            "Run the parallel-expert-review skill (code-quality, security, performance, "
            "docs, test-coverage reviewers) and record the consolidated verdict before "
            "shipping. Override for one-off meta-work: UAP_NO_REVIEW=1.",
        )

    head = head_sha(root)
    try:
        data = json.loads(review.read_text())
    except Exception:  # noqa: BLE001
        data = {}

    # Defense-in-depth against artifact reuse across branches: if the artifact
    # records the branch it covers, it must match the current branch.
    artifact_branch = data.get("branch") if isinstance(data, dict) else None
    if artifact_branch and artifact_branch != branch:
        emit(
            False,
            f"expert-review-required: review at .uap/reviews/{slug}.json covers branch "
            f"'{artifact_branch}', not '{branch}'. Re-run the parallel expert review on "
            "this branch. Override: UAP_NO_REVIEW=1.",
        )

    # Stale check relative to current HEAD.
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
