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

## WORKTREE WORKFLOW — MANDATORY [REQUIRED]

ALL file changes MUST use a worktree. No exceptions. Never commit directly to main/master.

### Workflow

```bash
# 1. Create worktree for your task
uap worktree create <slug>

# 2. Work in the worktree directory
cd .worktrees/NNN-<slug>/

# 3. Make changes, commit
git add -A && git commit -m "type: description"

# 4. Create PR from worktree
uap worktree pr <id>

# 5. After PR merge, clean up (MANDATORY)
uap worktree cleanup <id>
```

### Rules

1. **Every file change requires a worktree.** Application code, configs, workflows, documentation, even CLAUDE.md itself. No direct commits to main.
2. **Create before editing.** Run `uap worktree create <slug>` before making any file changes.
3. **Work inside the worktree directory.** All edits happen in `.worktrees/NNN-<slug>/`, not in the project root.
4. **One worktree per task.** Each logical unit of work gets its own worktree and branch.
5. **Cleanup is mandatory.** After PR merge, run `uap worktree cleanup <id>`. Stale worktrees are a policy violation.
6. **PR required.** Changes go through `uap worktree pr <id>`, not direct push to main.

### When to Skip (Exceptions)

Worktree creation may be skipped ONLY when:

- Running read-only commands (status, list, query)
- The project has worktrees disabled in `.uap.json` (`template.sections.worktreeWorkflow: false`)

See `policies/worktree-enforcement.md` for full enforcement details.

## Completion Gate [REQUIRED]

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL of the following pass:

1. **New tests written** — Every task that changes code MUST add at least 2 new test cases covering the changed behavior. Tests must be in `test/` following existing patterns (`describe`/`it`/`expect` with vitest). No exceptions for "small changes."
2. **Testing** — `npm test` passes with no failures. Coverage must not regress.
3. **Build** — `npm run build` succeeds with zero errors.
4. **Lint & Type-check** — `npm run lint` (if available) and `tsc --noEmit` pass cleanly.
5. **Version bump** — Run `npm run version:patch`, `version:minor`, or `version:major` based on commit type. Manual `package.json` version edits are prohibited. See `policies/semver-versioning.md`.
6. **Deployment verification** — If the change touches deployable artifacts, deployment to staging/preview must succeed and smoke tests must pass.
7. **Self-review** — Diff has been reviewed for correctness, no debug code, no secrets, no unresolved TODOs.

### Mandatory Test Creation [REQUIRED]

Every code change MUST include at least **2 new test cases** before claiming DONE:

- Tests must cover the **new or changed behavior** (not unrelated code)
- Tests must follow existing patterns: `test/<feature>.test.ts` using vitest (`describe`/`it`/`expect`)
- Tests must actually assert correctness (not just "it doesn't throw")
- If fixing a bug, at least one test must reproduce the bug scenario
- If adding a feature, tests must cover the happy path and at least one edge case
- Run `npm test` to confirm all tests pass including the new ones

### Mandatory Versioning [REQUIRED]

**Policy**: `semver-versioning` (REQUIRED level)

Version bumps are automated and mandatory. Never edit `package.json` version directly.

```bash
npm run version:patch   # fix, chore, refactor, docs, test, style, ci
npm run version:minor   # feat (new backwards-compatible functionality)
npm run version:major   # breaking changes (feat! or BREAKING CHANGE)
```

The script validates clean working tree, runs tests + build, bumps version, updates CHANGELOG.md, commits, and creates a git tag. See `policies/semver-versioning.md`.

### Mandatory Policy Enforcement [REQUIRED]

**Policy**: `mandatory-testing-deployment` (REQUIRED level)

Before claiming task completion, you MUST verify:

- At least 2 new tests written for changed code
- All unit tests passing (`npm test` or equivalent)
- Test coverage maintained or improved (no regression)
- Code linting passes (`npm run lint`)
- TypeScript type checking passes (`tsc --noEmit`)
- Version bumped via `npm run version:<level>` (not manual edit)
- Deployment to staging/preview successful (if applicable)
- Smoke tests passed in target environment (if applicable)
- No new security vulnerabilities detected
- Documentation updated (README, CHANGELOG, API docs)
- Breaking changes documented

### Enforcement Rules

**DO NOT** mark tasks as DONE when:

- No new tests were written for code changes
- Tests are failing or skipped
- Version was not bumped or was bumped manually
- Deployment hasn't been verified
- Code quality gates are bypassed
- Documentation is missing or outdated
- Critical bugs remain open
- Security warnings are ignored

**DO** verify completion by running:

```bash
# Verify build and tests pass (including your new tests)
npm run build && npm test

# Bump version (after all changes are committed)
npm run version:patch  # or version:minor / version:major

# Push with tags
git push && git push --tags
```

If any gate fails, fix the issue and re-run ALL gates before claiming completion.
Skipping or deferring any gate is a policy violation.
See `policies/completion-gate.md` and `policies/semver-versioning.md` for full enforcement details.
