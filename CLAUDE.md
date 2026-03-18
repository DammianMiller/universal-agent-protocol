<!-- CLAUDE.md v2.3.0 - 34 Model Outcome Success Optimizations + Hooks Enforcement -->
<!-- Optimizations #22-27: Template Compression, Structured Iteration, Inline Domain Knowledge, Early Impossibility Exit, Conditional Context, Remove Emphasis Theater -->
<!-- Optimizations #28-34: Mandatory Verifier Loop, Decoder-First Gate, Context Stripping, Environment Check, Schema Diff, State Protection, Conditional Domain -->

<!-- ENFORCEMENT_CHECKS: SESSION_START,DECISION_LOOP,MANDATORY_WORKTREE,PARALLEL_REVIEW,SCHEMA_DIFF,GATES,RTK_INCLUDES,PATTERN_ROUTER,VALIDATE_PLAN -->
<!-- TEMPLATE_VERSION: 2.3.0 -->
<!-- LAST_VALIDATED: 2026-03-18 -->

@hooks-session-start.md
@PreCompact.md

---

## SESSION START

On every session start:

1. Run `uap task ready` to register the agent and surface open tasks
2. Load recent memory context (last 24h, high importance)
3. Clean stale agents from coordination database (heartbeat >24h old)
4. Read and obey ALL policies in `policies/` directory
5. Install git hooks if not present: `npm run install:hooks`

---

## DECISION LOOP

For every task, follow this structured decision loop:

1. **Identify** — What is the task? What files are affected?
2. **Route** — Load the appropriate skill via `@Skill:name.md` if a specialized skill matches
3. **Plan** — Break the task into atomic steps using TodoWrite
4. **Execute** — Work through each step, verifying after each edit
5. **Verify** — Run all gates (build, test, lint, type-check)
6. **Complete** — Only claim DONE after ALL COMPLETION GATES pass

Pattern Router: When a task matches a known pattern (TypeScript edit, IaC change, policy update, test fix), route to the corresponding skill or workflow automatically. See `.claude/skills/` and `.factory/skills/` for available patterns.

---

## WORKTREE WORKFLOW — MANDATORY

ALL file changes MUST use a git worktree. No exceptions. Direct commits to main/master are prohibited.

```bash
uap worktree create <slug>           # Create isolated worktree
cd .worktrees/NNN-<slug>/            # Enter worktree directory
<make changes, build, test>          # All work happens here
git add -A && git commit -m "..."    # Commit in worktree
uap worktree pr <id>                 # Push branch, create PR
<PR review and merge>                # Standard review process
uap worktree cleanup <id>            # Remove worktree (MANDATORY)
```

Enforcement:

- Pre-commit hook blocks direct commits to main/master (`.git/hooks/pre-commit`)
- Completion gate verifies worktree was used
- CI workflow checks for worktree branch naming convention
- See `policies/worktree-enforcement.md` for full rules

---

## PARALLEL REVIEW PROTOCOL

When multiple agents are working concurrently:

1. **Announce work** — Register intent in coordination database before starting
2. **Check conflicts** — Query active work announcements to avoid file collisions
3. **Isolated worktrees** — Each agent works in its own worktree (never share)
4. **Review before merge** — All PRs require review; no self-merging
5. **Sequential merges** — If two PRs touch the same files, merge sequentially and rebase

---

## VERIFIER-FIRST

Before writing any code, verify the current state:

1. **Build gate** — Run `bash scripts/validate-build.sh` to confirm clean baseline
2. **Test gate** — Run `npm test` to confirm all tests pass
3. **Schema gate** — If touching database schemas, run schema diff first
4. **State gate** — If touching IaC, verify state parity first

After writing code, verify again — MANDATORY minimum 3 times:

- After each file edit: `npm run build`
- After all edits: `npm test`
- Before claiming done: full gate sequence

---

## Pre-Edit Build Gate [REQUIRED]

Before editing any `.ts` file, run `npm run build` to confirm the project compiles.
After each file edit, re-run `npm run build` before editing the next file.
If the build fails, fix the error before making any further edits.

- Prefer atomic file writes over multiple incremental edits for complex changes
- Always read the target region + surrounding context before editing to ensure unique anchors
- Never leave the project in a broken build state between edits
- Validation: `bash scripts/validate-build.sh` or `npm run build`

---

## COMPLETION GATES - MANDATORY

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL of the following pass:

BLOCKING PREREQUISITES:

1. **Schema Diff Gate** — If database schema changed, diff must be reviewed and migration created
2. **New tests written** — Every task that changes code MUST add at least 2 new test cases covering the changed behavior. Verified by `npm run verify:tests`. Tests must be in `test/` following existing patterns (`describe`/`it`/`expect` with vitest). No exceptions for "small changes."
3. **Testing** — `npm test` passes with no failures. Coverage must not regress.
4. **Build** — `npm run build` succeeds with zero errors.
5. **Lint & Type-check** — `npm run lint` (if available) and `tsc --noEmit` pass cleanly.
6. **Version bump** — Run `npm run version:patch`, `version:minor`, or `version:major` based on commit type. Manual `package.json` version edits are prohibited. See `policies/semver-versioning.md`.
7. **Worktree used** — All changes made in `.worktrees/NNN-<slug>/`, PR created via `uap worktree pr <id>`.
8. **Deployment verification** — If the change touches deployable artifacts, deployment to staging/preview must succeed and smoke tests must pass.
9. **Self-review** — Diff has been reviewed for correctness, no debug code, no secrets, no unresolved TODOs.

Gate sequence (run in order, restart from beginning if any fails):

```
bash scripts/validate-build.sh       -> baseline clean
npm run verify:tests                  -> new test cases exist in diff
npm test                              -> all tests pass
npm run build                         -> zero errors
npm run lint                          -> passes (if available)
tsc --noEmit                          -> zero type errors
npm run version:patch/minor/major     -> automated version bump
uap worktree pr <id>                  -> PR created from worktree
self-review                           -> diff reviewed, no debug/secrets
```

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

# Verify new tests exist in the diff
npm run verify:tests

# Bump version (after all changes are committed)
npm run version:patch  # or version:minor / version:major

# Push with tags
git push && git push --tags
```

If any gate fails, fix the issue and re-run ALL gates before claiming completion.
Skipping or deferring any gate is a policy violation.
See `policies/completion-gate.md` and `policies/semver-versioning.md` for full enforcement details.
