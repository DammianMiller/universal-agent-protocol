# expert-review-required

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: review
**Tags**: uap, review, quality, enforcement, parallel-expert-review

## Rule

A parallel expert review MUST precede shipping a **substantive** change. When no
review artifact exists for the current branch (or the artifact is stale relative
to `HEAD`), the enforcer blocks the ship actions:

- `git commit`, `git push`
- `gh pr create`
- merge / pr-ready / signoff / ready-for-review operations

### Risk scope (low-risk diffs ship freely)

The review is required only when the diff vs upstream touches a **substantive**
surface. A change that touches ONLY low-risk surfaces — frontend/styles
(`.css/.scss/.tsx/.jsx/.vue/.svelte/.html`), docs (`.md`), config
(`.json/.yaml/.toml`), tests, and assets — ships without a parallel review, so
frontend-only / docs-only PRs are never blocked.

High-risk paths ALWAYS require review even with a low-risk extension:
infra/IaC (`infra/`, `terraform/`, `helm/`, `k8s/`, `*.tf`), CI/CD
(`.github/workflows/`), schemas/contracts (`schemas/`, `src/types/`, `*.proto`),
DB migrations (`migrations/`, `*.sql`), container build (`Dockerfile`,
`docker-compose`), and the policy engine (`src/policies/`).

When the upstream base diff is not resolvable (detached HEAD / no upstream), the
enforcer does NOT assume low-risk — the review requirement still applies.

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
the operation is allowed.

Bypasses (two, so a constrained harness always has one available):

- `UAP_NO_REVIEW=1` — environment override (one-off meta-work).
- **File waiver** — a committable file, which works in harnesses that strip env
  vars: any `policies/waivers/*expert-review*.md`, or a `.uap/reviews/WAIVER`
  marker. Use this when the env override can't be set.

```rules
- title: "A parallel expert review must precede ship"
  keywords: [git commit, git push, gh pr create, merge, pr-ready, signoff, ready-for-review]
  antiPatterns: [no-review, unreviewed-ship, skip-review]
```
