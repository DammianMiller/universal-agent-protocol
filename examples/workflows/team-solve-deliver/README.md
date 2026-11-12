# team-solve-deliver — the team directs the convergence loop

The two UAP engines combined: **team-solve's role structure and ledger
discipline** (fresh contexts per role, files as the only channel,
cross-correction) wrapped around **deliver's convergence machinery** (real
tools, the project's real completion gates). Roles think; loops build and
verify.

```
plan ──┬── ideate-a ──┬── solve ── review ── repair ── verify
       └── ideate-b ──┘   (loop)   (judge)    (loop)    (loop, gates-only)
```

- `plan` / `review` run on the judge rail (cool, deterministic).
- `ideate-a` (minimal-change family) and `ideate-b` (structural family) run
  in parallel on the generator rail — the solver gets a real choice.
- `solve` and `repair` are `kind: loop` steps: each executes a caller-injected
  convergence loop whose exit condition is the project's gates. `solve` is
  the mission itself (the posture chain, with the team's approach steering
  the instruction); `repair` is a bounded pass over the reviewer's brief
  (a declared `turns:` caps it; a NO REPAIR NEEDED verdict collapses to the
  loop's baseline check — zero turns, tree untouched).
- `verify` is a loop step with `verifyOnly:` — the gates alone, no executor
  turns, the final verdict. Its prompt file exists to satisfy the loader's
  prompt-XOR-goal rule and to document the contract; the seam never sends
  it to a model.
- The workflow sets `maxRepairsPerStep: 0`: the solve loop already
  converges internally, and an engine-level retry would re-run the ENTIRE
  mission dispatch after it burned its turn budget. The repair step IS the
  retry.
- The reviewer (`review`) receives the plan file plus a one-line solve
  report — gate status, turns, whether the tree changed, a feedback tail —
  and its prompt is written to judge exactly on that. No file list, no
  diff: it never invents what it wasn't given.

## How it engages (automatic)

`uap deliver` resolves a team-solve posture per mission, exactly like its
other postures (orchestrate, epics):

- `--team-solve` / `--no-team-solve` — explicit, wins over everything.
- `UAP_DELIVER_TEAM_SOLVE=0` — kill switch.
- `.uap.json` `deliver.teamSolve: 'on' | 'off' | 'auto'` — persistent
  (set with `uap config`).
- Default `auto`: engage for high/critical-complexity missions whose scope
  is not a named single-file edit (the ladder's "hardest tier → full loop
  + escalation" row now means THIS shape) and stand down otherwise — role
  overhead is real tokens; the ladder escalates with measured difficulty,
  not anxiety.
- Stand-downs regardless of tier: self-gate and acceptance-primary missions
  (no objective gate ladder for the roles to converge against — the verify
  pass would be vacuous), lazy-solved runs, and AUTO resumes (the
  interrupted run continues on its recorded posture).

When engaged, deliver injects its own machinery as the loop seams: `solve`
runs the mission through the standard dispatch (epics → orchestrated →
phased → single, per the already-resolved posture) with the approach
steering the instruction; `repair` runs a bounded convergence loop seeded
with the reviewer's brief; `verify` re-runs the gate ladder gates-only.
The banner names the RESOLVED workflow source (a project
`.uap/workflows/team-solve-deliver/` copy shadows the bundled one — you
see which ran).

## Standalone runs fail closed

`uap workflow run team-solve-deliver` cannot execute loop steps — no
convergence-loop provider is injected outside deliver. `show` and
`--dry-run` work (the plan is inspectable data); a run exits with the
fail-closed message pointing here.

## Layout

| file | role |
| --- | --- |
| `workflow.yaml` | the DAG: three agent roles, three loop steps, `requires:` edges, `maxRepairsPerStep: 0` |
| `steps/plan.md`, `steps/ideate-a.md`, `steps/ideate-b.md`, `steps/review.md` | role prompts (fresh-context completions) |
| `steps/solve.md`, `steps/repair.md` | LOOP DIRECTIVES — they seed the convergence executor |
| `steps/verify.md` | the gates-only contract (documentation; the seam never sends it to a model) |
| run dir (`.uap/workflow-runs/<runId>/`) | the ledger: plan.md, proposals, repair.md |

The paired experiment that would measure whether this shape beats the plain
convergence loop is option O7 in
[docs/plans/model-performance-proof-options.md](../../../docs/plans/model-performance-proof-options.md)
— same model, same tasks, single-shot vs gate loop vs this workflow.
