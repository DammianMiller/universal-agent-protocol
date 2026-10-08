# ADR 0006: Operator-directed model placement (registry + ledger + proxy gate)

- Status: Proposed
- Date: 2026-10-08 (branch `feature/345-model-placement`)
- Spec: `docs/specs/operator-model-placement.md`

## Context

One 24 GiB GPU, seven placeable model configs, one of them resident and filling
the card (measured 21,812 MiB of 24,576; host RSS 52.9 GiB of 121.7 GiB). Model
switching today is a hand-run shell script (`~/.config/uap/model-switch.sh`)
with no drain, no verification, and no rollback. The proxy forwards to a single
upstream (`LLAMA_CPP_BASE`, one constant, 35 references) and has no model
lifecycle at all. Requests for a non-resident model either fail or silently get
rewritten by `_reconcile_wire_model()`.

## Decision

1. **Two-file registry.** Reviewed defaults in `config/model-registry.json`,
   machine-local measured footprints in `~/.uap/model-registry.json`,
   deep-merged local-over-repo, with per-field provenance reported by
   `uap models validate`. Unknown cost fails closed: an unmeasured config can
   be served if resident but can never be loaded or evicted. The registry
   references the capacity policy rather than restating its numbers (ownership
   table in the spec, §4.1).
2. **Placement state lives in a versioned, advisory-locked ledger**
   (`~/.uap/placement.json`). The ledger records intent; a live probe records
   fact; when they disagree the probe wins and the disagreement is surfaced.
3. **Enforcement is TypeScript, hosted on the dashboard server, invoked by the
   Python proxy over loopback HTTP.** No new daemon; one process owns placement
   state, and the TUI and dashboard read the same one. The proxy discovers the
   controller via `PROXY_PLACEMENT_CONTROLLER` emitted by `uap setup`; the
   control surface is loopback-bound regardless of the dashboard `--host`.
4. **`paused` means weights offloaded and reloaded from disk later** — not the
   proxy's existing save/restore, which checkpoints KV to host RAM and frees no
   VRAM. Where an engine has no reload path, `paused` is display-only and the
   only executable option is `kill`.
5. **Admission runs in the proxy after wire-model resolution**, default
   `PROXY_PLACEMENT_MODE=off`, gated per entry route (the gate is a function of
   the resolved wire model, not a side effect of one route's rewrite step —
   `_reconcile_wire_model` has exactly one call site). Parked requests get
   `409 model_placement_pending`; the proxy never holds a socket across an
   unbounded operator decision. A swap invalidates the proxy's process-lifetime
   upstream-id cache before any pending request is released.
6. **Leases and backpressure become target-keyed** with an additive
   `target = 'default'` legacy bucket, preserving the
   delete-then-count-then-insert transaction ordering that makes
   `acquireModelSlot()` safe today. `target` is the placement target identity
   (device + endpoint), never the model name. The migration is guarded by a
   `PRAGMA table_info` probe (the coordination DB has no version marker), on the
   precedent of `src/memory/short-term/schema.ts`.

## Consequences

Positive: placement decisions become data (`uap doctor`, `uap models validate`)
instead of prose in profile files; displacement is expressed in MiB rather than
unit names; the operator sees the victim list before committing, and
enforcement aborts if the re-derived list differs.

Negative: the proxy gains a control-plane dependency on the dashboard process
(no dashboard means read-only admission and `reason: no_controller`); the
teardown/start time envelope is unmeasured, so drain and hold timeouts ship as
conservative defaults labelled unvalidated; the coordination DB gains a table
rebuild with no version marker, so the migration must be probe-guarded;
per-target upstream addressing (phase 1.5) is a prerequisite refactor in the
17k-line proxy and cannot be skipped.

Neutral: `uap models` sits next to the existing `uap model` command.

## Alternatives Considered

- **Enforcement in the proxy (Python).** Rejected: the proxy has no subprocess
  or systemd machinery in 17k lines, and the TS side already owns the units,
  the capacity policy, the lease ledger, and the dashboard.
- **A dedicated placement daemon.** Rejected: two processes holding placement
  state, and a new thing to supervise on a box that already supervises too
  much.
- **Derive cost from GGUF file sizes.** Rejected by measurement: 79 GiB on disk
  for a 21.8 GiB GPU footprint, and 15 GiB on disk for a config needing 22+ GiB.
  Disk size is not a proxy for anything.
- **Use the existing save/restore path for `paused`.** Rejected: it frees no
  VRAM, costs 10-20 s per slot, and may not fit in ~29 GiB of available host
  RAM against a 52.9 GiB resident process.
- **Advertise a fixed VRAM cost per model.** Rejected: cost is per config and
  drifts with engine build and flags; unmeasured entries are marked
  `unmeasured` rather than guessed.
