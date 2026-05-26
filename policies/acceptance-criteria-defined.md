# Acceptance Criteria Defined

Every `feat:` commit and every `epic` task SHOULD declare measurable acceptance criteria before implementation begins. Vague intent leads to scope drift and rework.

## Rules

1. **AC required for feat: PRs.** A PR whose commits include any `feat:` prefix SHOULD include an "Acceptance Criteria" section in the description, or link to a PRD that contains one.

2. **Acceptance criteria must be testable.** Each criterion is stated such that a reasonable person can decide pass/fail without ambiguity. Prefer "given/when/then" or "when X then Y" form.

3. **Outcome metric included.** Each feature states the user-visible or business outcome it changes — measurable where possible.

4. **Non-goals documented.** What the PR explicitly does *not* do, to prevent reviewer scope confusion.

## Triggers

This policy applies when:

- A commit on the PR uses the `feat:` conventional-commit prefix
- The task type is `feature` or `epic`
- A pull request description does not already contain an acceptance section

## Why

Engineers can deliver exactly what is asked and still miss the point if the ask itself was unclear. Writing acceptance criteria before implementation:

- Surfaces hidden constraints (deadline, compliance, backwards-compat) early
- Lets `test-plan-writer` produce a test scaffold that mirrors the criteria
- Gives reviewers an objective basis for sign-off
- Prevents the "looks good, ship it" → "this isn't what I asked for" loop

This is RECOMMENDED rather than REQUIRED because some features genuinely emerge from prototype-to-product evolution where rigid up-front criteria would harm exploration. Use the waiver process for those.

## How to Apply

1. **Invoke `product-strategist`** to extract or author the criteria:
   ```
   Task(subagent_type: "product-strategist",
        prompt: "Generate acceptance criteria for: <feature description>")
   ```

2. **Include the section in the PR description**:

   ```markdown
   ## Acceptance Criteria

   - [ ] AC1: When a user calls `validateDroids()` on a fresh repo, it returns
              every router-referenced droid as `missing-droid`.
   - [ ] AC2: When all 16 expected droids exist with valid frontmatter, the
              validator returns `ok: true` and zero issues.
   - [ ] AC3: When a duplicate droid name exists, the validator emits a
              `duplicate-name` issue naming both files.

   ## Outcome
   New PRs cannot land with a capability-router/droid drift; CI catches it.

   ## Non-Goals
   - Auto-generating missing droid stubs (manual authoring intentionally preserved)
   - Validating skill files (separate concern, future policy)
   ```

3. **Update the criteria** if scope changes during implementation. Don't silently move the goalposts.

## Exceptions

A PR may merge without explicit acceptance criteria when:

- The change is purely internal (refactor, dependency bump, dev tooling)
- The change is a documentation-only update
- A PRD is linked that already contains the criteria

In all other cases, missing criteria results in a `RECOMMENDED` policy notice — not a block — but reviewers may request criteria before approving.

## Anti-Patterns

DO NOT:

- Restate the PR title as the acceptance criterion ("ship the feature")
- Use "improves X" / "better Y" without a metric
- Write criteria after the PR is open as boilerplate
- Treat acceptance criteria as eternal — they live with the PR
- Conflate acceptance criteria with implementation steps

## Enforcement Level

[RECOMMENDED]

May be promoted to REQUIRED for specific subsystems by amending this policy or adding a scoped override.

## Related Policies

- `architecture-review-required` — ACs help the architect-reviewer judge fit
- `completion-gate` — Tests must demonstrate AC satisfaction before DONE
