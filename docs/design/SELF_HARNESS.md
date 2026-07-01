# Self-Harness for UAP — Design Doc

> Status: **Proposal / for review**  ·  Scope: **Option C (full vision)**  ·  Author: design pass 2026-06-23
>
> Grounds: *Self-Harness: Harnesses That Improve Themselves* (Zhang et al., arXiv:2606.09498) — an
> agent that rewrites its own operating harness from failure traces via a 3-stage loop
> (Weakness Mining → Harness Proposal → Proposal Validation), no human engineer. Reports
> Terminal-Bench-2.0 lifts incl. **Qwen3.5-35B-A3B 23.8%→38.1%** (our model's sibling).

> **🏭 Where this fits:** Feedback station (the floor tunes its own machines) —
> without it, the same failure mode recurs every run and a human has to hand-tune
> the harness for each new model, which doesn't scale. **What it delivers:** an
> autonomous loop that mines real failure traces, proposes bounded harness fixes,
> validates them against real gates, and keeps only the winners — so the whole
> [delivery pipeline](../guides/DELIVERY_PIPELINE.md) gets better at building the
> next change instead of repeating the last mistake.

## 1. Why this, why now

The paper's thesis is exactly the lesson of our manual harness-tuning campaign on Qwen3.6-35B-A3B:
effective harnesses are **model-specific** and hand-engineering them doesn't scale. We *manually* ran
the Self-Harness loop this cycle — mined a failure (tool-call path-garbling), proposed mods (n-predict
cap, loop breakers, the recon-poison fix, pattern-RAG), and validated via the paired benchmark. The
result was a null UAP-lift but several real harness fixes. **Self-Harness automates that loop.**

Crucially, UAP already owns **two of the paper's three stages** and a richer modification surface than
the paper (which only edits prompts). This doc specifies closing the loop and going beyond — cross-model
transfer and online learning.

## 2. What UAP already has (the 70%)

| Self-Harness stage | Existing UAP asset | File / command |
|---|---|---|
| **Weakness Mining** | **HALO** trace analysis for "systemic failure modes" | `src/observability/halo-exporter.ts`, `src/delivery/halo-trace.ts`, `uap harness analyze` (spans via `UAP_HALO_TRACE=1` → `.uap/halo/traces.jsonl`) |
| **Proposal Validation** | **Paired A/B + component ablation** with real-test ground truth and paired stats (bootstrap CI / McNemar / permutation / pass@k) | `src/benchmarks/paired/` (`runner.ts`, `ablation.ts`, `stats.ts`, `report.ts`), `uap bench paired [--ablation]` |
| Modification surface (scaffold) | `UAP_COMPONENTS` = gates/worktree/memory/experts/skills/patterns | `src/benchmarks/paired/scaffold.ts`, `types.ts` |
| Modification surface (runtime) | ~80 `PROXY_*` + ~25 `LLAMA_*` env knobs | `tools/agents/scripts/anthropic_proxy.py`, `scripts/run-llama-server-continuity.sh` |
| Learned-fix store | pattern-RAG over qdrant `agent_patterns` | `agents/scripts/{index_patterns_to_qdrant,query_patterns}.py` |
| Safety precedent | guardrail death-spiral is real (recon-convergence poison, fixed `2e82e88`) | — |

**The gap:** the middle stage (**Harness Proposal**) and the **autonomous orchestrator** that chains
mine→propose→validate→accept and persists results. Humans do both today.

## 3. Architecture

```
                ┌──────────────────────────── uap self-harness run ─────────────────────────────┐
                │                                                                                │
   traces ─────▶│  (1) MINE        (2) PROPOSE              (3) VALIDATE            (4) DECIDE    │
 (.uap/halo, or │  HALO over    →  LLM proposer emits   →  paired bench / ablation → accept iff  │
  prod export)  │  traces +        N candidate Mods         on each candidate Mod,    Δ>0 & no   │
                │  bench fails     from the typed DSL        held-out regression set   regression │
                │      │                  │                        │                      │       │
                │      ▼                  ▼                        ▼                      ▼       │
                │  WeaknessReport    Mod[] (bounded)        PairedResult[]          commit + log  │
                └──────────────────────────────┬───────────────────────────────────────┬─────────┘
                                               │ rejected → memory (negative)           │
                                               ▼                                        ▼
                                   cross-model pattern-RAG store          versioned harness profile
                                   key=(model_family, failure_sig)        (env + scaffold snapshot)
```

New code lives under `src/self-harness/`: `orchestrator.ts`, `mine.ts`, `propose.ts`, `mods.ts` (the
DSL), `apply.ts`, `transfer.ts`, plus `uap self-harness` CLI. It **reuses** `benchmarks/paired/` for
validation and the HALO exporter for mining — no reimplementation.

## 4. The Modification DSL — bounded, typed, reversible

The paper warns against "generic instruction padding" and unbounded edits. We constrain proposals to a
**typed `Mod` union**, each member *mechanically* applicable and *automatically* reversible. The proposer
may only emit these — never free-form code.

```ts
type Mod =
  | { kind: 'env';      target: 'proxy'|'llama'; key: KnownKnob; from: string; to: string }
  | { kind: 'scaffold'; component: UapComponent;  op: 'replace'|'append'; text: string }
  | { kind: 'middleware'; id: MiddlewareId; params: Record<string, JsonScalar> }  // Phase 2
```

- **`env`** — only an **allow-listed** subset of `PROXY_*` / `LLAMA_*` knobs with declared ranges
  (e.g. `LLAMA_N_PREDICT ∈ [512,16384]`, `PROXY_HARD_FINALIZE_TURNS ∈ [10,80]`,
  `PROXY_RECON_CONVERGENCE_THRESHOLD ∈ [20,200]`, narrowing keep/core-set, repeat-penalty, DRY). This
  is the layer that *actually moved our model* (n-predict 8192→4096). **No model/ctx/KV/spec knob is
  allow-listed** (those need slot-clears and risk OOM — out of the autonomous loop's reach).
- **`scaffold`** — edits to a single `UAP_COMPONENTS` instruction block (the paper's surface).
- **`middleware`** (Phase 2) — toggles/params for purpose-built proxy interceptors, the highest-value
  class. First member: **`toolcall-path-normalizer`** — snaps a garbled tool-call `path` to the nearest
  real file in the workdir (the exact failure that beat every prompt-level fix this cycle). A Mod here is
  a *mechanical* fix the model can't fumble, which is where Self-Harness can beat the paper.

Every Mod carries a `revert()` (env knob → prior value; scaffold → prior text; middleware → off). The
applied set is a **versioned harness profile** (env snapshot + scaffold snapshot + middleware config),
committed to git per accepted iteration so any change is bisectable and rollback is one revert.

## 5. Stage 1 — Weakness Mining

- Input: HALO spans (`.uap/halo/traces.jsonl`) from the just-run validation suite **plus** the paired
  bench's per-run records (which already capture `correct`, `error`, latency, turns).
- Run `uap harness analyze` (HALO engine) with a structured prompt to emit a **`WeaknessReport`**:
  `[{ signature, evidence_spans[], frequency, hypothesis, affected_tasks[] }]`. `signature` is a stable
  hash of the failure shape (e.g. `toolcall.path.garbled`, `gen.runaway.npredict`, `loop.nonterminate`).
- Extend HALO span capture so the proxy emits spans for the failure modes we now know matter: tool-call
  arg corruption, n-predict-cap hits, breaker fires, recon/finalize fires, verify-fail vs timeout. (Most
  are already logged as text — promote them to structured spans.)
- Output ranked by `frequency × est_impact`. Mining is **read-only**.

## 6. Stage 2 — Harness Proposal

- An LLM proposer (a *capable* model — Opus/Sonnet via the same proxy, or a configured remote) receives:
  the top weakness signatures + evidence, the **current harness profile**, the **Mod DSL schema**, and
  **prior accepted/rejected Mods for this `(model_family, signature)`** from the transfer store.
- It emits 1–`K` candidate `Mod`s (validated against the DSL schema; out-of-DSL → rejected at parse).
  Bias toward **minimal** (single-knob / single-block) per the paper.
- Determinism/repro: proposer seeded; proposals logged with the prompt and the weakness report that
  produced them.

## 7. Stage 3 — Proposal Validation (reuse `benchmarks/paired/`)

- For each candidate Mod, apply it in isolation (others reverted) and run `runPaired` over a **fixed
  validation suite** + a **held-out regression suite** (disjoint tasks, to catch overfitting).
- **Accept iff**: paired Δ(resolve-rate) > 0 with CI excluding 0 (or McNemar net-positive) on the
  validation suite **AND** no significant regression on the held-out suite **AND** no cost blow-up beyond
  a budget (tokens/turns). This is exactly the paper's "conservative validation preventing regressions,"
  implemented with statistics we already ship.
- Multiple accepted Mods are then **stacked and re-validated together** (interactions are real — cf. how
  narrowing + recon + finalize interacted this cycle) before the profile is committed.
- The **ablation matrix** (`ablation.ts`) runs periodically to prune Mods that have stopped paying off.

## 8. Beyond the paper #1 — Cross-model transfer

The paper's stated limitation is that fixes stay model-specific. UAP's pattern-RAG makes transfer cheap:

- Each accepted Mod is stored as a pattern-RAG entry in qdrant, **keyed by `(model_family, failure
  signature)`** with payload = the Mod + its measured Δ + validation provenance.
- On a new model (e.g. Qwen3.6→3.7, or a GLM family), the proposer **seeds** from transfer hits:
  signatures with the same shape retrieve their prior winning Mods as *priors*, which still go through
  full validation on the new model (transfer is a hypothesis, not a shortcut). Negative results are
  stored too, so we don't re-propose known-bad Mods.
- This turns N independent per-model tuning runs into a **shared, growing harness-knowledge base** —
  the system gets faster at adapting to each new model.

## 9. Beyond the paper #2 — Online / continuous self-harness

- The same mining stage runs on **production** HALO traces (not just bench), so real Shannon/Cline
  traffic surfaces failures the bench misses. Proposals from prod traces are **never auto-applied** —
  they enqueue a validation run on the bench, and only a passing, regression-clean Mod is promoted.
- Cadence: a scheduled `uap self-harness run --since <window>` (cron) that mines recent prod traces,
  proposes, validates offline, and opens a PR-like profile diff for a human gate (configurable to
  auto-commit for low-risk env-knob Mods, human-gate for scaffold/middleware).

## 10. Safety, rollback, and self-poisoning prevention

This is non-negotiable: an auto-modifying harness that can tune guardrail thresholds **can wedge itself**
— we have direct evidence (the recon-convergence death-spiral, `2e82e88`, that stripped tools forever).
Controls:

1. **Bounded DSL + allow-list + ranges** — the loop physically cannot touch model/ctx/KV/spec, cannot
   emit arbitrary code, cannot set a knob outside its safe range.
2. **Held-out regression gate** — no Mod that regresses the held-out suite is accepted, even if it helps
   validation.
3. **Versioned profiles + one-command revert** — every accepted iteration is a git commit; rollback is
   `git revert` of the profile + a proxy/llama restart.
4. **Liveness canary** — after applying a profile, a fast smoke suite must pass *and* the guardrail-fire
   rates (breaker/recon/finalize per N requests) must stay within a sane band; a Mod that spikes them
   (the poison signature) is auto-reverted.
5. **Budget ceiling** — max iterations / token budget per run (we already have the workflow budget
   primitive); the loop stops when it converges or exhausts budget.

## 11. Phasing

- **P0 — Plumbing (small).** Promote the failure-mode logs to structured HALO spans; add the held-out
  regression suite; pin a stable `signature` hashing. *Exit:* `uap harness analyze` emits a typed
  `WeaknessReport`.
- **P1 — Closed loop, env+scaffold DSL (Option A).** `uap self-harness run` orchestrating
  mine→propose→validate→accept over `env`+`scaffold` Mods, reusing `benchmarks/paired/`. *Exit:* one
  autonomous iteration that accepts a real Mod (e.g. re-discovers `LLAMA_N_PREDICT=4096`) with stats.
- **P2 — Middleware Mods (Option B).** Add the `middleware` Mod class + the `toolcall-path-normalizer`.
  *Exit:* the loop proposes+validates the normalizer and measurably cuts path-garbling on the medium
  suite (the ceiling manual fixes couldn't crack).
- **P3 — Transfer + online (Option C). [BUILT]** Cross-model transfer store keyed by (model family,
  failure kind, signature) + transfer-seeded proposer (`src/self-harness/transfer.ts`); online mining from
  HALO spans AND proxy-log signals (`trace-mine.ts`); gated promotion queue (`pending.ts`) — prod-mined
  proposals enqueue for validation, env knobs may auto-promote after validation, scaffold/middleware are
  human-gated. CLI: `uap self-harness {transfer,mine-prod,pending}`. *Exit met:* a Qwen3.6 normalizer
  acceptance auto-seeds a Qwen3.7 proposal; real proxy-journal mining enqueued the path-normalizer behind
  a human gate. **Scheduling [BUILT]:** `deploy/systemd/uap-self-harness-mine.{service,timer}` — a daily user timer
  runs `mine-prod` (mine + enqueue, gated) then `prune`. **Ablation-prune [BUILT]:** `TransferStore.prune`
  + `PendingQueue.prune` drop stale / no-longer-paying entries; `uap self-harness prune`. P3 fully closed.

## 12. Success metrics

- **Primary:** autonomous resolve-rate lift on a held-out suite vs the frozen baseline harness, with CI
  excluding 0 (the paper's headline metric). Target: reproduce a Self-Harness-style lift on a model where
  the failure is harness-reachable.
- **Secondary:** time-to-adapt to a new model (transfer on vs off); guardrail-fire stability (no poison
  regressions); % of accepted Mods that survive periodic ablation (mod durability).
- **Guardrail:** zero self-induced wedges escaping the canary.

## 13. Open questions / risks

- **Reachability ceiling.** This cycle proved Qwen3.6-IQ4_XS's wall is token-level tool-call fidelity,
  which prompt/param Mods can't fix — only P2's middleware can. If middleware Mods are out of scope, the
  loop may correctly converge to "no further lift available," which is a *valid* (if unexciting) result.
- **Proposer cost/quality.** A weak proposer emits weak Mods; a strong remote proposer adds cost/dependency.
  Mitigate by caching proposals per signature and transferring across models.
- **Validation expense.** Each Mod costs a paired-bench run (~minutes×N on a slow local model). Mitigate
  with small fast validation suites for the inner loop, full suites only at profile-commit.
- **Non-stationarity.** Model/quant/driver changes invalidate prior Mods; the ablation-prune cadence and
  `(model_family,…)` keying address this but need tuning.

---

*Next step after review: P0 plumbing + the `Mod` DSL types, then the P1 orchestrator wired to the existing
HALO exporter and `benchmarks/paired/` runner.*
