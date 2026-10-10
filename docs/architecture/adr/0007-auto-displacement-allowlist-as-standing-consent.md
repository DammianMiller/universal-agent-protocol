# ADR 0007: Auto-displacement allowlist as standing operator consent

- Status: Proposed
- Date: 2026-10-09 (branch `feature/345-model-placement`, phase 4)
- Spec: `docs/specs/operator-model-placement.md` §4.4.1, §6 (phase-4 note)
- Supersedes: none — extends ADR 0006's core invariant ("never evict without
  explicit operator confirmation") to the request-driven case.

## Context

Phase 4 makes placement request-driven: a gated request that parks because its
model is not resident can load itself, so the operator stops running
`uap models apply` by hand (the motivating case: running `ugc-factory`
end-to-end without manual model switching). The spec's phase table originally
said phase 4 ships "auto-load alongside; never displacement", and the core
invariant says an operator confirms every eviction. On this machine
`load_alongside` has no solutions at all (one config holds 21,812 of 24,576
MiB), so alongside-only auto mode would auto-load nothing that matters here
and the operator would keep hand-running swaps for exactly the models they
already trust.

## Decision

1. **Non-displacing options auto-enforce whenever the policy is enabled**
   (`~/.uap/placement-auto.json`, opt-in, fail-closed). Reuse needs nothing;
   load-alongside evicts nothing; the budget math already said it fits.
2. **Displacement auto-enforces only for models on an explicit allowlist**,
   recorded by `uap models auto --allow-displace <model> --yes`. The allowlist
   IS the explicit operator confirmation the core invariant requires:
   - standing, not per-event — the `--yes` gate prints exactly what is being
     consented to ("UNLOADS the current resident(s) — the minimal set that
     makes room, re-evaluated at load time — and loads the requested one
     WITHOUT an operator prompt between them");
   - deliberate — nothing enters it by default, and a bare `--allow-displace`
     without `--yes` records nothing;
   - auditable and revocable — the file is plain JSON in `~/.uap`, per-model
     removal via `--disallow-displace`, whole feature off via `--disable`.
3. **The consent subject is the model being LOADED, not the victim.** Victims
   are dynamic: enforcement re-derives the minimal eviction set and
   drift-checks it against the live ledger at run time (`enforce.ts`), so a
   static victim list would go stale the moment residents change. The loaded
   model is the stable thing the operator is vouching for.
4. **Run-shape guards bound the standing consent** (phase-4 parallel review):
   one run per requested model, single-flight machine-wide, a hard concurrency
   cap, a failure cooldown that kills any drain→stop→fail→rollback
   oscillation, TTL extension so the supervised entry outlives its run, and a
   run that never rejects (a ledger-write throw must not kill the dashboard).

## Consequences

- The operator's machines can swap models unattended, but only for models
  they explicitly named; everything else still parks for a human `apply`.
- The allowlist must be reviewed like any standing credential: a model on it
  can be loaded by any gated client request while the resident is evicted
  without a prompt. `uap models auto` (status) is the audit surface.
- "Never displacement" in the phase table was amended to "never displacement
  by default" — the reasoning lives in the spec §6 phase-4 note and here.
- The proxy stays dumb (reason strings only); the controller remains the
  single decision-maker, and the policy file is the single authority
  (independent of `PROXY_PLACEMENT_MODE`).

## Addendum (2026-10-11): idle unload uses the same doctrine

Auto-load had no reverse: residents loaded by §4.4.1 held their device until
a human stopped them. The idle sweep (spec §4.4.2) extends this ADR's
reasoning to auto-UNLOAD, which is also an unattended change to what runs on
the machine:

- `unload_allow` is standing consent with the same shape as
  `allow_displace`: `uap models auto --allow-unload <model> --yes` (the
  `--yes` gate prints what stops, when), per-model revocation via
  `--disallow-unload`, feature off with no `unload_idle_after_secs` recorded.
- The consent subject is again the model, not the moment: the clock resets on
  every gated request served, an unwatched resident's clock starts at first
  observation (arming never evicts the already-idle), and unknown endpoint
  state (`ss` unable to answer) is a refusal to unload, never a guess.
- The stop reuses the operator's full `unloadPlacement` machinery — the
  standing consent covers WHEN, and the drain/in-flight/rollback guards
  still bound it per-event.
