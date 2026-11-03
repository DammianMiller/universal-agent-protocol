# team-solve — five roles, one problem, files only

The GVS5H method (Lee, 2026) as a static UAP workflow: a planner, two
ideators, a solver, a reviewer and a repair worker — five fresh-context model
calls per pass, each reading and writing FILES in the run directory, never
chat — with a deterministic sample harness as the only judge.

```
plan ──┬── ideate-a ──┬── solve ── test ── review ── repair ── verify
       └── ideate-b ──┘
```

- `test` runs the samples and NEVER fails the run (evidence for the reviewer).
- `verify` runs the same samples as the verdict — a nonzero exit fails it.
- The steps name no model; the pin ladder answers (step → workflow
  `defaultModel` → `uap workflow run --model` → the local fleet default).
- Command steps run with `cwd` = the run directory; the harness script is
  referenced via `$UAP_WORKFLOW_DIR` (this workflow's own directory) rather
  than copied in, so the run directory stays a pure ledger of inputs and
  step outputs.

## Provenance (the numbers are theirs, not ours)

The original claim: five Qwen3.8-27B roles on this shape scored a mean
9.8/10 on the first ten LiveCodeBench Hard problems, at parity with the
authors' own harness (9.6) and above Fable 5 single-call (8.0). Those runs
were on OpenRouter (~$0.39/run, 40 min median), with the authors' caveats
intact: ten problems, not one hundred; contamination not ruled out; the
claim is parity with their harness, not superiority.

What this port proves HERE is the capability, not the score: a static
workflow, local fleet, hidden-style verdict — a paired A/B against the
single-model `deliver` loop is the validation experiment (see
`docs/plans/model-performance-proof-options.md`, option O7), gated on an
explicit go.

## Run it

```bash
# from the project root
uap workflow run team-solve --input examples/workflows/team-solve/sample
```

That copies `sample/` (task.md + tests/) into a fresh run directory under
`.uap/workflow-runs/` and executes the seven steps on the local fleet default
(the strata arm through the proxy). Exit 0 means every sample passed.

Other useful invocations:

```bash
uap workflow show team-solve                  # the validated plan + pins
uap workflow run team-solve --input <my-problem-dir>   # your own task.md + tests/
uap workflow status                           # runs + their verdicts
uap workflow resume <runId>                   # after a block or an interrupt
```

Your problem directory needs `task.md` and paired `tests/N.in` / `tests/N.out`;
the program is `solution.py`, Python 3, stdin → stdout.

## Layout

| file | role |
| --- | --- |
| `workflow.yaml` | the DAG: steps, `requires:` edges, kinds, reads/writes |
| `steps/*.md` | one role prompt per agent step (the role IS the prompt) |
| `check-samples.sh` | the deterministic harness (test: evidence; verify: verdict) |
| `sample/` | a smoke task: longest strictly increasing subsequence |

## Notes for authors of new workflows

- Agent steps take `prompt:` (a role-prompt file) XOR `goal:` (inline).
- `reads:` files are inlined into the agent prompt at run time; `writes[0]`
  receives the reply verbatim. Overwrite semantics: the file ledger is the
  truth, chat is not.
- Parallel steps (`parallel: 2`) must not share write targets — the loader
  rejects a DAG where two steps write the same file with no `requires:` path
  between them.
- A `gate` step pauses for `uap workflow approve <runId> <step>` — resumable.
- Runs are resumable at the step boundary: `.uap/workflow-runs/<runId>/`
  keeps every step's files plus `run-state.json`.
- Hardening option: `test` executes model-written Python
  (`check-samples.sh` → `python3 solution.py`) with your privileges — the
  same trust class as `deliver` gate scripts. For untrusted inputs insert a
  `gate` step before the first command step (approve the program once, then
  resume), or wrap the whole run in `uap sandbox --net off`.
