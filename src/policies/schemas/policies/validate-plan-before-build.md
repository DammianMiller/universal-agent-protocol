# validate-plan-before-build

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: planning, validation, accuracy

## Rule

When a plan is marked ready and the agent is about to begin implementation (first mutating tool call after plan emission: `Edit`, `Write`, `MultiEdit`, `Bash` that modifies state), the agent MUST first execute the prompt `validate the plan` and receive an explicit pass before proceeding.

A plan is "ready" when:
- User approves with "go", "build", "implement", "proceed", "ship it", "complete all", or similar
- OR the agent emits ExitPlanMode / transitions out of a Plan phase

## Why

User directive: "when a plan is ready to build, execute prompt 'validate the plan'". Prevents shipping on stale/unvalidated plans — catches last-mile gaps before code changes begin.

## Enforcement

Python enforcer `validate_plan_before_build.py` tracks plan-ready state in session memory; on first mutating tool call post-ready, blocks and injects the `validate the plan` prompt. Unblocks only after a validation result is recorded.

```rules
- title: "Ready plans require explicit validation"
  keywords: [edit, write, multiedit, implement, build, ship, commit]
  antiPatterns: [unvalidated-plan, skip-validation, plan-stale]
```
