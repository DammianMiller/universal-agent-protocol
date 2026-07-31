# Harness-engineering uplift — 2026-07-31

## Motivation

Three 2026 papers converge on one claim: **the harness, not the model, is the
binding constraint on agent reliability** — and they disagree with the folklore
about *which parts* of the harness matter.

| Source | Claim | Number |
|---|---|---|
| [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/abs/2605.23950) | Controlled factorial: harness variance dominates model variance | HV 18.48 pp² vs MV 2.37 pp² = **7.8×**; 6 of 9 model rankings *reverse* across harnesses |
| Pi Research / Grok Code Fast (via the above) | Changing **only the edit-tool format** | SWE-bench **6.7% → 68.3%** |
| [Agentic Harness Engineering](https://arxiv.org/abs/2604.25850) | Observability-driven auto-evolution of a coding harness, base model fixed | Terminal-Bench 2 **69.7% → 77.0%** |
| [Memory is Reconstructed, Not Retrieved](https://arxiv.org/abs/2606.06036) | Active reconstruction over a Cue–Tag–Content graph beats retrieve-then-reason | **+23%** LoCoMo; **118k** tokens/query vs A-Mem 632k, LangMem 3.26M; 586s vs 1122s |
| [Agent Harness Engineering: A Survey](https://picrew.github.io/LLM-Harness/) | ETCLOVG seven-layer taxonomy; "the harness is becoming the binding constraint" | *(no comparative scores cited — see Provenance)* |

### Provenance note

The widely-shared framing ("the ETCLOVG survey proves 6.7% → 68.3%") **conflates
two sources**. The survey cites no comparative scores at all. The 6.7% → 68.3%
figure is the Grok Code Fast edit-tool-format result, reported in the
harness-disclosure paper. The claim survives, but the *mechanism* is far more
specific than "optimize the harness": **the edit tool was the lever.** This plan
is built on the mechanism, not the slogan.

### The ablation that drives this plan

Agentic Harness Engineering evolved each harness component in isolation:

| Component evolved alone | Δ pass@1 |
|---|---|
| Long-term memory | **+5.6pp** |
| Tools | **+3.3pp** |
| Middleware | **+2.2pp** |
| System prompt | **−2.3pp** |

Prompt-only edits are **negative**. Gains concentrate in tools, middleware, and
memory. Gains are **non-additive** — component deltas do not sum.

---

## UAP scored against ETCLOVG

| Layer | UAP today | Gap |
|---|---|---|
| **E** Execution | `src/cli/sandbox.ts`, `delivery/sanitized-env.ts`, `verifier-ladder.ts`, execution-gate (vm-dom / child-process) | No container/microVM isolation tier. Low benchmark yield; deferred |
| **T** Tool | `delivery/agentic-executor.ts` (6 tools), MCP router, `toolcall-path-normalizer` middleware | **`edit_file` is exact-match only**: miss → dead turn. No fuzzy fallback, no nearest-match hint, no line-anchored variant, no batch edit, **no per-call outcome telemetry** |
| **C** Context/Memory | Qdrant semantic store, `memory/dynamic-retrieval.ts`, `hierarchical-memory.ts`, `knowledge-graph.ts`, compressors | **Passive retrieve-then-reason.** KG exists but is not a traversal substrate |
| **L** Lifecycle | orchestrator, epics, hands-free, HALO, decompose | Mature |
| **O** Observability | telemetry.db (`sessions`, `routing_decisions`, `time_series`, …), dashboard, `self-harness/trace-mine.ts` | **No per-tool-call outcome table.** No component-attributed failure corpus. Mutation proposal is therefore blind search |
| **V** Verification | `uap verify`, acceptance judge, execution gate, expert-review, `bench paired` + held-out suite | Best-in-class — but underused *as a search signal* |
| **G** Governance | policies, enforcers, self-protect, workdir-scope | Mature |

### The structural finding

`src/self-harness/validate.ts` auto-validates **`env` mods only** — inference
server launch knobs. `ScaffoldMod` and `MiddlewareMod` are explicitly routed to
a human-gated pending queue and return a null (no-lift) comparison so `decide`
rejects them.

> UAP's autonomous self-evolution loop searches the one surface the literature
> does not even list as a lever, while the three surfaces with measured
> +5.6 / +3.3 / +2.2pp are gated behind a human.

Inverting that is the largest structural gain available.

---

## Options

### A. Edit-tool hardening (T) — highest evidence-to-effort

`edit_file` fails hard on exact-match miss. Every miss is a wasted turn, and on
small local models misses are the dominant tool failure.

- **A1 — Tolerant matching (recommended).** On exact-match miss, retry with a
  whitespace/indentation-normalized match; if that resolves to exactly one span,
  apply it and tell the model its `old_string` was whitespace-inexact.
- **A2 — Nearest-match diagnostics (recommended).** On genuine miss, return the
  closest candidate span in the file as a diff instead of "not found". Turns a
  dead turn into a corrective one.
- **A3 — `edit_range` line-anchored variant (recommended).** `{path, start_line,
  end_line, new_text}`. Models that cannot reproduce exact whitespace *can*
  count lines.
- **A4 — Batch multi-edit.** `edit_file` accepting an `edits[]` array, applied
  atomically. Fewer round-trips, no interleaved-state hazards.
- **A5 — Edit-outcome telemetry (required for D).** Record every edit attempt:
  tool, path, outcome class, bytes changed, turn index.

### B. Invert the self-harness search space (V/O) — largest structural gain

- **B1 — Tool-schema mods first-class (recommended).** Add `ToolMod` to
  `self-harness/mods.ts` with an allowlist of safe tool-surface knobs (edit-match
  strategy, read window, error verbosity), routed through the same paired
  validator `env` mods use.
- **B2 — Middleware mods auto-validated (recommended).** `MiddlewareMod` already
  exists but returns a null comparison. Give it a real A/B: middleware is a
  config change, so the arms differ by a flag, not a server restart.
- **B3 — Risk tiers, not category bans.** Keep the human gate as a *tier* for
  high-blast-radius mods rather than a blanket category rejection.

### C. Prediction manifests + file-granular rollback (O)

Each proposed mod declares which tasks it predicts it will fix and which it puts
at risk. The next round verifies prediction against actual per-task delta and
reverts at file granularity. "Each edit becomes a falsifiable contract."
UAP has propose → validate → decide but no manifest-attribution-rollback.

### D. Evidence corpus / Agent Debugger (O) — prerequisite for B and C

- **D1 — `tool_calls` telemetry table (recommended).** run, task, component,
  tool, outcome, error class, turn index, latency, bytes.
- **D2 — Failure taxonomy (recommended).** Classify every failed call into a
  stable error class so classes can be counted, ranked, and targeted.
- **D3 — Layered evidence distillation.** Per-task failure analysis plus a
  benchmark-level overview with per-component attribution, consumed by the
  propose stage. Without it, mutation proposal is blind search.

### E. Active memory reconstruction (C) — biggest headline number, biggest build

Port MRAgent's Cue–Tag–Content graph onto `knowledge-graph.ts` and make
retrieval an iterative traverse-and-prune loop rather than one-shot semantic
search. Directly attacks the recorded context-overflow failure on monolithic
epic builds.

Ablation warning: **the tag layer is the contribution.** Cue→Content without
tags scores ~65% recall vs ~90% for the full structure. A "graph memory" that
skips tags gets none of the benefit.

- **E1 — Cue/Tag/Content extraction + graph build.**
- **E2 — Active traversal loop** with action selection, semantic pruning, and a
  sufficiency stop condition (papers converge at 3–4 turns).
- **E3 — Wire behind an opt-in flag**, off by default until paired bench shows lift.

### F. Harness disclosure card (cross-cutting) — cheap, load-bearing

Emit an ETCSOVG card with every `bench paired` result: execution substrate, tool
list + schema style + error format, context caps and retrieval method,
scheduling/stop/retry rules, logged artifacts, verification rails, permission
model. Two payoffs: results become reproducible/comparable, **and the card
defines the search space that B mutates over.**

### G. Execution isolation tier (E) — deferred

Container/microVM tier for untrusted runs. Blast-radius play, not a quality
play; low expected benchmark lift. Not in this plan.

---

## Sequencing

**F → D → A → C → B → E.**

F and D are cheap and load-bearing for everything after. A ships independently
and carries the strongest evidence. C + B together flip the self-evolution loop
onto the high-yield surfaces. E is sized like its own epic.

## Constraints to respect

1. **Harness coupling problem** (survey): optimizing a layer in isolation can
   degrade the whole. Nothing here is accepted on reasoning alone.
2. **Non-additivity** (AHE): component gains do not sum; aggregate lift is capped
   below the sum of the ablations. Do not forecast stacked deltas.
3. **Every mod validates through `uap bench paired`** with the existing held-out
   disjoint suite for overfit detection — the machinery already exists.
4. **Prompt-only edits measured negative.** Do not spend search budget there.

## Validation review (recorded 2026-07-31)

- *Assumption*: edit-tool format is the dominant tool-layer lever. **Risk**: the
  Grok case started from a *bad* format; UAP's `edit_file` is already exact-match
  with corrective errors, so headroom is smaller. **Mitigation**: measure, do not
  forecast a delta.
- *Risk*: tool-schema changes regress the strong-model path. **Mitigation**:
  tolerant matching runs strictly *after* exact match; new tools are additive and
  the tolerant path is a config knob defaulting to on only for the fallback.
- *Risk*: per-call telemetry write volume. **Mitigation**: WAL + bounded retention.
- *Gap*: E is epic-sized; phased and off by default.
- *Request match*: yes — analyze the cited posts, plan options, implement, ship.

## Acceptance — 2026-07-31

Split honestly into **connected** (runs on a real code path) and **landed**
(implemented and tested, but nothing calls it yet). A plan that marks the second
as the first is the most expensive kind of debt in a self-modifying system.

### Connected

- **A — edit-tool ladder.** `src/delivery/edit-match.ts`, wired into
  `edit_file`/`edit_range` in the agentic executor. Exact → whitespace-tolerant
  (indent-preserving on Python/YAML/Make) → nearest-region report; atomic
  `edits[]` batches; line-anchored `edit_range`. On by default.
- **D — evidence corpus.** `tool_calls` written by every executor tool call,
  classified by `src/telemetry/tool-failure.ts`, distilled by
  `summarizeToolCalls`, readable via `uap harness evidence`.
- **D→B — evidence proposer.** `src/self-harness/evidence-proposer.ts` reads the
  corpus and emits `ToolMod`s. Without it the corpus was written but unread and
  `ToolMod` was defined but never proposed.
- **B — tool/middleware auto-validation.** `ToolMod` + `TOOL_KNOB_ALLOWLIST`;
  `buildValidator` A/Bs both kinds through the paired validator; `promotionGate`
  is a risk tier. The `toolcall-path-normalizer` is now gated on
  `UAP_MW_TOOLCALL_PATH_NORMALIZER`, so its A/B varies something real.
- **F — disclosure card.** `uap bench paired` passes a `HarnessCardInput`, so
  every paired report carries its ETCSOVG card. `uap harness card` prints the
  live one.
- **C — change manifests.** `runSelfHarnessLoop` threads `manifests` /
  `priorRecords` into the orchestrator, so stage 0 attribution and revert run on
  the real loop, not only in tests.
- **E — active memory reconstruction.** `reconstruct-ingest.ts` turns UAP's
  memory entries into cue–tag–content triples (deterministic extractor behind an
  injectable seam, mirroring `ReconstructionPolicy`); `reconstruct-store.ts`
  builds the derived graph from **both** memory tiers and exposes `recallActive`;
  `uap memory graph build|status` and `uap memory query --active` are the
  callers. Verified on the real store: 50 memories → 462 cues, 77 tags, **19
  bridging tags**, and a five-hop traversal that reaches evidence the query never
  names. Opt-in (`--active` / `UAP_MEMORY_ACTIVE=1`), refuses to route to an
  empty graph, and **falls back to passive retrieval** when reconstruction finds
  nothing or throws.

### Not done (deliberately)

- **E, remaining.** The extractor is deterministic rather than the paper's LLM
  extraction — a seam, not a rewrite. And no *agent* code path calls
  `recallActive` yet: `dynamic-retrieval.ts` (what assembles model context) is
  untouched, so today this changes what a **human** gets from `uap memory query`,
  not what a **model** is given. The AHE memory ablation (+5.6pp) is about the
  latter; claiming that number for this would be wrong.
- **G** (container/microVM execution tier) — blast-radius work, no measured
  benchmark lift. Out of scope.
- No uplift figure is claimed. Every mechanism here is wired and tested; which of
  them pays on OUR suite is what `uap bench paired` is for, and that run has not
  happened yet. The literature's numbers are the literature's.

## E-connection review (second pass)

Connecting E drew its own parallel review; the blockers it found:

| # | Defect | Fix |
|---|---|---|
| 1 | **`--active` silently dropped long-term memory.** The passive path queries short-term FTS *and* Qdrant; active replaced it with a graph built from the rolling ~50-entry short-term window only. A regression wearing a feature's clothes | `itemsFromLongTerm` ingests the semantic store; coverage reported per tier; falls back to passive when reconstruction is empty or throws |
| 2 | `--rebuild` duplicated the corpus instead of rebuilding — it reset the dedupe set without truncating, so two rebuilds meant every memory twice, permanently | `graph.clear()` truncates; test asserts `stats().contents` |
| 3 | Items skipped for "no cue" were marked ingested, dropping them forever — including after the extractor seam is upgraded | `seen.add` only after a successful store; `storedKeys` returned and marked |
| 4 | Ledger keyed on source id alone, so `uap memory correct` never reached the graph — it served pre-correction text forever | Key includes a content hash and the extractor id |
| 5 | The per-query refresh used `projectId: 'project'` and ignored the configured store path, so it indexed zero rows for any real project | `resolveStoreConfig` mirrors `uap memory query` |
| 6 | Default policy stopped after ONE hop (`sufficientAt: 3`) — every test had to override it, so the multi-hop mechanism was proven only under a policy the product did not ship | Default raised to 12 |
| 7 | `maxExpandPerStep` lived only inside the default policy, so the first LLM policy would reproduce the 453-cue full scan | Enforced in `reconstruct`, intersected with the active set |
| 8 | STOPWORDS were bypassed by the identifier regex — "The deploy failed" produced the cue `the` | Stopwords applied to identifiers |
| 9 | `type` and `when:YYYY-MM` derived tags are hubs, not bridges (a month links everything written that month), and inflated the `bridgingTags` health metric | Hubs only as a last-resort edge; bridging requires <60% corpus coverage |
| 10 | `bench paired` hardcoded `memoryMode`, so its card would state the wrong mode | One `describeMemoryMode`; `C.memory_mode` added to `MUTABLE_CARD_FIELDS` |
| 11 | Short-term handle leaked when the read threw — once per query, since recall refreshes every call | `close()` in `finally` |
| 12 | `--steps abc` produced NaN → zero iterations → "No evidence survived pruning", a false statement | `positiveInt` validation |
| 13 | `shouldUseActiveRecall` ran five aggregates on every query and card render | Cheap `isEmpty()` probe; added the missing `mg_triples(tag)` index |
| 14 | Context-budget overflow was reported as "pruned" and advised raising `--steps`, which cannot help | Separate `dropped` list and a `stopReason` |

## Defects found and fixed during review

Parallel expert review (code-quality / security / architecture) found real
defects in the first cut. The ones that mattered:

| # | Defect | Fix |
|---|---|---|
| 1 | `edit_range`/`edit_file` bypassed the anti-gutting guard — `edit_range(1, N, "")` deleted a file and returned OK, while `write_file`'s refusal text names edit_file as the alternative. The escape route was the bypass. | `editGuttingRefusal` on both edit paths + regression tests |
| 2 | Tolerant matching dropped leading whitespace, so an anchor in one Python block bound to another, and the replacement landed at column 0 | Indent preserved for indent-sensitive languages; replacement re-indented onto the target |
| 3 | Tolerant rung left the original trailing newline, so the same (old,new) pair produced different files depending on which rung fired | One trailing newline stripped on the line-aligned path, matching `applyRangeEdit` |
| 4 | `occurrence` was re-indexed against the normalised candidate list — a different set — landing the edit at an unrelated site and reporting success | Multi-site tolerant matches are refused outright |
| 5 | `classifyToolResult` filed every failed `run_bash` as `ok` (results start `exit=`, not `ERROR:`), leaving `command-failed` dead code and the execution component permanently healthy | Classified by exit code; `refused` and `tamper-restored` classes added |
| 6 | The corpus was written under `projectRoot` — discarded temp dirs for bench cells, and `agents/data/` inside customer repos — while `uap harness evidence` read `process.cwd()` | Single per-user root under `~/.uap/telemetry`, overridable |
| 7 | Row cap keyed off a per-process counter that never reached it; handle cache unbounded across bench cells | Prune on open; LRU-capped handle cache |
| 8 | `detail` persisted the nearest-region report — user source excerpts — indefinitely | First line only |
| 9 | Middleware A/B was a null experiment: `middlewareEnvKey` was read by nothing, so both arms were identical and `decide` accepts on `netGain > 0` alone | Normalizer gated on that key |
| 10 | `validate.ts` restored env by the Mod's *claimed* `from`, leaking a wrong value into every later candidate; no allow-list check at the apply site | Observed prior captured; `validateMod` enforced |
| 11 | `run.ts` committed only `env` Mods but reported ALL accepted Mods as committed | Per-kind disposition; `unapplied` reported |
| 12 | `passingTasks` ignored `condition`, so on a real two-arm `records.jsonl` every predicted fix read as unrealised and `revertOnZeroRealised` would revert everything | Condition-scoped, majority-of-seeds pass ratio |
| 13 | A task absent from the later round scored as an undeclared regression → immediate revert | Intersection, not union |
| 14 | Stage 0 reverted into `profile` but stage 2 proposed from `opts.profile` | Propose from the post-revert profile |
| 15 | `edit_file` never ran the agent-internal guard `write_file` has, so `.uap/`, `.git/`, `node_modules` were editable through it | Guard added to both edit paths |
| 16 | `attributeWeakness` ran after the profile mutation, so it returned null and the transfer store lost attribution too | Computed once, before any mutation |
| 17 | Card read `process.env` at render time and hardcoded `read_window_bytes`; `UAP_STUB_GUARD` is not a real variable | All varying fields injected; correct guard names |
| 18 | Nearest-region report ignored its own line cap — a 200-line anchor echoed 200 lines into context | Bounded by `maxLines` |
| 19 | Batch edits had no size cap, no `new_string` requirement, and silently dropped the top-level pair when both forms were sent | Capped at 64; explicit errors |
