<!-- CLAUDE.md v2.4.0 - 34 Model Outcome Success Optimizations + Hooks Enforcement -->
<!-- Optimizations #22-27: Template Compression, Structured Iteration, Inline Domain Knowledge, Early Impossibility Exit, Conditional Context, Remove Emphasis Theater -->
<!-- Optimizations #28-34: Mandatory Verifier Loop, Decoder-First Gate, Context Stripping, Environment Check, Schema Diff, State Protection, Conditional Domain -->

<!-- ENFORCEMENT_CHECKS: SESSION_START,DECISION_LOOP,MANDATORY_WORKTREE,PARALLEL_REVIEW,SCHEMA_DIFF,GATES,RTK_INCLUDES,PATTERN_ROUTER,VALIDATE_PLAN -->
<!-- TEMPLATE_VERSION: 2.4.0 -->
<!-- LAST_VALIDATED: 2026-05-14 -->

<!-- Custom Sections (preserved from existing file) -->

## SESSION START

Before making implementation changes, run `bash .codex/hooks/session-start.sh`
to print the session banner and load short-term memory. Then run
`uap task ready` to surface available work and verify the coordination DB is
healthy. Read-only investigation (questions, diagnostics) does not require
either command.

```bash
bash .codex/hooks/session-start.sh   # banner + memory hydration
uap task ready                        # task readiness check
```

The session-start hook is self-healing — it auto-creates missing
coordination DBs and fails open so it never blocks the agent. Treat its
output as advisory context, not a gate.

## DECISION LOOP

When working on a task, follow the loop:

1. **READ** short-term memory for recent context (`uap memory query`)
2. **QUERY** long-term memory for related learnings (semantic search)
3. **MATCH** specialized skills via `@Skill:name.md` references — invoke
   them through the Skill tool before writing code when a domain-specific
   workflow applies (`/critique`, `/audit`, `/harden`, `/normalize`, etc.)
4. **THINK** about what to do next; classify task complexity
5. **ACT** — execute via the appropriate tool (Edit/Write/Bash)
6. **RECORD** observations to short-term memory
7. **PROMOTE** significant learnings to long-term memory

The mermaid version of this loop lives in [AGENT.md](AGENT.md#decision-loop).

## COMPLETION GATES - MANDATORY

Completion gates are MANDATORY and must be verified minimum 3 times before claiming done.

## WORKTREE WORKFLOW — MANDATORY

All file edits must happen inside a worktree under `.worktrees/NNN-<slug>/`.
Never edit files in the project root directory. The workflow is:

1. `uap worktree ensure --strict` — verify you're already inside a worktree
2. If not: `uap worktree create <slug>` — auto-numbered branch + worktree
3. Stage and commit only inside that worktree
4. Open PRs from the worktree branch against `master`
5. Version bumps must be done on the feature branch, not master

See the WORKTREE GATE section below for the per-edit enforcement details.

## PARALLEL REVIEW PROTOCOL

For non-trivial changes, run review angles concurrently before claiming done:

- `code-reviewer` — correctness, tests, migration risk
- `security-auditor` — input validation, secrets, OWASP top 10
- `architect-reviewer` — pattern fit, blast radius, maintainability

Invoke them as separate Agent calls in a single message so they run in
parallel; consolidate findings before commit. Skip this only when the change
is genuinely small (renames, doc tweaks, single-line fixes); document the
skip in the PR description.

---

---

---

---

---

---

---

---

---

---

---

---

---

## WORKTREE GATE [REQUIRED — code changes only]

Before editing ANY source file, verify you are working inside a worktree:

1. Run `uap worktree ensure --strict` -- must exit 0
2. If not in a worktree, run `uap worktree create <slug>` first
3. All file paths in edit operations must be under `.worktrees/NNN-<slug>/`
4. Never edit files in the project root directory
5. Version bumps must be done on the feature branch, not master

This gate applies to ALL file types: .ts, .md, .json, .sh, .yaml, configs, tests, docs.
No exceptions for "small changes", "just docs", or "version bumps".

**Read-only tasks** (analysis, diagnostics, queries) do NOT require a worktree.

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## PRE-EDIT BUILD GATE [REQUIRED — .ts files only]

Before editing any `.ts` file, run `npm run build` to confirm the project compiles.
After each file edit, re-run `npm run build` before editing the next file.
If the build fails, fix the error before making any further edits.

- Prefer atomic file writes over multiple incremental edits for complex changes
- Always read the target region + surrounding context before editing to ensure unique anchors
- Never leave the project in a broken build state between edits

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

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

Run verification at least: before changes, after changes, and after all fixes.

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## PATTERN ROUTER

The pattern router automatically matches tasks to execution patterns from `.factory/patterns/index.json`.
Critical patterns P12 (Output Existence) and P35 (Decoder-First) are always enforced.

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## BLOCKING PREREQUISITES [code changes only]

Before any code change can proceed, these gates must pass in order:

1. **Schema Diff Gate** -- If the change touches schemas or API contracts, diff before and after.
2. **Worktree Gate** -- Must be working inside a worktree (not project root)
3. **Build Gate** -- `npm run build` must pass
4. **Test Gate** -- `npm test` must pass

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## PLAN VALIDATION [REQUIRED — non-trivial tasks]

After generating any implementation plan, prompt for user validation before proceeding.

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## COMPLETION GATES [REQUIRED — code changes only]

Claiming DONE is prohibited until ALL of the following pass:

1. **New tests** -- At least 2 new test cases covering changed behavior (vitest, `test/` dir)
2. **Testing** -- `npm test` passes with no failures
3. **Build** -- `npm run build` succeeds with zero errors
4. **Lint & Type-check** -- `tsc --noEmit` passes cleanly
5. **Version bump** -- `npm run version:patch/minor/major` based on commit type (no manual edits)
6. **Deployment** -- If touching deployable artifacts, staging deploy + smoke tests must pass
7. **Self-review** -- Diff reviewed for correctness, no debug code, no secrets, no unresolved TODOs

### Versioning

```bash
npm run version:patch   # fix, chore, refactor, docs, test, style, ci
npm run version:minor   # feat (new backwards-compatible functionality)
npm run version:major   # breaking changes (feat! or BREAKING CHANGE)
```

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## SESSION ANALYSIS [REQUIRED]

Before ending a session, document:
- Completed tasks
- Incomplete/stopped work with reasons
- Pattern observations (sudden stops, blockers)

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## PHANTOM ERROR INVESTIGATION [REQUIRED]

When encountering errors that don't reproduce or seem inconsistent:
1. Reproduce independently on individual files
2. Clear caches (`.eslintcache`, `node_modules/.vite`, etc.)
3. Verify reported lines actually contain the problematic code
4. Only accept errors as valid after thorough investigation