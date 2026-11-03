# Workflows — static step DAGs over the blackboard orchestrator

A workflow is **data, not a plan**: one `workflow.yaml` plus role-prompt files
that describe a step graph — agent roles, deterministic commands, approval
gates. The runner executes it on the same machinery `uap deliver` uses
(task-orchestrator: dependency-aware dispatch, bounded repair,
resume-at-the-step-boundary), so the graph semantics are the validated
delivery semantics.

The shape this buys is the measured one from GVS5H/Memdoor: several small
roles — planner, ideators, solver, reviewer, repairer — each in a FRESH
context, communicating only through files, with a command step's exit code
(rather than any model's claim) as the verdict. Five Qwen3.8-27B roles on
this shape matched the authors' own harness on LiveCodeBench Hard (9.8/10
vs 9.6, Fable 5 single-call at 8.0 — their runs, their caveats; see
`examples/workflows/team-solve/README.md`).

## Quickstart

```bash
uap workflow list                                        # what exists, from where
uap workflow show team-solve                             # the validated plan + pins
uap workflow run team-solve \
  --input examples/workflows/team-solve/sample           # run the LIS smoke task
uap workflow show team-solve-deliver                     # the loop-step variant (deliver-driven)
uap workflow status                                      # every run + its verdict
uap workflow resume <runId>                              # continue at the boundary
```

Exit codes: `0` success · `1` a step failed · `2` blocked at a gate
(resumable) · `3` the workflow file is invalid. Cron-safe by construction.

Two bundled workflows: **team-solve** (contest-shaped: everything happens in
the run directory, a command step is the verdict — runs standalone) and
**team-solve-deliver** (repo missions: solve/repair are convergence loops
against the project's real gates, verify is gates-only — driven by
`uap deliver --team-solve`, which injects the loop machinery; standalone
runs fail closed). See
[examples/workflows/team-solve-deliver/README.md](../../examples/workflows/team-solve-deliver/README.md).

## Where workflows live

Search order — first hit wins, so a project can override a bundled workflow
without touching the install:

1. `<project>/.uap/workflows/<name>/` — project-owned (committed)
2. `~/.uap/workflows/<name>/` — operator-wide
3. `<package>/examples/workflows/<name>/` — bundled (team-solve ships here)

## The file format

```yaml
name: my-workflow
description: One line, shown in `show`.
defaultModel: qwen38-27b     # optional pin ladder default (see below)
parallel: 2                  # max concurrent independent steps (default 1)
maxRepairsPerStep: 1         # bounded re-execution of a failed step
steps:
  - id: plan                 # lowercase slug (repair chains use <id>.r0-…)
    kind: agent              # agent | command | gate | loop
    title: Planner           # optional label
    prompt: steps/plan.md    # role-prompt file, relative to this directory
    reads: [task.md]         # run-dir files inlined into the prompt
    writes: [plan.md]        # writes[0] receives the reply (the ledger)
    requires: []             # DAG edges: ids that must SUCCEED first
  - id: verify
    kind: command
    command: bash check.sh --strict   # cwd = the run directory
    writes: [verify.log]
    requires: [plan]
```

### Step kinds

- **agent** — one fresh completion: the role prompt (or inline `goal:`),
  plus direct-dependency summaries and the inlined `reads:` files, sent to
  the pinned model. The reply is written verbatim to `writes[0]`. There is
  no chat: the run directory is the only memory. Agent steps take exactly
  one of `prompt:` / `goal:`.
- **command** — a shell line in the run directory. Exit 0 = success. With
  `neverFails: true` the output is captured as evidence and the step never
  fails the run (team-solve's `test` step); without it, a nonzero exit IS
  the verdict (team-solve's `verify`). Output lands in `writes[0]` (or
  `<id>.log`). `timeoutMs` bounds it (default 120000). The workflow's own
  directory is exported as `$UAP_WORKFLOW_DIR` — reference harness scripts
  there (`bash "$UAP_WORKFLOW_DIR/check.sh"`) instead of copying them into
  the run.
- **gate** — pauses the run for an operator decision. Default `waitMs: 0`
  returns immediately as BLOCKED (exit 2); `uap workflow approve <runId>
  <step>` records the approval, then `resume` re-runs the gate and passes.
  Set `waitMs` if a run should hold a terminal open for approval instead.
- **loop** — a convergence loop owned by the CALLER, not the engine: the
  engine assembles the instruction (role prompt or `goal:`, plus
  direct-dependency summaries and inlined `reads:`) and hands it to an
  injected `runLoop` seam, which drives a tools-and-gates iteration to
  completion and reports `{ success, summary, turns }`. The step outcome is
  the seam's result — there is no `writes[0]` (a loop works the project
  tree; its DeliveryResult is the record). Loop-only fields: `turns:` (a
  turn bound passed through to the seam) and `verifyOnly:` (the loop runs
  the gates with NO executor turns — a verdict, not a builder; this is what
  `team-solve-deliver`'s final step is). A standalone `uap workflow run`
  cannot execute loop steps — no provider is injected — and fails closed at
  run start with that message; `uap deliver --team-solve` is the caller
  that can.

### Trust boundary

Authoring a workflow is authoring shell + prompts for your own account:
`command:` lines run through a shell as the invoking user (the same trust
level as a `package.json` script or a CI step — this is the design, not a
bug), and `--input` task directories are copied into the run directory
where later steps may read them. Authored commands may EXECUTE files a
model produced — team-solve's harness runs `python3 solution.py`, model
code under your privileges, exactly like `uap deliver` gate scripts. Model
replies are data on the way IN (prompts and files); whether they execute
is a decision the workflow author made when writing the command step. For
untrusted tasks: insert a `gate` before the first command step, or wrap
the run — `uap sandbox [--net off] -- uap workflow run <name>`.

Two consequences of the trust model worth knowing:

- **Workflows are discovered from the current directory** (`.uap/workflows/`
  first). Running `uap workflow run <name>` inside a cloned repository
  executes that repo's command steps — the same act as running its npm
  scripts. Read a repo's workflows before running them.
- **`--endpoint <url>` receives your prompts.** Prompt assembly inlines
  `reads:` file contents; a third-party endpoint sees them. Local pins
  keep that traffic on the loopback.

### Model pins

Steps name no model — the pin ladder answers:

```
step.model → workflow.defaultModel → uap workflow run --model → fleet default
```

The fleet default is `qwen38-27b` (the strata arm through the proxy,
`http://127.0.0.1:4000/v1`). `--endpoint <url>` overrides the endpoint for
every arm, so the same workflow runs on any OpenAI-compatible server.

### Authoring rules (enforced at load, exit 3 on violation)

- Step ids are lowercase slugs; `requires:` must reference known ids; the
  graph must be a DAG (cycles are authoring bugs, surfaced not survived).
- Fields are kind-checked: `command` on an agent step, `reads` on a command
  step, etc. are rejected.
- Two steps that write the same file with no `requires:` path between them
  are rejected — parallel siblings must not be able to clobber each other
  (the graph-safety FALSE INDEPENDENCE invariant, checked at authoring
  time instead of merge time).
- `reads`/`writes` are run-directory relative; absolute paths and `..`
  escapes are rejected.
- Steps may not write `run-state.json` or `.gates/` — the runner's own files.

## Runs, state, resume

Every run gets `.uap/workflow-runs/<runId>/`: the step output files (the
ledger), `run-state.json` (status + accepted steps + summaries), and gate
approvals. `--input <dir>` copies a task directory (e.g. `task.md` +
`tests/`) into the fresh run dir first.

State persists after EVERY accepted step. An interrupted run resumes with
`uap workflow resume <runId>` — accepted steps are seeded into the
blackboard and never re-executed; the model is only paid for what remains.

## What this is not

- Not a replacement for `uap deliver`: deliver's convergence loop is for
  repo-editing tasks judged by real gates; a workflow's agent steps are
  single completions producing files. Use a workflow when the SHAPE is the
  asset — when the same role graph should run on many inputs.
- Not the Memdoor harness: the engine is UAP's orchestrator; the ported
  team-solve keeps the method's structure and discipline, not its byte
  parity. Its published numbers belong to the authors.
- The validation claim (does role-DAG structure beat the gate loop on the
  same local model?) is option O7 in
  [model-performance-proof-options.md](../plans/model-performance-proof-options.md)
  and starts only on an explicit go, like every option there.
