<!-- CLAUDE.md v2.3.0 - 34 Model Outcome Success Optimizations + Hooks Enforcement -->
<!-- Optimizations #22-27: Template Compression, Structured Iteration, Inline Domain Knowledge, Early Impossibility Exit, Conditional Context, Remove Emphasis Theater -->
<!-- Optimizations #28-34: Mandatory Verifier Loop, Decoder-First Gate, Context Stripping, Environment Check, Schema Diff, State Protection, Conditional Domain -->

<!-- ENFORCEMENT_CHECKS: SESSION_START,DECISION_LOOP,MANDATORY_WORKTREE,PARALLEL_REVIEW,SCHEMA_DIFF,GATES,RTK_INCLUDES,PATTERN_ROUTER,VALIDATE_PLAN -->
<!-- TEMPLATE_VERSION: 2.3.0 -->
<!-- LAST_VALIDATED: 2026-03-09 -->

@hooks-session-start.md
@PreCompact.md

<!-- Custom Sections (preserved from existing file) -->

## Pre-Edit Worktree Gate [REQUIRED]

Before editing ANY file, verify you are working inside a worktree:

1. Run `uap worktree ensure --strict` — must exit 0
2. If not in a worktree, run `uap worktree create <slug>` first
3. All file paths in edit operations must be under `.worktrees/NNN-<slug>/`
4. Never edit files in the project root directory
5. Version bumps must be done on the feature branch, not master

This gate applies to ALL file types: .ts, .md, .json, .sh, .yaml, configs, tests, docs.
No exceptions for "small changes", "just docs", or "version bumps".

---

---

---

---

---

---

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

---

---

---

---

---

---

## VERIFIER-FIRST

Before implementing any change, verify the current state first:

1. Run the existing test suite to establish a baseline
2. Confirm the build compiles before making changes
3. Check for existing patterns that solve the same problem
4. Verify assumptions by reading source code, not guessing

The verifier loop MUST run MANDATORY minimum 3 times:
- Once before changes (baseline)
- Once after changes (validation)
- Once after all fixes (final confirmation)

---

---

---

---

---

---

---

## Pattern Router

The pattern router automatically matches tasks to execution patterns from `.factory/patterns/index.json`.

- Critical patterns P12 (Output Existence) and P35 (Decoder-First) are always enforced
- Patterns are indexed in Qdrant for semantic search (collection: `agent_patterns`)
- The adaptive pattern engine learns from task outcomes to improve routing
- Per-prompt hooks inject relevant patterns into context automatically

---

---

---

---

---

---

---

## BLOCKING PREREQUISITES

Before any code change can proceed, these gates must pass in order:

1. **Schema Diff Gate** — If the change touches database schemas, config schemas, or API contracts, diff the schema before and after. Breaking changes require explicit approval.
2. **Worktree Gate** — Must be working inside a worktree (not project root)
3. **Build Gate** — `npm run build` must pass
4. **Test Gate** — `npm test` must pass

---

---

---

---

---

---

---

## PLAN VALIDATION REQUIRED [REQUIRED]

**After generating any plan, BEFORE offering options or user interaction, you MUST prompt for plan validation.**

### Why:
Plans represent significant architectural decisions. User validation ensures alignment before implementation begins, preventing wasted effort on incorrect approaches.

### How to apply:
After generating a plan (using `ExitPlanMode` or similar), ALWAYS include:

```

---

---

---

## Plan Validation Required

Before proceeding with implementation, please validate this plan:
- Does this approach meet the requirements?
- Are there any concerns or alternative approaches you'd prefer?
- Should I adjust anything before implementing?

Reply "validate" or "approved" to proceed, or provide feedback for adjustments.
```

**This is mandatory for all non-trivial tasks. No exceptions.**

---

---

---

---

## COMPLETION GATES - MANDATORY

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

---

---

---

---

## SESSION ANALYSIS REQUIRED [REQUIRED]

**Before ending a session or stopping work, analyze and report any incomplete tasks or sudden stops.**

### Why:
Sudden stops without completion indicate potential issues: misunderstood requirements, unexpected obstacles, or premature conclusions. Documenting these patterns helps improve future task completion.

### How to apply:
When ending a session, before claiming completion, check:

1. **Were all instructions fully executed?** If not, document what was left incomplete.
2. **Did I stop mid-task?** Report any tasks that were in-progress when stopping.
3. **What blocked me?** Document obstacles encountered (policy blocks, unclear requirements, technical issues).
4. **Pattern analysis**: Have I stopped abruptly before? What caused it?

Include a "Session Analysis" section in the final response:

```

---

---

---

## Session Analysis

**Completed Tasks:**
- [x] Task 1 description
- [x] Task 2 description

**Incomplete/Stopped Work:**
- [ ] Task 3 - Stopped because: [reason]

**Pattern Observation:**
[Note any sudden stops during this session and their causes]
```

---

---

---

---

## PHANTOM ERROR INVESTIGATION REQUIRED [REQUIRED]

**When encountering errors that don't reproduce on individual files or seem inconsistent, investigate thoroughly before accepting them as valid blockers.**

### Why:
Phantom errors (cache issues, stale reports, false positives) waste time and prevent legitimate work. Blindly accepting them as real blockers is a form of giving up.

### How to apply:
When encountering suspicious errors:

1. **Reproduce independently**: Run the command on individual affected files
2. **Clear caches**: Remove `.eslintcache`, `node_modules/.vite`, etc.
3. **Check line contents**: Verify the reported lines actually contain the problematic code
4. **Try alternatives**: If lint fails but build/test pass, try direct execution
5. **Document investigation**: If errors persist, document what was tried

**Only accept errors as valid after thorough investigation.**