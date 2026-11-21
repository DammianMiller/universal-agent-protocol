# Deliver outcomes, the aggregated O1 dataset

**Status:** Descriptive (no controlled arm — this table directs where paired
runs should spend; it proves nothing about cause)
**Generated:** 2026-11-21, `uap memory outcomes` (v2.68.0)
**House rule:** every number here carries its discrimination status. This one
is **descriptive by construction** — observational counts of recorded lessons,
not a paired experiment.

## What this is

Proof-plan option O1: the delivery-gate telemetry the project already records
(the `[deliver]` outcome lessons — one per run: outcome, turns, best share of
gates, model, task) aggregated into the model table. Until now that corpus
existed only as prose lessons scattered across memory substrates; no round
could answer "which model delivers what share of gates" without a notebook.

Reproduce on any checkout or fleet box:

```
uap memory outcomes          # the table below
uap memory outcomes --json   # rows + aggregates + coverage, machine-readable
```

## The dataset (this box, 2026-11-21)

Coverage — which substrates contributed:

| substrate | reachable | rows |
|---|---|---:|
| daily-log corpus | reachable, no deliver lessons | 0 |
| bridge mirrors (CLAUDE.md / AGENTS.md) | reachable | 6 |

| model | runs | delivered | not delivered | stopped | gates mean | gates best | turns mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| qwen35-a3b | 5 | 1 | 2 | 2 | 67% | 83% | 7.4 |
| opus-4.8 | 1 | 0 | 1 | 0 | 0% | 0% | 5.0 |

Readings, each descriptive:

- **The local arm ceilings at 83% of gates** on real hardening/validation
  tasks (best observed across 5 recorded runs) and has delivered exactly once
  in the recorded set — a trivial single-turn smoke task. The two STOPPED
  runs are interruptions, not gate failures.
- **The frontier-class run recorded here failed at 0% of gates** — the
  autoroute single-flight task; 5 turns, nothing delivered. A frontier model
  is not a deliverable outcome by itself; the loop contract was the missing
  layer there.
- **Reads are 0.5–0.7% failure; the write family carries the mass** (the
  tool-calls corpus: `uap telemetry report`) — the round's write-path
  conclusions live in that report, not here.

## Coverage caveats (read before quoting)

- **This is a bridge-mirror snapshot.** The full lesson corpus lives in
  long-term memory (Qdrant), which was crash-looping when this dataset was
  generated (2026-11-21, container "Restarting (101)"; see
  `~/.uap/telemetry/memory-health.jsonl` once populated). The bridge mirrors
  carry only the most recent lessons and truncate task text. Numbers above
  are a floor, not a census; regenerate with `uap memory outcomes` once the
  semantic backend is healthy.
- **Lessons are self-recorded by the loop**, not independently audited; the
  gates themselves are the deterministic part.
- **No denominators exist for attempts never run** — models only appear here
  when a deliver run recorded a lesson.

## Where this directs the paired spend (O2/O7 targeting)

The table + the tool-call corpus together say the same thing the
[proof options](../plans/model-performance-proof-options.md) predicted: the
binding constraint on local-model outcomes is the harness layers around the
model (write-path discipline, digitized bars, recall honesty), not the model
class alone. The next paired runs (O2 hardest-tier, O7 role-DAG) should hold
the harness fixed and stratify exactly where this table shows runs stalling:
real multi-gate tasks at 33–83% of gates after 5–17 turns.
