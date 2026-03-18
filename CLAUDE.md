<!-- CLAUDE.md v2.3.0 - 34 Model Outcome Success Optimizations + Hooks Enforcement -->
<!-- Optimizations #22-27: Template Compression, Structured Iteration, Inline Domain Knowledge, Early Impossibility Exit, Conditional Context, Remove Emphasis Theater -->
<!-- Optimizations #28-34: Mandatory Verifier Loop, Decoder-First Gate, Context Stripping, Environment Check, Schema Diff, State Protection, Conditional Domain -->

<!-- ENFORCEMENT_CHECKS: SESSION_START,DECISION_LOOP,MANDATORY_WORKTREE,PARALLEL_REVIEW,SCHEMA_DIFF,GATES,RTK_INCLUDES,PATTERN_ROUTER,VALIDATE_PLAN -->
<!-- TEMPLATE_VERSION: 2.3.0 -->
<!-- LAST_VALIDATED: 2026-03-09 -->

@hooks-session-start.md
@PreCompact.md

<!-- Custom Sections (preserved from existing file) -->

## Pre-Edit Build Gate [REQUIRED]

Before editing any `.ts` file, run `npm run build` to confirm the project compiles.
After each file edit, re-run `npm run build` before editing the next file.
If the build fails, fix the error before making any further edits.

- Prefer atomic file writes over multiple incremental edits for complex changes
- Always read the target region + surrounding context before editing to ensure unique anchors
- Never leave the project in a broken build state between edits
- Validation: `bash scripts/validate-build.sh` or `npm run build`

## Completion Gate [REQUIRED]

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL of the following pass:

1. **Testing** — `npm test` passes with no failures. Coverage must not regress.
2. **Build** — `npm run build` succeeds with zero errors.
3. **Lint & Type-check** — `npm run lint` (if available) and `tsc --noEmit` pass cleanly.
4. **Deployment verification** — If the change touches deployable artifacts, deployment to staging/preview must succeed and smoke tests must pass.
5. **Self-review** — Diff has been reviewed for correctness, no debug code, no secrets, no unresolved TODOs.

### Mandatory Policy Enforcement [REQUIRED]

**Policy**: `mandatory-testing-deployment` (REQUIRED level)

Before claiming task completion, you MUST verify:

- ✅ All unit tests passing (`npm test` or equivalent)
- ✅ Test coverage maintained or improved (no regression)
- ✅ Code linting passes (`npm run lint`)
- ✅ TypeScript type checking passes (`tsc --noEmit`)
- ✅ Deployment to staging/preview successful (if applicable)
- ✅ Smoke tests passed in target environment (if applicable)
- ✅ No new security vulnerabilities detected
- ✅ Documentation updated (README, CHANGELOG, API docs)
- ✅ Breaking changes documented

### Enforcement Rules

**DO NOT** mark tasks as DONE when:

- ❌ Tests are failing or skipped
- ❌ Deployment hasn't been verified
- ❌ Code quality gates are bypassed
- ❌ Documentation is missing or outdated
- ❌ Critical bugs remain open
- ❌ Security warnings are ignored

**DO** verify completion by running:

```bash
# Check policy status
uap policy list

# Run all compliance checks
uap compliance check

# Verify build and tests pass
npm run build && npm test
```

If any gate fails, fix the issue and re-run ALL gates before claiming completion.
Skipping or deferring any gate is a policy violation.
See `policies/completion-gate.md` for full enforcement details.
