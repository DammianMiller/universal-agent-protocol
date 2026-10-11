# ADR 0009: Completion-triggered dispatch and per-leaf model dials

- Status: Proposed
- Date: 2026-10-11 (branch `feature/353-bridge-p2-scheduling`)
- Spec: bridge-program Phase 2 (C1 scheduling, C2 routing), responding to the
  "serial execution / no delegation" and "wrong worker on the wrong job"
  gaps in mtlynch.io's *Why Are Coding Agents So Dumb?*
- Supersedes: none — replaces the wave-barrier scheduling note documented in
  `deliver.parallelTasks` (CONFIGURATION.md) and the `OrchestratorConfig`
  doc block; extends the `DeliveryPhase` plan schema additively.

## Context

Two independent costs lived in the task orchestrator:

1. **Wave-barrier idling.** The main loop dispatched a "wave" of up to
   `concurrency` READY tasks and waited for ALL of them (`Promise.all`)
   before recomputing the ready set. A 2-minute task in a wave with a
   30-minute sibling left its slot idle for 28 minutes, and a dependent
   whose only blocker finished early still waited for the whole wave.
2. **Mission-wide model binding.** One model per mission meant paying the
   strong model's rate for mechanical fill/test leaves, or starving the
   hard design leaf by running everything cheap. Phase plans are the natural
   place to say which leaf needs which worker, but `DeliveryPhase` had no
   dial and deliver bound the executor model once, at mission start.

## Decision

1. **C1 — completion-triggered dispatch.** The orchestrator keeps an
   in-flight array, fills free slots from the READY set (graph order), races
   on completion, and settles the winner sequentially before refilling.
   Invariants:
   - settlement is strictly one-at-a-time; graph mutations (blackboard,
     skip cascade, repair chains, P5 re-planning) never interleave;
   - WHICH flight settles first is timing-dependent: `outcomes` interleaving
     varies run-to-run and the per-id contract is last-entry-wins. This is
     a deliberate trade of run-to-run reproducibility for utilization;
   - a throwing settle drains in-flight flights (`allSettled` in a
     `finally`) so a seam-callback throw cannot abandon tasks mid-mutation
     (reachable only under completion-triggered dispatch — the wave barrier
     guaranteed an empty in-flight set on any throw).
2. **C2 — per-leaf model dials.** `DeliveryPhase.model?: string` is an
   optional dial, planner-relayed (copy a key the MISSION text names
   verbatim, never invent one) or hand-authored. Semantics:
   - normalized once at parse (`normalizeModelDial`: lowercased to match
     the preset table, control-character-stripped against log injection,
     64-char cap); the run-state resume sanitizer applies the SAME rules;
   - bound only where a per-task executor exists (isolated + agentic
     tasks); the shared non-isolated executor stays mission-bound at start
     because its write-allowlist refs are shared mutable state;
   - fail-closed: unknown keys, non-isolated tasks, and the blind-executor
     path all degrade to the mission model with a warning naming the actual
     reason, plus a plan-time lint at mission start (not hours later at
     bind time). The preset lookup uses `Object.hasOwn` — prototype-chain
     keys (`constructor`, `__proto__`) are planner-reachable untrusted
     text and must not bind an unpinned model.
3. **Known debt, out of scope here:** the production projection drops
   `criteria` (pre-existing; the dial threading fixed `model` in the same
   map). Filed for a separate change.

## Consequences

- Utilization: a slot refills the moment a task settles; dependents start
  when their last dependency succeeds, not when the wave drains.
- The first C1 tests would literally deadlock under wave scheduling — they
  pin the behavior by construction (a regression manifests as a timeout).
- Resume round-trips keep dials; the persisted `model` key is additive and
  old readers strip it harmlessly (their allowlist predates the field).
- Blast radius: `task-orchestrator.ts` (loop), `decompose.ts` (schema +
  prompt), `orchestrated-mission.ts` (threading + P5 feed), `deliver.ts`
  (projection + binding), `run-state.ts` (round-trip), two reference docs.
