# Completion Gate

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL gates below pass. No exceptions, no deferrals.

## Rules

1. **New tests must be written.** Every task that changes code MUST add at least 2 new test cases covering the changed behavior. Tests must be in `test/` following existing patterns (`describe`/`it`/`expect` with vitest). Tests must assert correctness, not just "it doesn't throw." If fixing a bug, at least one test must reproduce the bug scenario. If adding a feature, tests must cover the happy path and at least one edge case.

2. **Testing must pass.** Run `npm test` (or the project's test runner). All tests must pass, including the new ones. Coverage must not regress below the configured thresholds. No new test failures are permitted.

3. **Build must succeed.** Run `npm run build`. The build must complete with zero errors. A broken build is never "done."

4. **Lint and type-check must pass.** Run `npm run lint` (if available) and `tsc --noEmit`. All linting and type errors must be resolved before completion.

5. **Version must be bumped.** Run `npm run version:patch`, `version:minor`, or `version:major` based on the commit type. Manual edits to `package.json` version are prohibited. The script validates, bumps, updates CHANGELOG.md, commits, and tags automatically. See `policies/semver-versioning.md`.

6. **Deployment verification is required for deployable changes.** If the change touches deployable artifacts (infrastructure, services, published packages), deployment to staging/preview must succeed and smoke tests must pass in the target environment. A rollback plan must exist for breaking changes.

7. **Worktree must have been used.** All file changes must have been made inside a worktree (`.worktrees/NNN-<slug>/`), not in the project root. The worktree must be cleaned up after PR merge via `uap worktree cleanup <id>`. See `policies/worktree-enforcement.md`.

8. **Self-review is required.** The diff must be reviewed for correctness. No debug code, no secrets, no `console.log` left behind, no unresolved TODOs or FIXMEs.

## Gate Sequence

All gates must be run in order. If any gate fails, fix the issue and re-run ALL gates from the beginning:

```
write 2+ tests   -> new test cases for changed behavior
npm test          -> must pass (no failures, coverage maintained)
npm run build     -> must succeed (zero errors)
npm run lint      -> must pass (if available)
tsc --noEmit      -> must pass (zero type errors)
version bump      -> npm run version:patch/minor/major (automated)
worktree used     -> all changes in .worktrees/NNN-<slug>/, PR created
worktree cleanup  -> uap worktree cleanup <id> after merge
deploy to staging -> must succeed (if deployable change)
smoke tests       -> must pass (if deployable change)
self-review       -> diff reviewed, no debug code, no secrets
```

## When Triggered

This policy is enforced when:

- Task status is being changed to DONE, COMPLETE, or CLOSED
- Pull request is being merged
- Work is being declared finished in any form

## Anti-Patterns

DO NOT:

- Mark tasks as DONE without writing new tests for code changes
- Write tests that only check "it doesn't throw" without asserting behavior
- Mark tasks as DONE when tests are failing or skipped
- Claim completion when the build is broken
- Defer lint/type-check fixes to a follow-up
- Edit package.json version manually instead of using `npm run version:*`
- Skip the version bump for "small changes"
- Commit directly to main/master without a worktree
- Leave stale worktrees after PR merge
- Skip deployment verification for "small changes"
- Bypass any gate with the intent to fix later
- Batch multiple gate failures as "known issues"

## Enforcement Level

[REQUIRED]

## Related Policies

- `worktree-enforcement` — Mandatory worktree usage for all file changes
- `semver-versioning` — Automated version bump rules and script
- `pre-edit-build-gate` — Build verification during editing
- `mandatory-testing-deployment` — Detailed testing and deployment requirements
- `definition-of-done-iac` — Infrastructure-specific completion criteria
