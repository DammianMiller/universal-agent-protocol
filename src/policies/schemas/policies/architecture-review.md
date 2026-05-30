# architecture-review

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: review
**Tags**: uap, architecture, review, adr, enforcement

## Rule

When a PR-ready / merge operation is attempted and the diff vs. upstream touches
architecturally significant paths, the change MUST be accompanied by either an
ADR or an active waiver. Qualifying ("trigger") paths:

- `src/types/**`
- `**/schemas/**`
- `src/index.ts`
- `docs/architecture/**` (excluding `docs/architecture/adr/`)
- `src/coordination/capability-router.ts`, `src/coordination/pattern-router.ts`

The requirement is satisfied by either:

- an ADR under `docs/architecture/adr/*.md` added or modified in the same diff, or
- an active waiver `policies/waivers/*architecture-review*.md`.

Otherwise the ship/merge op is blocked.

## Why

This policy backs the `architect-reviewer` droid's stated authority. The
enforcer already existed and ran, but had **no policy document** describing it —
agents and reviewers had no canonical reference for when architecture review is
required or how to satisfy it. Significant decisions (public types, schemas,
top-level exports, routing logic) carry high blast radius and cost of reversal;
requiring an ADR (or an explicit waiver) ensures they are recorded and reviewed
rather than slipping through in an unrelated change.

## Enforcement

Python enforcer `architecture_review.py` fires on PR-ready/merge operations,
computes `git diff --name-only origin/master...HEAD` (falling back to
`origin/main`), matches the trigger paths, and blocks unless an ADR is present
in the diff or a matching waiver exists.

Fail-open: if the upstream diff cannot be computed, the operation is allowed.
Waivers are granted by `compliance-officer`.

```rules
- title: "Architecturally significant diffs require an ADR or waiver before merge"
  keywords: [merge, pr-ready, gh pr create, signoff, ready-for-review, src/types, schemas, src/index.ts]
  antiPatterns: [no-adr, unreviewed-architecture, skip-architecture-review]
```
