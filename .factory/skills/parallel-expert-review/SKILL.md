---
name: parallel-expert-review
version: '1.0.0'
category: review
priority: 8
triggers:
  - review
  - audit
  - critique
  - parallel
  - "pre-merge"
---

# Parallel Expert Review

## Overview

Formalizes the PARALLEL REVIEW PROTOCOL: invoke multiple expert droids
concurrently for non-trivial changes, then consolidate findings before
commit/merge. Pairs with the `ExpertOrchestrator` for chain selection.

## When to Activate

Engage this skill when:

- A PR is approaching ready-for-review state
- A diff is non-trivial (>50 LOC change, multiple files, or touches a
  hot path like auth, schemas, or public exports)
- The user explicitly asks for "/audit", "/critique", or "parallel review"
- An `architecture-review-required` policy check is triggered
- `uap expert-route <task>` recommends a `review` phase with ≥2 droids

Skip this skill (and document the skip) for:

- Single-line fixes
- Pure rename refactors
- Doc-only changes (use `documentation-accuracy-reviewer` solo)

## Core Principles

1. **Concurrent, not sequential.** Spawn every relevant review droid in
   a single message with multiple Agent tool uses so they run in parallel.
2. **Each droid reads the same diff.** Provide them with the same scope
   (commit range, branch, file list) so findings can be cross-referenced.
3. **Consolidate before responding.** Don't dump four raw reports on the
   user — merge by severity and de-duplicate findings.
4. **Respect priority order.** `security-code-reviewer` blocks take
   precedence over `code-quality-reviewer` nits.

## Workflow Integration

### DECISION LOOP Position

This skill applies at **step 5 (SKILLS)** of the DECISION LOOP, just before
WORK or as part of the REVIEW step:

```
1. CLASSIFY -> non-trivial change detected
2. PROTECT  -> worktree, build-gate, etc.
3. MEMORY   -> query past review failures
4. AGENTS   -> announce intent on coordination channel
5. SKILLS   -> @Skill:parallel-expert-review.md          <— here
6. WORK     -> implement (or finalize implementation)
7. REVIEW   -> consolidate findings, address blockers
```

## Recommended Droid Roster

Default fan-out for a typical code-change PR:

| Droid | Role |
|---|---|
| `code-quality-reviewer` | Diff-focused quality, citations |
| `security-code-reviewer` | Per-diff security regressions (CWE-cited) |
| `performance-reviewer` | Hot-path / allocation regressions |
| `documentation-accuracy-reviewer` | Stale docs, broken examples |
| `test-coverage-reviewer` | Behavior change without tests |

Add per-task:

| Trigger | Add |
|---|---|
| Touches `src/types/**` or schemas | `architect-reviewer` (REQUIRED by policy) |
| Touches API routes / OpenAPI | `api-designer` |
| Touches dependencies | `dependency-auditor` |
| Touches UI components | `accessibility-tester` |
| Touches IaC | `cost-engineer` |

## Invocation Pattern

```
Agent(subagent_type: "code-quality-reviewer",        prompt: <diff scope>)
Agent(subagent_type: "security-code-reviewer",       prompt: <diff scope>)
Agent(subagent_type: "performance-reviewer",         prompt: <diff scope>)
Agent(subagent_type: "documentation-accuracy-reviewer", prompt: <diff scope>)
Agent(subagent_type: "test-coverage-reviewer",       prompt: <diff scope>)
```

Send all five calls in a single assistant message so they execute concurrently.

## Consolidation Format

After all droids return, produce a single summary:

```markdown
## Parallel Review Summary

### 🔴 Blockers
- [security-code-reviewer] src/auth/jwt.ts:42 — algorithms: undefined accepts alg:none
- [test-coverage-reviewer] src/policies/policy-gate.ts:120 — new cache branch untested

### 🟡 Concerns
- [code-quality-reviewer] src/cli/droids.ts:88 — function grew to 78 lines
- [performance-reviewer] src/memory/retrieval.ts:120 — unbounded Promise.all over user input

### ✅ Clean
- documentation-accuracy-reviewer: docs match code surface
```

## Skipping Documentation

If the parallel-review skill is intentionally skipped for a PR, document
the rationale in the PR description ("change is a single-line rename,
no parallel review needed") so reviewers know it was a deliberate choice.

## See Also

- `ExpertOrchestrator` (`src/coordination/expert-orchestrator.ts`) — picks
  the droid chain programmatically
- `uap expert-route <task>` — CLI surface for the same
- `code-quality-guardian` droid — broader, slower; runs *after* this
  skill when authoring full quality reports
