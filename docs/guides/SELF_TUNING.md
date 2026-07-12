# LLM Self-Tuning

Raise a small model (e.g. qwen3.6) toward Opus-level output by tuning UAP's own
flag surface with a closed, benchmark-validated loop. Where **Self-Harness**
(`uap self-harness`) mines failure traces and rewrites proxy/scaffold knobs to
fix *correctness* bugs, **Self-Tuning** (`uap tune`) optimizes the first-class
settings surface — recipes, hands-free, memory, concurrency, proxy guardrails —
against a *quality* signal.

> Design: [`docs/design/LLM_SELF_TUNING_ANALYSIS.md`](../design/LLM_SELF_TUNING_ANALYSIS.md).

## The idea

A small model can't reliably judge its own output, and pass/fail on a task suite
doesn't tell you how *good* the output is. Self-tuning adds:

1. **A quality signal** (P0) — a multi-dimensional `QualityScore` (correctness,
   quality, efficiency, tool-reliability, planning → composite 0-100), scored by
   a stronger **judge model** when configured, or deterministically from the run
   metrics otherwise.
2. **An LLM-guided tuner** (P1) — a stronger model proposes small, interpretable
   flag changes given the quality history; when no judge is available a real
   **Gaussian-process Bayesian optimizer** (ARD kernel over the mixed
   numeric/enum/bool flag space, Expected-Improvement acquisition) picks the next
   config instead.
3. **A closed loop** (P2) — every proposal is applied, validated by a paired A/B
   benchmark (candidate config vs current, quality-scored), and accepted only on
   a statistically-supported quality lift with no held-out regression.
4. **Model profiles** (P3) — the best-known config per model family, persisted
   and reused; bundled starters for qwen3.6 and Opus ship in the box.
5. **Real-time adaptation** (P4) — per-session flag adjustments emitted from live
   signals (tool-failure spikes, quality dips, context pressure, RECON loops)
   over the one live channel the proxy honors mid-session.

## Quick start

```bash
# Dry-run a tuning loop over the real-gate suite with a local model (GP-only,
# no judge). Reports the best config it found without committing.
uap tune --model qwen36-a3b --adapter opencode

# Same, but let a stronger judge model both SCORE quality and PROPOSE changes.
uap tune --model qwen36-a3b --adapter opencode --judge opus-4.8

# Commit the tuned config to .uap.json / .uap/proxy.env and save the profile.
uap tune --model qwen36-a3b --adapter opencode --judge opus-4.8 --apply

# Offline smoke test (deterministic mock adapter — no live model needed):
uap tune --adapter mock --max-iterations 3 --json
```

`uap self-harness tune` is an alias of `uap tune`.

### Key flags

| Flag | Meaning |
|------|---------|
| `--model <id>` | Executor model family to tune (default `qwen36-a3b`). |
| `--adapter <name>` | `mock \| opencode \| claude \| mini \| raw \| deliver`. |
| `--judge <id>` | Judge/tuner model. Falls back to `recipes.judge.model`, then GP-only. |
| `--phase <name>` | Force one search phase: `coarse \| medium \| fine \| combinatorial`. |
| `--max-iterations <n>` | Tuning-loop budget (default 6). |
| `--apply` | Commit accepted configs + save the profile (default: dry-run). |
| `--json` | Machine-readable result. |

## What gets tuned

The tunable surface (`src/self-tuning/flags.ts`) is a curated subset of the
settings registry, each with a search domain and a **dependency** so the
optimizer never wastes trials on an inactive knob (e.g. `recipes.fusionN` only
matters when `recipes.recipe` is `fusion`/`auto`, which itself needs
`recipes.enabled`):

- **recipes**: `enabled`, `recipe`, `confidenceThreshold`, `fusionN`, `allowSelfJudge`
- **hands-free**: `enabled`, `intensity`, `UAP_HANDSFREE_STAGNATION_LIMIT`
- **concurrency**: `modelConcurrency.slots`, `modelConcurrency.adaptive`
- **memory**: `memory.shortTerm.maxEntries`, `memory.patternRag.enabled`
- **verification**: `delivery.runtimeVerify`
- **proxy guardrails**: `PROXY_RECON_CONVERGENCE_THRESHOLD`, `PROXY_LOOP_BREAKER`, `PROXY_STUCK_BREAK`

All writes go through the same validation as `uap config set`, so an
out-of-range proposal is clamped — it can never corrupt `.uap.json`. Rejected
trials are rolled back to the exact prior bytes.

## Profiles

Accepted configs advance a versioned `TuningProfile` under
`.uap/self-tuning/<model>.json`. Bundled starter profiles seed a fresh run and
act as cross-model transfer priors:

- **qwen3.6** — guardrail-heavy, judge-backed fusion, aggressive hands-free.
- **Opus 4.8** — the quality upper bound (most guardrails relaxed).

The runtime source of truth is the typed constants in
`src/self-tuning/profiles/*.ts`; the sibling `*.json` files are human-readable
reference artifacts.

## Real-time adaptation (opt-in)

The proxy freezes `PROXY_*` at startup and has no reload endpoint, so mid-session
tuning rides a per-session **adaptation signal** file — the same mechanism as the
recipe signal. Enable it with:

```bash
export PROXY_REALTIME_ADAPT=1   # proxy side: honor adaptation signals
export UAP_REALTIME_ADAPT=1     # emitter side: reactor emits them
```

When enabled, live signals map to conservative, hot-reloadable adjustments:

| Signal | Adjustment |
|--------|-----------|
| tool-failure rate ↑ / turn-quality ↓ | escalate this turn to the judge (fusion) |
| context-window utilization ↑ | converge sooner (lower recon threshold) |
| RECON no-write streak ↑ | force synthesis / deliver now |

With both flags unset (the default), nothing is emitted or honored and behavior
is unchanged.

## How it relates to Self-Harness

| | Self-Harness (`uap self-harness`) | Self-Tuning (`uap tune`) |
|---|---|---|
| Input | failure traces (HALO + proxy log) | quality-scored benchmark A/B |
| Optimizes | correctness (proxy/llama env, scaffold, middleware) | quality (first-class settings) |
| Proposer | heuristic + transfer | LLM tuner or GP-BO |
| Signal | pass/fail + McNemar | composite quality delta |
| Shared | the paired-bench validation pipeline, the Mod DSL (now incl. `ConfigMod`), and the versioned-profile pattern |
```
