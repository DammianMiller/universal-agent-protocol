# Completion Gate

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL gates below pass. No exceptions, no deferrals.

## Rules

1. **Testing must pass.** Run `npm test` (or the project's test runner). All tests must pass. Coverage must not regress below the configured thresholds. No new test failures are permitted.

2. **Build must succeed.** Run `npm run build`. The build must complete with zero errors. A broken build is never "done."

3. **Lint and type-check must pass.** Run `npm run lint` (if available) and `tsc --noEmit`. All linting and type errors must be resolved before completion.

4. **Deployment verification is required for deployable changes.** If the change touches deployable artifacts (infrastructure, services, published packages), deployment to staging/preview must succeed and smoke tests must pass in the target environment. A rollback plan must exist for breaking changes.

5. **Self-review is required.** The diff must be reviewed for correctness. No debug code, no secrets, no `console.log` left behind, no unresolved TODOs or FIXMEs.

## Gate Sequence

All gates must be run in order. If any gate fails, fix the issue and re-run ALL gates from the beginning:

```
npm test          → must pass (no failures, coverage maintained)
npm run build     → must succeed (zero errors)
npm run lint      → must pass (if available)
tsc --noEmit      → must pass (zero type errors)
deploy to staging → must succeed (if deployable change)
smoke tests       → must pass (if deployable change)
self-review       → diff reviewed, no debug code, no secrets
```

## When Triggered

This policy is enforced when:

- Task status is being changed to DONE, COMPLETE, or CLOSED
- Pull request is being merged
- Work is being declared finished in any form

## Anti-Patterns

DO NOT:

- Mark tasks as DONE when tests are failing or skipped
- Claim completion when the build is broken
- Defer lint/type-check fixes to a follow-up
- Skip deployment verification for "small changes"
- Bypass any gate with the intent to fix later
- Batch multiple gate failures as "known issues"

## Enforcement Level

[REQUIRED]

## Related Policies

- `pre-edit-build-gate` — Build verification during editing
- `mandatory-testing-deployment` — Detailed testing and deployment requirements
- `definition-of-done-iac` — Infrastructure-specific completion criteria
