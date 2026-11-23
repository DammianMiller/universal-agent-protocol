# Convergence table, the per-model economics of reaching the bar

E.1 of the [quality-tier uplift plan](../plans/quality-tier-uplift-2026-11-16.md)
(wave 2.1) and the [frontier-parity plan](../plans/frontier-parity-uplift-2026-11-23.md):
how many iterations, escalations, cuts, and best-of-N attempts each model spends
getting there. This table directs tier routing (option C) and the fix queue
(option D) with numbers instead of anecdotes.

**House rule:** every number carries its measurement class. Paired-harness rows
carry the run's discrimination status verbatim — rows not marked **usable**
support cost claims only, never a quality claim. The delivery-gate section is
descriptive by construction (proof-plan O1, no paired arm) and is never quoted
as a finding. Escalation counts are ledger facts, not experiments.

## Reproducing

```bash
npm run bench:convergence            # the table below (stdout)
npm run bench:convergence -- --write # refresh the generated block in this file
npm run bench:convergence -- --json  # machine-readable rows + coverage
```

Sources: `benchmark-results/` (paired runs, both flat and per-arm layouts), the
O1 delivery corpus (`uap memory outcomes`), the quality-ladder convergence log
(`uap quality convergence` — per tier, the class dimension), and the
uplift-loop escalation ledger (`.uap/quality/escalations.jsonl`). Works from worktrees: the reader
falls back to the main checkout for the git-ignored `benchmark-results/`.

<!-- CONVERGENCE:BEGIN -->
Generated 2026-11-23 by `scripts/convergence-table.ts` (E.1, wave 2.1).

## Paired-harness convergence (benchmark-results/)

| Run | Arm | Model | Condition | Tasks | pass@1 | pass@N | best-of-N win | Iterations-to-done (correct attempts) | Cut rate | Discrimination |
|---|---|---|---|--:|--:|--:|--:|--:|--:|---|
| o7-pilot | armB-gateloop | local-auto | baseline | 9 | 70.4% | 77.8% | 7.4% | 1.0 (n=19) | 0.0% | underpowered (⚠) |
| o7-pilot | armB-gateloop | local-auto | uap-full | 9 | 77.8% | 77.8% | 0.0% | 1.0 (n=21) | 0.0% | underpowered (⚠) |
| o7-pilot | armC-teamsolve | local-auto | baseline | 9 | 59.3% | 88.9% | 29.6% | 1.0 (n=16) | 0.0% | underpowered (⚠) |
| o7-pilot | armC-teamsolve | local-auto | uap-full | 9 | 59.3% | 77.8% | 18.5% | 1.0 (n=16) | 0.0% | underpowered (⚠) |

pass@1 / pass@N use the unbiased estimator (the harness `passAtK`); N is each task's own attempt count. Iterations-to-done is mean turns on **correct** attempts only — it is undefined (—) when nothing passed. Cut rate is the share of attempts that errored. Discrimination is the run's own verdict; rows not marked **usable** support cost claims, never a quality claim.

## Delivery-gate convergence (O1 corpus, descriptive)

| Model | Runs | Delivered | Stopped | Not delivered | Cut rate | Mean turns | Mean best gates |
|---|--:|--:|--:|--:|--:|--:|--:|
| qwen35-a3b | 4 | 0 | 2 | 2 | 100.0% | 9.0 | 66.5% |
| opus-4.8 | 1 | 0 | 0 | 1 | 100.0% | 5.0 | 0.0% |

Descriptive by construction (no paired arm): observational counts of recorded lessons. It directs where paired runs should spend; it proves nothing about cause.

## Quality-ladder convergence (per tier — the class dimension)

_No ladder runs recorded yet — the section fills when `uap quality ladder --rounds-dir` first runs against a tier (the convergence log then holds the promotion budget)._

## Escalation ledger (.uap/quality/escalations.jsonl)

_No escalations recorded yet — the ledger appears when an uplift loop first fires `onEscalate` (uplift 1.4)._

## Quality-class coverage

Class coverage lives in the quality-ladder section (tier keys are class/name pairs — visual-scene/frontier-prior, doc-style/…). The paired-harness and delivery corpora are not yet class-tagged; their rows gain classes when anchor harvesting (E.2) and vision promotion (E.4) tag runs.
<!-- CONVERGENCE:END -->
