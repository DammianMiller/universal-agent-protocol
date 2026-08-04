#!/usr/bin/env python3
"""expert-review-required enforcer: a parallel expert review must precede ship.

Blocks ship actions (git commit / git push / gh pr create / merge / pr-ready /
signoff) unless a review artifact exists for the branch being shipped AND covers
its HEAD. For `gh pr merge <N>` the branch being shipped is the PR's head
branch, resolved via gh — not whatever branch the invoking shell is on. This makes the `parallel-expert-review` skill's "REQUIRED by
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
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    emit, parse_cli, worktree_root, run, strip_heredoc_bodies,
    REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,
)

# Ship verbs are anchored to their tool prefix so that the bare tokens "merge"
# or "signoff" inside read-only commands (git diff --merge-base, rg merge,
# cat docs/merge-strategy.md) do not trip the gate.
SHIP_PATTERNS = (
    re.compile(r"\bgit\s+(commit|push|merge)\b"),
    re.compile(r"\bgh\s+pr\s+(create|merge|ready)\b"),
    re.compile(r"\b(pr[-_ ]?ready|sign[-_ ]?off|ready[-_ ]for[-_ ]review)\b", re.I),
)

# Additional, command-position detection: `git -C <path> push` is a real ship
# action that the patterns above never matched (they require git and the
# subcommand to be adjacent). Unioned with them, so it only ever ADDS coverage.
# Porcelain verbs, plus the plumbing that does the same job under another
# name. `git send-pack` IS a push (push is a wrapper around it) and
# `commit-tree` + `update-ref` is a commit; neither says "push" or "commit".
GIT_SHIP_SUBCOMMANDS = frozenset({
    "commit", "push", "merge",
    "send-pack", "commit-tree", "update-ref", "fast-import",
})

# `gh api` reaches the same endpoints without ever saying "pr merge":
#   gh api -X PUT repos/o/r/pulls/1/merge
#   gh api graphql -f query=mutation{mergePullRequest(...)}
GH_API_SHIP_RE = re.compile(
    r"pulls/[^/\s]+/merge"
    r"|/merges\b"
    r"|mergePullRequest"
    r"|createPullRequest",
    re.I,
)
GIT_VALUE_OPTIONS = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace"})
WRAPPER_VERBS = frozenset({
    "rtk", "env", "nohup", "sudo", "time", "command", "timeout", "stdbuf",
})
_SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;\n|&])")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")


# Verbs that PRINT or SEARCH their arguments rather than executing them.
# Quoted text is treated as prose only for these.
#
# An allowlist, deliberately. The inverse — masking by default and listing
# the executors to exempt — cannot be completed: bash -c, python -c, perl -e,
# su -c, script -qc, fish -c, parallel, expect ... every review round found
# another, and `script -qc 'git push' /dev/null` really does ship. An
# unrecognised verb here simply scans the raw text, which is the behaviour
# this enforcer always had, so being wrong about one costs nothing.
INERT_VERBS = frozenset({
    "echo", "printf", "cat", "head", "tail", "less", "more",
    "grep", "egrep", "fgrep", "rg", "ag", "ack",
    "wc", "sort", "uniq", "comm", "diff", "cut", "column",
    "ls", "basename", "dirname", "date", "jq", "true", "false",
})


def _mask_prose(text: str) -> str:
    """`text` with the CONTENT of quoted spans blanked.

    Quoted text is where prose lives: a commit message, an echoed string, a
    grep pattern. Blanking it stops a mere MENTION of a ship verb from being
    read as one.

    Returns the text UNCHANGED when the quoting is not simple enough to model
    (an unterminated quote). For this gate the safe direction is to
    over-detect: a review demanded unnecessarily is a nuisance, a ship that
    slips past ungated is the failure this enforcer exists to prevent.
    """
    out = list(text)
    quote = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote is None:
            if ch == "\\":
                i += 2                      # escaped char cannot open a quote
                continue
            if ch in ("'", '"'):
                quote = ch
        elif ch == quote:
            quote = None
        else:
            out[i] = " "
        i += 1
    return text if quote is not None else "".join(out)


def _git_ship_aliases(root: Path) -> frozenset[str]:
    """Alias names that expand to a ship subcommand.

    `git p` is a push when the user's gitconfig says so, and a scanner that
    only knows the porcelain verbs never sees it. git itself is the authority,
    so ask it. Empty on any failure — this only ever ADDS coverage.
    """
    rc, out, _ = run(["git", "config", "--get-regexp", r"^alias" + chr(92) + "."], cwd=root)
    if rc != 0 or not out.strip():
        return frozenset()

    found = set()
    for line in out.splitlines():
        name, _, expansion = line.partition(" ")
        alias = name.split(".", 1)[1] if "." in name else ""
        first = expansion.strip().lstrip("!").split()
        if alias and first and first[0].lower() in GIT_SHIP_SUBCOMMANDS:
            found.add(alias.lower())
    return frozenset(found)


def _ships_at_command_position(text: str, root: Path | None = None) -> bool:
    """True when a segment's VERB is git with a ship subcommand.

    Only used to add `git -C <path> push`; the patterns carry the rest.
    """
    for segment in _SEGMENT_SPLIT.split(text):
        try:
            tokens = shlex.split(segment.strip(), comments=True)
        except ValueError:
            tokens = segment.split()
        while tokens and (_ENV_ASSIGN.match(tokens[0])
                          or os.path.basename(tokens[0]).lower() in WRAPPER_VERBS):
            tokens = tokens[1:]
        if not tokens or os.path.basename(tokens[0]).lower() != "git":
            continue
        rest, i = tokens[1:], 0
        while i < len(rest) and rest[i].startswith("-"):
            i += 2 if rest[i] in GIT_VALUE_OPTIONS else 1
        if i < len(rest):
            sub = rest[i].lower()
            if sub in GIT_SHIP_SUBCOMMANDS:
                return True
            if root is not None and sub in _git_ship_aliases(root):
                return True
    return False


def _only_inert_verbs(text: str) -> bool:
    """True when every segment's verb merely prints or searches its arguments.

    Only then is quoted text safely prose. `hands_text_to_shell` still decides
    the heredoc question upstream; this decides the quoting one.
    """
    saw = False
    for segment in _SEGMENT_SPLIT.split(text):
        try:
            tokens = shlex.split(segment.strip(), comments=True)
        except ValueError:
            return False                     # unlexable: do not mask
        while tokens and (_ENV_ASSIGN.match(tokens[0])
                          or os.path.basename(tokens[0]).lower() in WRAPPER_VERBS):
            tokens = tokens[1:]
        if not tokens:
            continue
        if os.path.basename(tokens[0]).lower() not in INERT_VERBS:
            return False
        saw = True
    return saw


def is_ship_action(command: str, root: Path | None = None) -> bool:
    """True when the command line PERFORMS a ship action.

    The patterns used to run against the raw string, so any text that merely
    NAMED a ship verb tripped the gate — a quoted string, a grep pattern, a
    heredoc body. It self-deadlocked too: writing this gate's own review
    artifact was refused because the notes described the bug being fixed.

    So the prose is removed before matching, rather than the matching being
    replaced. `git commit -m 'mentions gh pr merge'` is still a ship action —
    the commit is outside the quotes.
    """
    text = strip_heredoc_bodies(command or "")
    # Quoted text counts as prose only under a verb that prints or searches it
    # (`echo 'git push'`). Under anything else — a shell, an interpreter, or
    # something nobody listed — the raw text is scanned, as it always was.
    scan = _mask_prose(text) if _only_inert_verbs(text) else text
    if any(p.search(scan) for p in SHIP_PATTERNS):
        return True

    # `gh api` hitting a merge/create endpoint is a ship action however it is
    # spelled. Checked on the same `scan` text, so quoted prose describing an
    # endpoint is still prose.
    if "gh" in scan and GH_API_SHIP_RE.search(scan):
        return True

    return _ships_at_command_position(text, root)

# A ship action that NAMES a pull request. The review that matters is the one
# for that PR's head branch, which is usually not the branch the shell is on.
PR_SHIP_VERBS = ("merge", "ready")

# Flags on those verbs that consume the NEXT token as their value. Without this,
# `gh pr merge -b 1 900` reads "1" as the PR — so the review for PR 1 authorises
# shipping PR 900. `gh pr merge --body Merging 123` misfires the same way by
# accident, which is the more likely path to it happening.
PR_VALUE_FLAGS = frozenset({
    "-b", "--body", "-F", "--body-file", "-t", "--subject",
    "-R", "--repo", "--match-head-commit", "-c", "--comment",
})

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
    wdir = root / REVIEW_WAIVER_DIR
    if wdir.exists():
        for w in wdir.glob("*expert-review*.md"):
            if w.is_file():
                return True
    return (root / REVIEW_ARTIFACT_DIR / "WAIVER").exists()


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


def pr_reference(cmd: str) -> str | None:
    """The pull request a `gh pr merge|ready` command names, or None.

    Tokenized rather than pattern-matched on "digits right after the verb":
    flags may come first (`gh pr merge --squash 645`), and gh accepts a number,
    a URL, or a branch name interchangeably. The narrow form missed all of
    those and fell back to the local branch — silently reinstating the very bug
    this resolution exists to fix.

    A bare `gh pr merge` (the current branch's PR) returns None, which is
    correct: the local branch IS the right thing to check then.
    """
    try:
        tokens = shlex.split(cmd, comments=True)
    except ValueError:
        return None
    for i in range(len(tokens) - 2):
        if (
            os.path.basename(tokens[i]) == "gh"
            and tokens[i + 1] == "pr"
            and tokens[i + 2] in PR_SHIP_VERBS
        ):
            skip_value = False
            for tok in tokens[i + 3:]:
                if skip_value:
                    skip_value = False
                    continue
                if tok.startswith("-"):
                    # `--body=x` carries its value inline; `--body x` does not,
                    # and that value can look exactly like a PR reference.
                    if tok in PR_VALUE_FLAGS:
                        skip_value = True
                    continue
                return tok
            return None
    return None


def pr_target(root: Path, ref: str) -> tuple[str | None, str | None]:
    """(head branch, head sha) of the PR being shipped, resolved via `gh`.

    Returns (None, None) on any failure — no gh, no network, no auth, unknown
    PR — so the caller falls back to the local branch and this stays fail-open.
    `run` already bounds the call at 5s, and PR_SHIP_RE only matches an explicit
    `gh pr merge/ready <N>`, so the cost is paid on ship actions, not per Bash.
    """
    rc, out, _ = run(
        ["gh", "pr", "view", ref, "--json", "headRefName,headRefOid"], cwd=root
    )
    if rc != 0 or not out.strip():
        return None, None
    try:
        data = json.loads(out)
    except Exception:  # noqa: BLE001
        return None, None
    return (data.get("headRefName") or None), (data.get("headRefOid") or None)


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
    # The inline override is GONE, deliberately.
    #
    # It used to parse a leading UAP_NO_REVIEW=1 assignment out of the command
    # string, on the reasoning that the policy-gate hook runs in the harness
    # environment and so cannot see one. That reasoning was correct — but the
    # agent composes its own command strings, which made the override
    # SELF-GRANTABLE. In practice an agent session waived expert review on every
    # ship action it performed. That is not delegating the decision, it is
    # removing the gate.
    #
    # Now environment-only: os.environ is set by whoever launched the session, so
    # the decision stays with the operator. Two env-free routes remain for
    # harnesses that strip the environment, and both are deliberate acts visible
    # in the tree rather than a per-command flag:
    #   - policies/waivers/*expert-review*.md
    #   - .uap/reviews/WAIVER
    # enforcement-self-protect also lists this flag among the bypasses the agent
    # may not set, so an inline attempt is refused with an explicit message
    # instead of appearing to work.
    if not is_ship_action(cmd, worktree_root()):
        emit(True, "not a ship action")

    # Resolve against the WORKING TREE the operation runs in (the worktree when a
    # ship op runs from inside one), NOT the main checkout. repo_root() is pinned
    # to MAIN_ROOT by the gate, so it always read the main checkout's branch and
    # demanded a review for the wrong branch on every worktree commit/push.
    root = worktree_root()

    # `gh pr merge 645` ships PR 645's branch. Reading the LOCAL branch here
    # meant a merge run from the main checkout looked for .uap/reviews/master
    # .json — an artifact for a branch that is not being shipped — and refused
    # a PR whose own branch was reviewed and approved. Resolve the PR's head
    # instead; fall back to the local branch when gh cannot answer.
    pr_ref = pr_reference(cmd)
    pr_branch, pr_sha = pr_target(root, pr_ref) if pr_ref else (None, None)

    branch = pr_branch or current_branch(root)
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
    # Skipped for a PR ship: this diffs the LOCAL working tree, which on a
    # `gh pr merge` from the main checkout is not the PR's contents at all —
    # it would grade the wrong change as low-risk.
    changed = None if pr_branch else _changed_files(root)
    if changed and all(_is_low_risk(f) for f in changed):
        emit(
            True,
            f"low-risk diff ({len(changed)} file(s): frontend/docs/config/tests only) "
            "— parallel expert review not required",
        )

    review = root / REVIEW_ARTIFACT_DIR / f"{slug}.json"
    if not review.exists():
        emit(
            False,
            f"expert-review-required: no review artifact at .uap/reviews/{slug}.json. "
            "Run the parallel-expert-review skill (code-quality, security, performance, "
            "docs, test-coverage reviewers) and record the consolidated verdict before "
            "shipping. Operator override: UAP_NO_REVIEW=1 in the launch environment "
            "(no longer honoured inline), or a waiver file.",
        )

    head = pr_sha or head_sha(root)
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
            "this branch. Operator override: UAP_NO_REVIEW=1 in the launch environment.",
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
