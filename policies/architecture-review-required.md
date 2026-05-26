# Architecture Review Required

Schema, public API, and cross-cutting architectural changes MUST receive an `architect-reviewer` sign-off and an Architecture Decision Record (ADR) before merge.

## Rules

1. **ADR required for qualifying changes.** Any diff that satisfies *any* of the triggers below must include a new or updated ADR under `docs/architecture/adr/` referenced from the PR description. The ADR must follow the canonical template (Context, Decision, Consequences, Alternatives Considered).

2. **`architect-reviewer` droid invocation required.** The PARALLEL REVIEW PROTOCOL must include `architect-reviewer` for qualifying changes. The reviewer's verdict is recorded in the PR before merge: Accept, Accept with conditions, or Block.

3. **Schema-diff gate output linked.** When the change touches public types, `uap schema-diff` output must be linked in the PR description. The author calls out any detected breaking changes and how they are versioned or migrated.

4. **No silent cross-cutting changes.** Anything that introduces a new shared singleton, global config, error-class root, or cross-module coupling must be called out in the PR description and reviewed.

## Triggers

This policy applies when the diff modifies any of:

- Files under `src/types/**`
- Files under `**/schemas/**`
- Public exports in `src/index.ts`
- Files under `docs/architecture/**` (other than the ADR being added by this PR)
- The capability router (`src/coordination/capability-router.ts`) or pattern router
- Any new top-level directory under `src/`

## Why

Architectural decisions are expensive to reverse. The cost of a wrong call compounds across every consumer that builds on the decision. Capturing the decision, the alternatives, and the rationale in an ADR makes the choice auditable and survivable — even when the original author leaves the project.

Past incidents show that schema drift is the #1 source of breaking-change pain for downstream consumers; making the schema-diff visible in every qualifying PR catches drift at review time, not at consumer-upgrade time.

## How to Apply

1. **Before opening the PR**: invoke `architect-reviewer` via `Task(subagent_type: "architect-reviewer", prompt: ...)`. If the change qualifies, the droid will require an ADR or block.

2. **Author the ADR** at `docs/architecture/adr/NNNN-<slug>.md` using the template:

   ```markdown
   # ADR-NNNN: <Decision title>

   ## Status
   Proposed | Accepted | Superseded by ADR-MMMM

   ## Context
   What forces are at play? What constraint or change prompted this?

   ## Decision
   What did we decide, stated as a single declarative sentence?

   ## Consequences
   What follows from this — positive, negative, and neutral?

   ## Alternatives Considered
   What did we reject, and why?
   ```

3. **Reference the ADR** in the PR description with a direct link.

4. **Run `uap schema-diff`** if the diff touches public types and paste the relevant output into the PR description.

## Exceptions

A PR may proceed without an ADR only if:

- `compliance-officer` grants a time-bounded waiver documented under `policies/waivers/`
- The waiver references a follow-up ticket that will retroactively add the ADR

Waivers are not granted for breaking schema changes.

## Anti-Patterns

DO NOT:

- Land schema changes "for now" with the intent to write the ADR later
- Treat a code comment as a substitute for an ADR
- Skip `architect-reviewer` because "it's just a refactor" when the public surface moves
- Add a new top-level `src/` directory without architect-reviewer sign-off
- Pre-write the ADR and check the box without engaging the reviewer

## Enforcement Level

[REQUIRED]

## Related Policies

- `worktree-enforcement` — Worktree required before any architectural change is staged
- `semver-versioning` — Breaking schema changes trigger MAJOR bump
- `completion-gate` — Architecture review is one of the completion-gate checks for qualifying changes
