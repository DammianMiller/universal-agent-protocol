# expert-review-required

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: review
**Tags**: uap, review, quality, enforcement, parallel-expert-review

## Rule

A parallel expert review MUST precede shipping a non-trivial change. When no
review artifact exists for the current branch (or the artifact is stale relative
to `HEAD`), the enforcer blocks the ship actions:

- `git commit`, `git push`
- `gh pr create`
- merge / pr-ready / signoff / ready-for-review operations

Review artifact: `.uap/reviews/<branch-slug>.json`, written by the
`parallel-expert-review` skill on consolidation. The slug is an **injective
percent-encoding** of the branch name (`%`→`%25`, `/`→`%2F`) so distinct refs
like `feature/foo` and `feature-foo` never collide on one artifact. Recognised
shape:

```json
{ "branch": "<name>", "head": "<sha>", "verdict": "approve", "reviewers": ["code-quality-reviewer", "security-code-reviewer", "..."] }
```

If the artifact records a `branch` that differs from the current branch, or a
`head` that differs from the current `HEAD`, the review is rejected (mismatch /
stale) and the op is blocked until a fresh review is recorded. Including
`branch` and `head` is strongly recommended so the artifact unambiguously
identifies what it covers.

## Why

The `parallel-expert-review` skill (and the `architect-reviewer` droid) claim
review is "REQUIRED by policy", but no enforcer ever checked that a review
actually ran — the requirement was advisory and silently skippable. This policy
makes review a hard, artifact-backed gate: ship actions fail until the review
fan-out (code-quality, security, performance, documentation, test-coverage) has
run and its consolidated verdict is recorded for the current HEAD.

This is the review analogue of `task-required` and `worktree-required`: convert
a protocol step that was best-effort into an enforced precondition.

## Enforcement

Python enforcer `expert_review_required.py` resolves the current branch and
HEAD via git, then checks `.uap/reviews/<branch-slug>.json` (slug = branch name
with `/` → `-`). Missing artifact → block; present but `head` mismatch → block
(stale); present and current → allow.

Fail-open: if the branch/HEAD cannot be resolved (detached HEAD, non-git tree),
the operation is allowed. Override for one-off meta-work: `UAP_NO_REVIEW=1`.

```rules
- title: "A parallel expert review must precede ship"
  keywords: [git commit, git push, gh pr create, merge, pr-ready, signoff, ready-for-review]
  antiPatterns: [no-review, unreviewed-ship, skip-review]
```
