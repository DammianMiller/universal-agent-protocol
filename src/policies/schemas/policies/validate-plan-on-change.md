# validate-plan-on-change

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: planning, validation, accuracy, self-prompt

## Rule

A `Write` or `Edit` to a **plan artifact** is BLOCKED unless the plan has been
validated recently. A plan artifact is any file under a `plans/` directory or a
file with a plan-like name (`PLAN.md`, `*-plan.md`, `plan-*.md`,
`implementation-plan.md`, `*.plan.md`). `planning.md`, `explanation.md`, and
plural-but-unrelated names are NOT plan artifacts.

On a blocked write the agent MUST:

1. Run the prompt `validate the plan` — review assumptions, gaps, risks, and
   whether the plan still matches the request.
2. Record the validation: `uap plan validate`.
3. Retry the write.

One validation covers a burst of edits for `UAP_PLAN_VALIDATE_WINDOW` seconds
(default 300), so iterative edits in a single planning session don't re-prompt;
a plan touched after that gap re-validates.

## Why

User directive: "force yourself to prompt `validate the plan` after any plan is
created or modified — you should ALWAYS validate the plan." Plans drift from the
request as they grow; an unvalidated plan ships last-mile gaps into code. Making
validation a hard gate at the moment the plan changes catches those gaps while
they are cheapest to fix. (Supersedes the older `validate-plan-before-build`,
which never fired because nothing set its `plan_ready` marker.)

## Enforcement

Python enforcer `validate_plan_on_change.py`. State in `.uap/plan_state.json`
(`{"validated_at": <epoch>}`, written by `uap plan validate`). Escape hatch,
justify in the plan/PR: `UAP_PLAN_VALIDATE_OFF=1`.
