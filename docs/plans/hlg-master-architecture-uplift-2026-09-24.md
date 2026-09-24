# Harness/Loop/Graph master-architecture uplift — 2026-09-24

**Source:** [@marfinxx, 2026-07-27](https://x.com/marfinxx/status/2081687570488954915)
— "Harness Engineering, Loop Engineering, and Graph Engineering are not
competing ideas; they are the three structural layers of a single production
system." Five-stage master architecture: sandbox init → parallel graph fan-out →
local evidence-gated retry loops → harness state hashing / token dedup →
adversarial red-team gate → verified PR.

**Relation to prior work:** the 2026-07-31 harness-engineering uplift
(`harness-engineering-uplift-2026-07-31.md`) covered the ETCLOVG/harness side
(edit-tool ladder, evidence corpus, self-harness inversion, active memory). This
plan covers the marfinxx post's distinct emphases: the **graph layer as the
default topology**, **state-hash token dedup**, the **adversarial gate as a
mandatory pipeline stage**, and **one entry point composing all five stages**.

## UAP scored against the three layers (2026-09-24)

| Layer | Post's requirement | UAP today | Verdict |
|---|---|---|---|
| Harness | spec file, sandbox, least-privilege, memory outside model | CLAUDE.md spec, worktree gate, `sandbox.ts`/`sanitized-env.ts`, Qdrant + active-reconstruction memory, policy enforcers | Strong |
| Loop | evidence-gated stops, budget caps, attempt limits | `verifier-ladder.ts`, `execution-gate.ts`, `convergence-loop.ts`, completion gates, proxy repeat-guard/attractor detection, `capacity-policy.json` | Strong — ahead of the post |
| Graph | fan-out by default, specialized sub-agents, sync/approval gates | `task-orchestrator.ts` wave-barrier parallel dispatch exists but **defaults to `concurrency: 1`**, opt-in via `deliver.parallelTasks` | Partial — weakest layer |

Gaps vs the five stages:

1. **Stage 2** — fan-out is opt-in, not the default topology.
2. **Stage 4** — no content-hash dedup serving zero-token cached reads across
   turns; only in-process `ReadCache` notes and proxy repeat detection.
3. **Stage 5** — adversarial machinery exists (`test-oracle-additive.ts`,
   `critic.ts`, `deep-security-review`) but no default pre-PR node that writes
   edge-case tests to break the patch.
4. **No single entry point** composing the five stages ("one prompt → verified
   PR").
5. **No measured intern-vs-master number** — the K3 paired validation
   (`k3-uap-uplift-validation.md`) was planned but never executed.

## Selected options (user-approved 2026-09-24)

| # | Option | Layer | Status |
|---|---|---|---|
| E | K3 paired bench Phase 0 | Evaluation | Adapter shipped (`benchmarks/terminal_bench/uap_droid_agent.py` + `uap-droid-setup.sh.j2`); **paid smoke blocked on missing keys** (`UAP_TB_KIMI_API_KEY`/`UAP_TB_OPENROUTER_API_KEY`/`UAP_TB_FACTORY_API_KEY`) |
| A | Graph default flip: parallel fan-out default in `task-orchestrator` | Graph | in progress |
| B | Harness state-hash read dedup (extend `ReadCache`, content-hash keyed, write-invalidated) | Harness | in progress |
| C | Adversarial red-team gate stage before PR | Graph/Loop | pending |
| D | Master pipeline entry point composing stages | All | pending (after A–C) |
| F | Docs positioning | — | not selected |

## Constraints

1. Nothing accepted on reasoning alone: behavioral defaults (A, B) ship behind
   measurements or with an escape hatch, per the harness-coupling warning in the
   2026-07-31 plan.
2. Parallelism flip must preserve the safety property the `concurrency: 1`
   default protected (shared-tree mutation); parallel only where isolation is
   in place.
3. Dedup must never serve stale content; write paths invalidate.
4. The adversarial gate composes existing machinery rather than adding a new
   model call where a deterministic check suffices (post's anti-pattern #4:
   don't force deterministic work into models).

## Validation

- Per-change: build + targeted vitest/pytest.
- Pre-merge: full `npm test`, `tsc --noEmit`, parallel review protocol
  (code-quality / security / architecture) with `uap review prepass`.
- Uplift claim: only after the E bench runs; no forecast deltas.
