# ADR 0014: Loop step kind + team-solve-deliver — the team directs the convergence loop

- Status: Accepted
- Date: 2026-11-03
- Spec: `uap deliver --team-solve` (src/cli/deliver.ts), the `loop` step kind
  (src/workflow/), examples/workflows/team-solve-deliver/,
  docs/guides/DELIVER.md, docs/guides/WORKFLOWS.md.
- Extends: ADR 0013 (the declarative workflow layer). Amends its decision #2
  (three step kinds → four) and #7 (O7 now measures the shipped posture).

## Context

UAP has two engines that had never been combined:

1. **team-solve** (ADR 0013): a static role DAG — planner, parallel
   ideators, solver, reviewer, repairer — fresh contexts, files as the only
   channel, deterministic verdict. Measured shape (GVS5H/Memdoor prior:
   9.8/10 LiveCodeBench Hard with a 27B local model). But its bundled form
   is contest-shaped: everything happens in the run directory and a command
   step is the verdict. A REPO mission needs tools and the project's real
   gates, which the workflow engine did not have.
2. **deliver**: the convergence loop — a tool-using executor iterating
   against the project's real completion gates (tiered ladder), with
   posture escalation (single → phased → orchestrated → epics). But its
   planning is a single model's inline reasoning; there is no role
   structure, no parallel ideation, no fresh-context review.

The request: combine them — the convergence loop DIRECTED BY team-solve for
superior results — and make the behavior automatic in UAP, not a manual
incantation.

## Decision

1. **A fourth step kind: `loop`.** The engine stays the graph authority and
   gains a convergence-loop seam: it assembles the instruction (role prompt
   or `goal:`, direct-dependency summaries, inlined `reads:`) and hands it
   to a caller-injected `LoopStepExecutor` which owns the iteration and
   reports `{ success, summary, turns }`. A loop step declares no
   `writes:` — it works the PROJECT tree; its DeliveryResult is the record.
   Loop-only fields: `turns:` (bound, passed through) and `verifyOnly:`
   (gates with no executor turns — a verdict, not a builder). A standalone
   `uap workflow run` fails closed at run start: no provider is injected.
   The loader enforces kind/field separation exactly as for the other kinds.
2. **Role steps ride the caller's executor rails.** `RunWorkflowOptions`
   gains `completeStep` (per-step role-call seam) which takes precedence
   over the raw `client`, and `client` becomes optional when it covers
   every agent step. This is what lets deliver drive the roles through its
   judge/generator rails (plan + review on the cool deterministic judge;
   ideation on the generator) instead of re-implementing model choice.
3. **The bundled `team-solve-deliver` workflow** composes the two engines:
   plan → ideate-a/ideate-b (parallel, different engineering families) →
   solve (loop) → review (fresh-context judge) → repair (loop, review-
   seeded) → verify (loop, verifyOnly). The run directory is the role
   ledger; the project tree is the work surface.
4. **`uap deliver` injects itself as the seams** (src/delivery/
   team-solve-deliver.ts — deps-injected and unit-tested, the epic/phased/
   orchestrated extraction precedent). solve = the mission dispatch itself —
   the SAME posture decision as any other mission (epics → orchestrated →
   phased → single, verbatim extraction) with the team's approach enriching
   the instruction; repair = a bounded ConvergenceLoop with the reviewer's
   brief as instruction, fresh checkpoint state, and a declared `turns:`
   bound honored as its cap (a NO REPAIR NEEDED verdict collapses to the
   loop's own baseline check — zero turns, tree untouched); verify = the
   tiered ladder with no executor turns, checked BEFORE any step-id
   dispatch so a gates-only verdict can never run executor turns whatever
   the id says. The final DeliveryResult aggregates honestly: verify pass
   AND workflow status decide success; histories concatenate; the role
   ledger path lands in finalFeedback. The role ledger's source directory
   is surfaced at engagement (a project `.uap/workflows/` copy shadows the
   bundled one — the operator must see which ran).
5. **Engagement is a posture, tier-gated AUTO by default.**
   `resolveTeamSolveWanted` (pure, tested): explicit flag
   (`--team-solve`/`--no-team-solve`) > env kill (`UAP_DELIVER_TEAM_SOLVE=0`)
   > persistent config (`.uap.json` `deliver.teamSolve` on/off) > AUTO,
   which engages for high/critical complexity AND a non-single-file scope
   (`looksSingleFileScoped`: exactly one named file + short instruction
   stands down — the classifier's keyword ladder promotes "optimize"/
   "refactor" regardless of scope, which is right for cheap model routing
   and wrong for a 4-6× pipeline multiplier; an operator who names one file
   has already disambiguated the scope) — the reliability ladder's "hardest
   tier → full loop + escalation" row now resolves to this shape.
   Stand-downs: self-gate and acceptance-primary (no objective ladder for
   the roles to converge against — the verify pass would be vacuous),
   lazy-solved (nothing left to direct), and resumes under AUTO (the
   interrupted run continues on its recorded posture; an explicit
   `--team-solve` resume re-runs the team wrapper over the resumed mission).
   If the workflow is missing or its step shape has drifted from what the
   seam mapping is keyed to, the run falls back to the standard dispatch
   with a warning — auto engagement must never make deliver worse.
6. **Composition, not replacement.** team-solve composes with epics and
   orchestration rather than competing with them: the solve step dispatches
   through the same chain, so a massive mission still sequences as epics —
   each epic's loop now directed by the team's approach. One nuance: for
   PHASED/ORCHESTRATED missions the phase plan is produced from the
   un-enriched instruction BEFORE the solve step runs, so the team directs
   per-phase execution but not the decomposition itself; epics are the
   exception (their planning happens inside the solve dispatch, after the
   enrichment).
7. **The solve step is not engine-retried.** The bundled workflow sets
   `maxRepairsPerStep: 0`: the solve loop already converges internally
   (until-delivered + escalation inside the mission dispatch), and a
   workflow-level retry would re-run the ENTIRE dispatch after it burned
   its turn budget — doubling the hardest-tier spend and bypassing this
   workflow's own review→repair discipline. The repair loop is the retry.

## Alternatives considered

- **Make deliver read workflow.yaml directly (no loop kind)** — rejected:
  the engine would need to know about convergence loops, gates, and
  DeliveryResult; the seam keeps the workflow layer generic and testable
  with stub loops.
- **A second engine (a "team deliver" runner beside ConvergenceLoop)** —
  rejected: duplicates gate logic, posture routing, resume bookkeeping;
  the wrapper composes the existing, already-tested machinery.
- **Auto-engage on every mission** — rejected: role overhead is real tokens
  (4+ completions before the first tool call); the ladder escalates with
  MEASURED difficulty, not anxiety. Simple/moderate missions keep the
  cheap posture.
- **Team-solve replaces the epics/orchestration postures** — rejected:
  they answer different questions (context scaling vs approach quality);
  the composition answers both.

## Consequences

- `runState.runnerKind` gains `'teamsolve'` (transient: the solve step's
  dispatch records the inner posture, which is what a resume re-enters; a
  crash mid-roles records 'teamsolve' and the resume warns + falls to the
  inner path).
- Review visibility is v1-honest and PROMPT-MATCHED: the reviewer receives
  the plan file plus a one-line solve report (gate status, turns,
  changed-tree flag, feedback tail) and `steps/review.md` is written to
  judge exactly on that — no file list, no diff. A richer review surface
  (diff inlining) is a tracked follow-up.
- Loader tightening (fail-closed by design): stray `turns:`/`verifyOnly:`
  on a non-loop step previously zod-stripped silently; it now exits 3.
- O7's arm C is now the shipped auto posture (`--no-team-solve` vs
  `--team-solve` on the same tasks) — the experiment validates the
  product, not a bespoke rig.
- Known follow-ups (tracked, deliberate): diff-surface for the reviewer;
  role-pin awareness inside completeStep (rails own model choice today);
  ledger-aware resume for an explicitly `--team-solve` resumed run (roles
  re-run; the ledger files persist for inspection).
