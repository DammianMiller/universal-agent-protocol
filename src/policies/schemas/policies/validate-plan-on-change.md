# validate-plan-on-change

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: planning, validation, accuracy, self-prompt

## Rule

Creating or modifying a **plan artifact** is ALLOWED, and records that plan as
awaiting validation. A **build, execute or deploy** command is then BLOCKED
until the plan has been validated.

A plan artifact is any file under a `plans/` directory, or a file with a
plan-like name (`PLAN.md`, `*-plan.md`, `plan-*.md`, `implementation-plan.md`,
`*.plan.md`). `planning.md`, `explanation.md`, and plural-but-unrelated names
are NOT plan artifacts.

On a blocked build the agent MUST:

1. Run the prompt `validate the plan` — review assumptions, gaps, risks, and
   whether the plan still matches the request.
2. Record the validation: `uap plan validate <file>`.
3. Retry the command.

Validation is recorded against the **content hash** of the plan that was
reviewed. Editing that plan afterwards re-arms the gate. Reads, tests, linters
and type-checks are never gated — you cannot review a plan if you cannot inspect
the tree or run its tests.

## Why

User directive: "once a plan is created the LLM is prompted to `validate the
plan` before execution/build."

The gate used to fire on the plan WRITE, keyed to a 300-second window. That
asked the agent to validate a plan before it existed: `uap plan validate` found
no artifact (or an older one), recorded the review as "skipped", stamped anyway,
and for the next five minutes any plan content could be written unread — while
nothing gated the build at all. The plan that actually got implemented was never
reviewed.

Moving the gate to the build fixes both halves. There is now something real to
review when the prompt fires, and the thing being gated is the work itself.
Keying on content rather than a clock closes the remaining hole: "these exact
bytes were reviewed" cannot be satisfied by validating an empty file first.

(Supersedes the older `validate-plan-before-build`, which never fired because
nothing set its `plan_ready` marker.)

## Enforcement

Python enforcer `validate_plan_on_change.py`, exiting 2 on a refusal with
`inject_prompt: "validate the plan"`.

State in `.uap/plan_state.json` (honours `UAP_STATE_DIR`), shared with
`uap plan validate`:

```json
{
  "pending":   { "<repo-relative path>": "<epoch seen>" },
  "validated": { "<repo-relative path>": "<sha256 of the reviewed bytes>" },
  "cleared":   [ { "key": "<path>", "reason": "<why unreachable>", "at": "<epoch>" } ]
}
```

`cleared` is the audit trail of pending entries dropped as UNREACHABLE. The
blocking set only shrinks through validation or through a recorded drop.

Gated commands: `uap deliver`, `npm run build`, `npm start`, `yarn`/`pnpm build`,
`make`, `cargo build|run`, `go build|run`, `mvn package|install`,
`gradle build`, `docker build`, `docker compose up`, `terraform apply`,
`kubectl apply`, `helm install|upgrade` — matched anywhere in the command, so
`cd sub && npm run build` is gated, and matched against the command with quoted
data and heredoc bodies stripped, so `echo 'npm run build'` is not.

Everything not listed is allowed; there is no second allowlist to keep in sync.

Escape hatch, justify in the plan/PR: `UAP_PLAN_VALIDATE_OFF=1`.

`uap plan status` reports exactly what the gate is waiting on (pending plans and
plans that have drifted since validation), listing separately any entry that is
UNREACHABLE — one validation can never clear, because the file is outside the
project, deleted, or unreadable.

`uap plan clear` drops those unreachable entries and records them under
`cleared`. It REFUSES a plan that is present and reviewable, pointing back at
`uap plan validate`: it is a recovery hatch for a wedged gate, not a way to skip
review. Without it the only exit from a wedge was editing the state file by
hand.
