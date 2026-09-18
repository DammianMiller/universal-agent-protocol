# System-1 Classifier

Uplift §6: the local, airgap-pure backend every Wave 1 consumer (semantic
supervisor 1.1, compaction 1.2, AutoMode 1.3) talks to through **one
interface**, so the model can evolve without touching policy code.

## Interface

```ts
assess(state, questions) -> { [name]: { value, probability, confidence, backend } }
```

Question shapes mirror the noul/score/choice families so Jev-compatible
fixtures work unchanged:

| Question | Kind | Asks |
| --- | --- | --- |
| `escalation-risk` | noul | Does this state need escalation to a stronger technique or human review? |
| `task-risk` | score (1–5) | How risky is the operation (1 trivial, 5 irreversible/destructive)? |
| `action-class` | choice | `proceed` / `verify-first` / `escalate` / `stop` |

v1 ships **one dimension end-to-end** (escalation risk) per the plan's scope
discipline; the other two questions ride the same plumbing.

## CLI

```bash
uap classify "<state text>"                  # all built-in questions
uap classify "<state>" -q escalation-risk
uap classify "<state>" --shadow              # also append to the shadow log
uap classify --bench 500                     # latency self-check
uap classify "<state>" --json
```

Advisory: exit 0 on success, 1 on usage errors or a failed latency bench.

## Backend

`baseline-tfidf-v1`: deterministic token scoring against incident/destructive
vocabulary seeded from UAP's own telemetry language (the 2026-09-18 OOM
timeline, gate outcomes), squashed through a logistic curve. CPU-only, no
dependencies, no network, measured **p95 ≈ 0.02ms** against the 50ms budget.
The trained-head slot (embedding + logistic/isotonic on nomic embeddings)
inserts into `defaultBackend()` when a head ships — consumers don't change.

## Thresholds are policy, not model output

`config/classify-thresholds.json` (project) or
`~/.config/uap/classify-thresholds.json` (operator):

```json
{ "version": 1, "questions": { "escalation-risk": { "tau": 0.6, "confidenceFloor": 0.3 } } }
```

- `tau` decides noul questions (`probability >= tau`) — noul only;
  score/choice return their value directly, gated by `confidenceFloor`.
- Below `confidenceFloor` the assessment carries `defer: true` — **the
  heuristic decides**. That is the shadow-mode contract.

Probability semantics per kind (consumers must rely on 0..1 ordering only):
noul = probability the answer is true; score = 1 − normalized rounding
distance; choice = winning score's share. The calibrated head replaces these
approximations with true probabilities when it ships.

## Shadow mode and promotion

`--shadow` appends to `.uap/classify-shadow.jsonl` (git-ignored, local-only,
mode 0600). The record is `{v, ts, stateHash, wordCount, questions, result,
heuristicDecision?}` — a SHA-256 of the state text, never the text itself,
so the log carries no raw-text surface (the hash is equality-revealing for
low-entropy boilerplate states; acceptable for a local join key).
`heuristicDecision` is the other half of the divergence loop: Wave 1
consumers record what their heuristic actually decided, so the promotion
gate can measure agreement from the log alone. Calibration joins outcome
labels by hash.

Promotion path (per the plan's risk section): classifier assesses, heuristics
decide, divergence accumulates in the shadow log; a trained head is promoted
only after measured agreement, and the calibration report lands in-repo with
the thresholds that came from it.

## Decisions

- **Baseline before head.** An untrained embedding+head is unproven; the
  deterministic baseline is the floor a head must beat on held-out shadow
  data before it serves policy.
- **Empty states get zero confidence**, not a confident guess — a blind
  classifier must say so (same doctrine as `uap doctor`'s UNKNOWN).
- **One GPU/CPU probe budget.** Assessments are synchronous and batched per
  call; Wave 1 consumers batch questions per state.
- **The baseline is question-scoped, not question-blind.** It answers only
  the built-in questions and refuses others loudly — a custom noul question
  must not silently inherit the escalation vocabulary. The trained head is
  the generalizer.
- **Kinship:** `src/models/complexity.ts` runs the same
  heuristic-now-model-behind-the-same-interface-later play for task
  complexity. The two should converge deliberately when the trained head
  lands, not drift apart.

Scope note: this is the **foundation slice** of uplift §6. The acceptance
items that need shadow data and consumers — calibration report committed,
supervisor/compaction/AutoMode running against the backend — land with the
Wave 1 PRs that wire those consumers.
