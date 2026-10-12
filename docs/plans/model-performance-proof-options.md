# Model-performance proof options — how to demonstrate UAP's benefits with honest numbers

**Status:** Proposed (a menu of options, ordered by cost; each names what it
would prove, what it would NOT prove, and its price — no option starts
without an explicit go)
**Date:** 2026-10-12
**Builds on:** [PAIRED_FINDINGS](../benchmarks/PAIRED_FINDINGS.md) (the honest
baseline: what has and has not replicated), the
[reliability ladder](../performance/reliability-ladder.md) (the underpowered-status
rule), [harness-engineering uplift](harness-engineering-uplift-2026-07-31.md)
(the mechanism priors), and [K3 uplift validation](k3-uap-uplift-validation.md)
(the frontier run).

## The claim we are actually proving

The measured history constrains what any honest plan can promise. The paired
harness established:

- UAP's gate loop delivers a large accuracy lift **only against base agents
  that do not self-verify** (+20pp vs a single-shot model); against a strong
  self-verifying harness the pooled accuracy effect is a wash
  (**Δ 0.0pp [−5.5, +6.9]** — the CI excludes +20pp) at a token cost.
- UAP never significantly *hurt* accuracy on any surface measured.
- The one tier where payoff dwarfed cost in the ladder is the hardest one
  (brutal tier 26.1% → 56.8%, ⚠ underpowered).

So "prove benefits and improvements to model performance" decomposes into
**four distinct, separately-provable claims** — and each option below is
mapped to the claim(s) it can actually carry:

| # | Claim | Where it is strongest |
|---|---|---|
| C1 | The gate loop lifts weak/non-self-verifying models and hardest-tier tasks | Local paired A/B |
| C2 | Memory + compounding surfaces lift long-horizon, multi-session work | Unmeasured gap — no existing number |
| C3 | Operator surfaces (attention, pace) improve throughput/stopping, not accuracy | Unmeasured gap |
| C4 | Frontier-model uplift under a canonical harness | The K3 plan |

**House rule (applies to every option):** every reported delta carries its
discrimination status (powered / underpowered / descriptive) and a paired
design — same model, same tasks, same seeds, only the UAP layer toggled.
An underpowered delta is labeled "directional, underpowered" and never quoted
as a finding. Analysis follows the established format: per-task paired rates,
bootstrap 95% CI, McNemar on discordant pairs.

## The options, ordered by cost

### O1 — Aggregate the delivery-gate telemetry we already record (free)

**Claims:** C1 (descriptive support) · **Cost:** hours of analysis, no runs ·
**Prereqs:** none — the data exists.

Every `deliver` outcome already records best-%-of-gates per attempt per model
per technique (the `[deliver]` lessons). Option: aggregate this corpus into a
measured table — model × technique × tier → gate-pass rate and token cost —
and publish it as the first *descriptive* performance dataset.

- **Would prove:** where in the model/technique matrix the protocol's gates
  bind (and where they are overhead) — at population scale, no new runs.
- **Would NOT prove:** causality (no controlled arm); it is descriptive
  evidence that directs where to spend O2's controlled runs.
- **Discrimination status:** descriptive by construction; label it that way.

### O2 — Targeted local paired replication where the payoff was (free, GPU-local)

**Claims:** C1 · **Cost:** GPU-hours only ·
**Prereqs:** the local stack (`uap bench paired`, the swe-bench-pro-gen suite).

Re-run the paired harness on the current local model stack, UAP on/off, but
**stratified to the cells the ladder says matter**: the hardest tier (the
only tier with a measured 2.2× payoff, still underpowered) and a weak
single-shot arm (the +20pp regime, to check it still holds on today's models).

- **Would prove:** whether C1 survives replication on the current stack with
  enough attempts to graduate from "underpowered, directional" to a powered
  finding — the single most valuable upgrade to the ladder.
- **Would NOT prove:** anything about memory, attention, or frontier models.
- **Discrimination status:** starts underpowered by design; the run count is
  chosen from a power calculation on the pilot variance (the existing paired
  format's bootstrap CI sizes the needed attempts).

### O3 — The multi-session memory experiment (free; the real gap)

**Claims:** C2 · **Cost:** GPU-hours + a task-suite design ·
**Prereqs:** a k-session task sequence where session k depends on k−1.

The strongest *unmeasured* claim. The harness-engineering ablation gives the
prior (long-term memory alone: +5.6pp on their harness) and the paired
findings could not test it (their tasks are single-session). Design: N task
*sequences* of k sessions each, same model, two arms — UAP memory on vs
wiped-between-sessions — measuring per-session success, tokens, and the
session-over-session trend. The paired Δ *and the slope difference* are the
two numbers.

- **Would prove:** whether UAP's memory system (recall-first, compounding,
  one store across agents) delivers the multi-session lift C2 claims — this
  is the repo's most defensible original contribution, so it deserves the
  repo's most careful experiment.
- **Would NOT prove:** single-session accuracy (O2's territory).
- **Discrimination status:** no prior number exists; pilot first, then power
  up. Sequence design is the hard part and is the first deliverable.

### O4 — Pace-injection stopping behavior (free, unit-level)

**Claims:** C3 · **Cost:** hours · **Prereqs:** the `eta:pace` reactor block
and `model_analytics.db`.

The measured-pace surfaces inject the agent's own EWMA estimate. Test whether
the injection changes *stopping* behavior: iterations past green, wall-clock
to stop, over-iteration rate — paired on/off on the same task set. This is a
behavior metric (throughput and token waste), deliberately not an accuracy
claim.

- **Would prove:** whether the pace surface earns its place (faster correct
  stops = tokens saved with no accuracy loss).
- **Would NOT prove:** accuracy improvement; a null result here is also
  publishable (it would justify demoting the surface).
- **Discrimination status:** underpowered at pilot scale; directional unless
  powered up.

### O5 — Attention/AFK unattended-throughput (free)

**Claims:** C3 · **Cost:** hours · **Prereqs:** the attention queue + a
task set with operator-blocking asks.

Measure blocked-on-operator time per session with the queue on vs off (the
ask-instead-of-stop rail plus the AFK auto-decider): wall-clock to
completion, number of hard stops, safe-default adoption correctness (each
adoption is logged, so correctness is auditable).

- **Would prove:** the throughput claim — less idle time, more unattended
  completions — and that auto-adopted defaults were correct (the safety
  claim).
- **Would NOT prove:** accuracy improvement; the correctness audit bounds the
  risk the throughput number would otherwise hide.
- **Discrimination status:** descriptive unless task count is powered.

### O6 — Frontier replication under a canonical harness (paid)

**Claims:** C4 · **Cost:** ~$5 smoke → ~$40–90 pilot → ~$900–4,300 full ·
**Prereqs:** the [K3 plan](k3-uap-uplift-validation.md), verbatim.

The frontier option is already written, phased, and gated on an explicit go:
Terminal-Bench 2.1, Factory Droid as harness, Kimi K3 via BYOK, paired
arms (baseline / AGENTS.md protocol / full proxy enforcement). Nothing here
supersedes it; it is the only option with an external, publicly-anchored
comparator (K3's published 88.3, harness caveat attached).

- **Would prove:** whether the protocol treatment lifts a frontier model
  under a harness Factory itself has published methodology for.
- **Would NOT prove:** attribution to any single UAP surface (it is the
  whole-protocol treatment); the paired Δ is the claim, the absolute score
  is the caveated secondary.
- **Discrimination status:** 89 tasks × 5 attempts is powered for the
  published convention's effect sizes; report Δ with bootstrap CI + McNemar.

## Suggested order

1. **O1** (free, hours of analysis, no risk) → publishes the descriptive dataset and
   targets O2's strata.
2. **O2 hardest-tier replication** (free, targeted) → upgrades the ladder's
   strongest row from underpowered to powered, or retires it honestly.
3. **O4 + O5** (free, small) → the C3 throughput numbers, including the
   demote-if-null honesty.
4. **O3** (the gap) → design review first (the sequence design is its own
   deliverable), then pilot, then power up.
5. **O6** (paid) → only after O1–O3 sharpen what the frontier arms should
   emphasize, and only on the explicit go the K3 plan already requires.

## What no option here claims

None of these options will show UAP lifting a strong self-verifying agent's
single-session accuracy — the pooled 0.0pp replication already bounds that
claim, and the honest headline is the *conditional*: the protocol pays where
verification, memory, and operator attention are otherwise missing. A plan
that promised more would be exactly the unpowered-delta marketing the paired
findings exist to prevent.
