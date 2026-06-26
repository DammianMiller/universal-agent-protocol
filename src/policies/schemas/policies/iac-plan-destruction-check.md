# iac-plan-destruction-check

**Category**: infrastructure
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: terraform, iac, destroy, plan-review, merge, safety

## Rule

Before an IaC apply/merge, the terraform plan MUST have been reviewed for
`Destruction` / `must be replaced` / `forces replacement` events.

The gate fires on these Bash commands:

- `terraform apply`
- `gh workflow run <iac-terraform...>` with `action=apply`
- `gh pr merge` / `gh api ...PUT|PATCH .../merge` — **only if the PR being merged touches `infra/terraform/**`**
- `git push origin main` — only if `infra/terraform/**` changed

Satisfy by reviewing the plan, then writing `.uap/iac_plan_reviewed.json`
(`{"reviewed_at": <epoch>, "no_unexpected_destruction": true}`, valid 2h) or
setting `UAP_IAC_PLAN_REVIEWED=1`.

## Why

A lagging pinned version slug against an auto-upgraded cluster is a
destroy-on-next-apply landmine. On 2026-05-31 a routine dashboard PR's
push-to-main apply destroyed an OpenObserve cluster because the plan's
`Destruction` events were never reviewed. Forcing an explicit plan review
before the apply/merge eliminates the blast radius.

## Enforcement

Python enforcer `iac_plan_destruction_check.py`.

**Merge scoping (important):** for a `gh pr merge <N>` command the enforcer
inspects **the PR's own file list** via `gh pr view <N> --json files`, NOT the
local working tree. The earlier implementation read the local checkout
(`git status` / diff vs `origin/main`), which blocked *every* PR merge whenever
the working tree carried unrelated `infra/terraform/*.tf` changes (e.g.
untracked files) — regardless of what the merged PR actually contained. It
falls back to the local-tree check only when no PR number is parseable or the
`gh` lookup fails (fail-safe: the gate stays on). Local default-branch pushes
still use the working-tree diff.

```rules
- title: "IaC apply/merge requires reviewed plan (no unexpected destruction)"
  keywords: [terraform apply, gh pr merge, git push, gh workflow run, iac-terraform]
  antiPatterns: [forces replacement, must be replaced, Destruction]
- title: "PR merges gated by the PR's own files, not the local tree"
  keywords: [gh pr merge, pulls, merge, infra/terraform]
  antiPatterns: [local-working-tree-false-block]
```
