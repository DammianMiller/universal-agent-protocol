# Kimi K3 × UAP Uplift Validation — Factory Droid Harness Plan

**Status:** Proposed (awaiting go-ahead before any paid API runs)
**Date:** 2026-09-02
**Supersedes:** the earlier opencode-based variant of this plan (the harness is now Factory Droid, the harness this repo's own sessions run in)

## Goal

Measure UAP's uplift on a frontier open-weight model by re-running an existing,
publicly-anchored benchmark with UAP enabled vs disabled, holding **model,
harness, task set, and attempt counts fixed**. The model is **Kimi K3**
(Moonshot AI, 2.8T-param MoE, open-weight, July 2026); the harness is
**Factory Droid** in headless mode (`droid exec`); the benchmark is
**Terminal-Bench 2.1**.

The only thing that differs between the two arms is the UAP treatment. That
paired design is the entire experiment: any resolution-rate delta is
attributable to UAP and nothing else.

## Why Terminal-Bench 2.1

K3's published scores with harness attribution (from the MoonshotAI/Kimi-K3
tech report and repo):

| Benchmark | K3 score | Harness | Re-runnable? |
|---|---|---|---|
| **Terminal-Bench 2.1** | **88.3** | Kimi Code | Yes — public tasks, deterministic verifiers, API-feasible |
| SWE-bench Verified | 93.4 | Vals AI | Partially — harness not public |
| SWE-Marathon | 42.0 | Claude Code / Harbor | Yes, but long-horizon = expensive |
| PostTrainBench | 36.6 | Claude Code | Yes, but GPU-calibrated |
| DeepSWE / FrontierSWE / Kimi-Code-Bench | various | internal | No — harness-locked |

Terminal-Bench 2.1 (89 Dockerized terminal tasks, time-boxed, resolved only
when post-run verifier tests pass) is the cleanest anchor:

- Public dataset with deterministic, non-LLM verifiers — no judge drift.
- Already supported by our in-repo paired-harness pattern
  (`benchmarks/terminal_bench/uap_opencode_agent.py`), which we adapt to Droid.
- Factory has published its own Droid-on-Terminal-Bench methodology
  (factory.ai/news/terminal-bench, Sept 2025, TB Core v0.1.1), so our Droid
  setup mirrors a canonical, publicly-described configuration rather than an
  ad-hoc one.

### Comparability caveat (read before quoting numbers)

K3's 88.3 was achieved on the **Kimi Code** harness, not Droid. Factory's own
TB analysis found harness design moves scores as much as model choice (Droid +
Sonnet beat Claude Code + Opus). So:

- **Primary claim (internally valid):** paired Δ = UAP-on minus UAP-off, same
  Droid+K3 stack. This is the number the experiment is designed to produce.
- **Secondary claim (cross-harness, caveated):** Droid+K3+UAP vs the published
  88.3 Kimi-Code anchor. Report it, always with the harness difference named.

## Configuration

### Kimi K3 via BYOK (`~/.factory/settings.json` inside the task container)

Primary endpoint — Moonshot's official API (OpenAI-compatible dialect):

```json
{
  "customModels": [
    {
      "model": "kimi-k3",
      "displayName": "Kimi K3",
      "baseUrl": "https://api.platform.kimi.ai/v1",
      "apiKey": "${KIMI_API_KEY}",
      "provider": "generic-chat-completion-api",
      "maxOutputTokens": 65536,
      "extraArgs": { "temperature": 1.0, "top_p": 1.0 }
    }
  ]
}
```

Fallback endpoint — OpenRouter (`baseUrl: https://openrouter.ai/api/v1`,
`model: moonshotai/kimi-k3`, `apiKey: ${OPENROUTER_API_KEY}`). Identical
pricing at time of writing: **$2.55 / Mtok input, $12.75 / Mtok output**.

Sampling parameters follow the K3 tech report's agentic-eval settings:
`temperature=1.0`, `top_p=1.0`, maximum reasoning effort. Droid's
`-r/--reasoning-effort` flag does **not** apply to custom models; if the
endpoint exposes a reasoning-effort knob (e.g. `reasoning_effort`), pass it
through `extraArgs` and confirm acceptance during Phase 0.

Model reference on the command line: `custom:Kimi-K3-0` (display name with
spaces dasherized + 0-based index into `customModels`).

### Arms

| Arm | Model route | UAP treatment |
|---|---|---|
| **A — Baseline** | Droid → K3 direct | none |
| **B — UAP (protocol)** | Droid → K3 direct | UAP operating protocol dropped as `AGENTS.md` in the task workdir (Droid reads `AGENTS.md` natively) — same honest treatment surface as the existing opencode paired shim: gates discipline, verify-don't-assume, stop-when-green |
| **C — UAP (enforced, optional)** | Droid → **UAP proxy :4100** → K3 | Arm B **plus** the UAP proxy in the request path, so deterministic enforcers (MANDATE-DELIVER, guardrails) are in the loop. Mirrors the `UAP_TB_UAP_BASE_URL` pattern of the opencode shim. |

A vs B is the primary paired comparison (cheapest, cleanest attribution).
C runs only if A/B shows a signal worth deepening, since it exercises the full
enforcement stack rather than prompt-level discipline alone.

### Droid invocation (per TB task, inside the task container)

Mirrors Factory's published TB methodology: non-interactive task mode, all
permissions skipped (containers are disposable), task specification passed as
the prompt.

```bash
droid exec \
  --skip-permissions-unsafe \
  --model "custom:Kimi-K3-0" \
  --output-format json \
  "$(cat /task/instruction.md)"
```

The UAP arm additionally writes `AGENTS.md` into the task working directory
before the run (and, for arm C, points the model `baseUrl` at the proxy).

### New adapter: `benchmarks/terminal_bench/uap_droid_agent.py`

A custom `AbstractInstalledAgent` — the same integration point Factory used
for its own TB runs — with two exported classes, `DroidBaseline` and
`DroidUAP`, differing only in the AGENTS.md drop (and proxy base URL for arm
C). A companion `uap-droid-setup.sh.j2` runs inside the container:

1. Install the Droid CLI: `curl -fsSL https://app.factory.ai/cli | sh`
2. Write `~/.factory/settings.json` with the customModels block above
3. Export `FACTORY_API_KEY` (headless auth) and the K3 provider key from
   host-passed env (`UAP_TB_KIMI_API_KEY` / `UAP_TB_OPENROUTER_API_KEY`,
   `UAP_TB_FACTORY_API_KEY`)

Run shape (from the bench venv):

```bash
UAP_TB_FACTORY_API_KEY=fk-... UAP_TB_KIMI_API_KEY=sk-... \
.tbvenv/bin/tb run \
  --agent-import-path uap_droid_agent:DroidBaseline \
  --dataset terminal-bench==2.1 -t <task-id> --n-attempts 5
# then again with :DroidUAP, and diff the two results.json
```

(Exact TB 2.1 dataset/registry name to be confirmed during Phase 0; the
harness moved to the Harbor registry since the opencode shim was written.)

## Protocol

Three phases, each gated on the previous one. **No paid run starts without an
explicit go from the user.**

### Phase 0 — Smoke (no benchmark scoring; ~$5)

Single cheap TB task (e.g. a hello-world-tier task), a few attempts, both
arms. Validates:

1. K3 responds correctly through Droid's `generic-chat-completion-api`
   provider — tool calls parse, multi-turn works.
2. **Preserved thinking history:** K3 requires prior `reasoning_content` to be
   passed back verbatim across turns. Whether Droid round-trips this field for
   generic providers is unknown — inspect request logs (or the arm-C proxy
   log) to confirm. If it does not round-trip, note the degradation, keep both
   arms identical (the paired comparison remains valid), and consider the
   Anthropic-compatible Kimi endpoint with `provider: "anthropic"` as a
   variant.
3. Container networking: container → provider egress; container → host proxy
   for arm C.
4. Headless auth: `FACTORY_API_KEY` works non-interactively in the container.

### Phase 1 — Pilot (~10–12 tasks × 3 attempts × 2 arms; est. $40–90)

Stratified sample across TB 2.1 categories (coding, build/deps, data/ML,
systems, security). Purpose: shake out adapter bugs, measure per-run token
burn to firm up the Phase 2 budget, and check variance. No conclusions drawn.

### Phase 2 — Full sweep (89 tasks × 5 attempts × 2 arms)

Five attempts per task matches both Factory's published TB convention and the
existing paired-harness format. Seeds fixed where the endpoint allows;
temperature/top_p held at the tech-report values in both arms.

### Analysis (format per `docs/benchmarks/PAIRED_FINDINGS.md`)

- Per-task paired resolution rates; Δ with bootstrap 95% CI.
- McNemar 2×2 on discordant task-attempt pairs.
- Secondary: tokens/cost per resolved task, wall-clock, gate-loop behavior
  (arm B should show more build/test iterations and fewer one-shot stops).
- Report both the paired Δ (primary) and the Droid+K3+UAP absolute score vs
  the 88.3 Kimi-Code anchor (secondary, harness caveat attached).

## Cost estimate

Rough per-run burn for TB-scale tasks under Droid (environment bootstrap +
multi-turn tool loop): assume 0.3–1.5M input tokens and 20–80k output tokens
per attempt. At $2.55/$12.75 per Mtok that is ~**$1.00–4.85 per attempt**.
Full sweep = 89 × 5 × 2 = 890 attempts → **~$900–4,300**. Pilot firms this up
before any full-sweep commitment. Prompt caching, if the endpoint honors it
for generic providers, cuts the input side substantially.

## Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| `reasoning_content` not round-tripped by Droid's generic provider | K3 degrades below published behavior | Phase 0 log inspection; both arms affected equally (paired Δ still valid); try Anthropic-compatible endpoint variant |
| Custom models get Droid's generic tool scaffolding, not per-model tuning | Absolute score likely below Kimi Code's 88.3 even before UAP | Expected and acceptable — the paired Δ is the claim; report absolute with caveat |
| Headless `FACTORY_API_KEY` auth inside containers | Adapter blocked | Phase 0 smoke |
| K3 rate limits / TTFT under parallel attempts | Wall-clock blowup on TB's aggressive timeouts | Bounded concurrency (xargs -P), retry-with-backoff in the adapter |
| Exact TB 2.1 registry/dataset name changed under Harbor | Run command fails | Confirm in Phase 0 against the current terminal-bench docs |
| Endpoint pricing moves | Budget | Re-quote at Phase 2 kickoff |

## Deliverables when executed

1. `benchmarks/terminal_bench/uap_droid_agent.py` + `uap-droid-setup.sh.j2`
   (the adapter; not part of this plan PR)
2. Phase 0/1/2 run artifacts under `benchmark-results/` in the established
   paired format
3. A findings doc modeled on `docs/benchmarks/PAIRED_FINDINGS.md` with the
   paired Δ, CI, McNemar table, and the caveated cross-harness comparison
