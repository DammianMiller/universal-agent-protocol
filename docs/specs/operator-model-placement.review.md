# Architecture Review — Operator-Directed Model Placement (MOS + MPC)

Reviewed: `docs/specs/operator-model-placement.md` (963 lines, commit `3e415113`).
Reviewer lens: pattern fit, blast radius, cost of reversal, evolutionary path.
All claims below were verified against the worktree at
`/home/cogtek/dev/miller-tech/universal-agent-protocol/.worktrees/345-model-placement`.

## Verdict

**Accept with conditions.** The design is unusually well-grounded — measured
footprints, fail-closed unknowns, `mode=off` default, a byte-identical
regression test as the top-priority test. It is not implementable as written:
three load-bearing factual claims about existing code are false, and one
prerequisite the enforcement phase depends on does not exist in tracked config.
Conditions 1-4 below are blocking for phase 2; condition 5 is blocking for
phase 3.

## Pattern Fit

Strong fit where it touches existing machinery:

- `mutationAuthorized` (`src/dashboard/server.ts:205`, applied at 351, 368, 391,
  451) is the right gate for placement writes and the spec correctly reuses it
  rather than inventing an auth path.
- `execStartMustContain` / `metricsMustMatch` doctrine is cited accurately.
  Verified in `config/capacity-policy.json`: `strata-server` declares
  `metricsMustMatch: {kv: "int8", max_context: 131072}` with
  `headroom.gpuMinFreeMiB: 200` and an explanatory `_headroom_comment`;
  `gsq-rco-server` declares `execStartMustContain: ["-c 229376", "-np 2",
  "--vbr-vram 5120M", "--cache-ram 32768"]` with `gpuMinFreeMiB: 600`. Every
  number §4.1 quotes is real.
- The `target = 'default'` legacy bucket plus an optional trailing argument on
  `acquireModelSlot` is the correct additive shape, and the spec correctly
  identifies the delete-then-count-then-insert ordering in
  `src/coordination/service.ts:1075` as the safety property to preserve.
- Layering is mostly right: `src/placement/` as a library consumed by CLI,
  dashboard, and proxy mirrors how `src/inference/` (probes, analysis) is
  consumed by `src/capacity/probe.ts` and `src/cli/inference.ts`.

Fit gaps:

- **Dependency direction is never stated.** `src/placement/` must depend on
  `src/inference/probe.ts` (probe primitives, `SlotsInfo`, `collect`) and
  `src/capacity/` (policy parsing), never the reverse. §5 item 4 (per-UUID GPU
  probing) is a change to `src/inference/probe.ts`, which `uap doctor` already
  consumes — phase 0 therefore edits a module with live consumers, and the spec
  should say so.
- **The registry is a fifth source of endpoint truth.** It would carry
  endpoints, units, rails, and costs, alongside `src/models/types.ts` (pinned
  `endpoint: 'http://127.0.0.1:4000/v1'` with an explicit comment at
  `src/models/types.ts:229` that pinning the live backend alias "would turn a
  backend switch (`~/.config/uap/model-switch.sh`) into an outage"),
  `config/model-profiles/`, `config/llama-profiles/`, and
  `config/capacity-policy.json`. The spec's "one source of truth per number"
  rule is applied only to the capacity policy. It needs an ownership table
  naming which file owns endpoint, rail count, context geometry, and cost.
- **CLI namespace collision.** `uap model` (singular) already exists at
  `src/bin/cli.ts:2035`; `uap inference` at `src/bin/cli.ts:609`; a `models`
  dashboard subcommand at `src/cli/dashboard.ts:48,95`. §4.7's `uap models ...`
  needs to either extend `uap model` or state why a near-homonym is deliberate.

## Blast Radius

Affects: `tools/agents/scripts/anthropic_proxy.py` (17k lines, every client),
`src/coordination/database.ts` + `service.ts` (lease table, backpressure),
`src/utils/model-slot-lease.ts` + `model-slots.ts`, `src/inference/probe.ts`,
`src/dashboard/server.ts`, `web/dash/tab-models.js` + `tabs.js:494`,
`src/bin/cli.ts`, `config/capacity-policy.json`, `src/models/types.ts`.

Worst case if wrong: an enforcement step that stops a unit and fails to start
the replacement leaves the machine with **no backend on `:4000`/`:8080`** while
every agent, role fallback, and harness profile still points there. That is a
full local outage, not a degraded path — which is why the spec's insistence on
rollback-before-`auto` is correct and should be a hard gate, not a phase label.

Second-worst case is quieter and more likely: a stale upstream model-id cache
after a successful switch (see Recommended Change 2) rewrites every subsequent
request to the *previous* backend's model id. No crash, no banner, wrong model.

Feature-flagged: yes, and well. `PROXY_PLACEMENT_MODE=off` as the shipped
default with a byte-identical-behavior test is the right contract.

## Cost of Reversal

- **Registry + ledger + CLI (phases 0-1): easy.** New files, no existing
  consumer. Revert is a `git revert`.
- **Proxy gate + `409` (phase 2): costly once a client learns the code.**
  `model_placement_pending`, `placement_id`, and `retry_after_ms` become a
  client-visible contract the first time a client branches on them. Coordinate
  the shape with `api-designer` before phase 2; treat it as public API.
- **Lease/backpressure migration (between 1 and 2): the one-way door.**
  `ALTER TABLE model_leases ADD COLUMN target` is trivially reversible, but the
  `model_backpressure` rebuild (drop `CHECK(id = 1)`, primary key on target)
  rewrites a table with no version marker. Once operators have tuned per-target
  backpressure, reverting the code loses that state. Keep the legacy `id = 1`
  row mapped to `target = 'default'` so a revert is code-only.
- **`~/.uap/placement.json` and `~/.uap/model-registry.json` on-disk shapes:
  locked-in** the moment a measurement exists on a machine. Version them from
  day one (`version: 1` is already in the ledger sketch; the registry sketch
  needs the same).

## ADR Status

**Required, not drafted.** Decisions 1 (two-file registry merge), 2
(enforcement on the TS side reached over loopback HTTP from a Python proxy),
and 4 (`paused` = offload-and-reload, not save/restore) are all one-way-ish and
will be argued about again in six months without a record. Draft appended below;
file it as `docs/architecture/adr/0006-operator-directed-model-placement.md`
(next free number; `0005-ollama-compatible-surface.md` is the current head).

## Blocking conditions

1. **§4.3's unbypassability claim is false and must be rewritten.** The spec
   says the gate is unbypassable because "every request path that can change the
   model must pass through `_reconcile_wire_model()`". It has exactly **one**
   call site: `anthropic_proxy.py:1681` defines it, `:15036` calls it, inside
   the `/v1/messages` path. Upstream sends also happen at `:1606`
   (`_post_with_retry_inner`), `:11872`, `:11934`, `:12231`, `:12445`, `:13556`,
   `:15065`, `:15099`, `:15118`, `:15233`, `:15340`, `:15392`, `:15417`,
   `:15529`, `:15561`, `:15580`, `:15693`, plus the passthrough path
   (`_pt_client`, `:14473`) and the save/restore path (`_sr_client`, `:13823`),
   under routes `/v1/chat/completions` (`:15832`), `/api/chat` (`:16618`),
   `/api/generate` (`:16655`), and `/anthropic/v1/messages` (`:15743`). The
   purity claim is fine — it only mutates `openai_body["model"]`, adds to
   `_rewritten_model_ids`, and logs. The coverage claim is not. §4.3 must
   enumerate the entry paths and state which are gated and which are exempt
   (and why), or the gate is a hole in the exact place it matters.

2. **Backend swap invalidates cached upstream state; the spec does not
   mention it.** `_upstream_model_ids_cached()` (`:1648`) caches the upstream's
   advertised ids for the **process lifetime** (`global _upstream_model_ids`,
   "fetched at most once per process"), and `_upstream_model_name()` (`:1724`)
   reads the same endpoint. After enforcement replaces the resident model, the
   next request fails `requested in ids` and `_reconcile_wire_model` rewrites it
   to the **old** backend's first id. Enforcement must invalidate that cache
   (and the `/props`, `/slots`, `_admitted_sessions` state at `:4920`, and the
   connection pool) as an explicit step between "start new unit" and "release
   pending request". Add it to §4.6 step 7 and to the §7 test list.

3. **§4.5's live-holder source does not exist.** `_client_registry` appears
   nowhere in the repo except this spec; `/v1/api/clients` is not a route (the
   proxy's routes are `/v1/messages`, `/anthropic/v1/messages`,
   `/v1/chat/completions`, `/api/version`, `/api/tags`, `/api/show`, `/api/ps`,
   `/api/chat`, `/api/generate`, `/v1/models`, `/health`, `/v1/context`);
   `anthropic_proxy.py:1121` is the toolcall path-normalizer import block; and
   the named contextvars `_current_session_var` / `_current_request_id_var` do
   not exist. The real primitives are `_current_request_session` (`:4853`),
   `_disconnect_holder` (`:4889`), `_inflight_inc`/`_inflight_dec` (`:4628-4637`,
   counters hung on the httpx client object), `_admitted_sessions` (`:4920`),
   and `_client_request_times` / `resolve_client_id` (`:2011-2020`). None is
   exposed. The impact preview therefore needs a **new proxy endpoint** that
   reports live in-flight work per target — new machinery, not a join of two
   existing registries. That changes the phase-2 estimate and should be named as
   a phase-2 deliverable.

4. **`Conflicts=` and the alternate-config units are not in the repo.**
   `grep -rn "Conflicts=" config/` returns nothing, and the capacity policy
   states `strata-server` is **unit-less** ("launched by
   `/home/cogtek/dev/strata/run-iq3_xxs.sh`... No restartBudget: with no unit,
   NRestarts does not exist"). Enforcement step 4 is
   `systemctl --user start <new unit>` with "the profile's flags" — for every
   alternate config on this host, that unit does not exist in tracked config,
   and the reference implementation (`~/.config/uap/model-switch.sh`) is
   machine-local and unreviewed. Add a phase-0 deliverable: tracked systemd
   units (with `Conflicts=` edges) for every placeable config, or the design
   degrades to raw process control, which the risk table explicitly forbids.
   Note also that `config/capacity-policy.json`'s `services` is a **list**, not
   a map — `models validate` must look entries up by `name`.

5. **§5.1's call-site list and migration precedent are wrong.** The service
   method `acquireModelSlot` (`src/coordination/service.ts:1075`) has exactly
   one TS caller, `src/utils/model-slot-lease.ts:94`; `src/cli/coord.ts` does
   not reference it. The real consumers go through `withModelSlot()` at
   `src/delivery/agentic-executor.ts:2569` and
   `src/models/openai-compat-client.ts:260`. And the claim that schema
   evolution "already lives" in `src/coordination/database.ts` is false — that
   file contains no `ALTER TABLE` or `PRAGMA` at all, and there is no
   `PRAGMA user_version` anywhere in `src/`. The precedent is
   `src/memory/short-term/schema.ts` (a `PRAGMA table_info` guard at `:23`, and
   at `:32` the exact comment the spec needs: "SQLite doesn't support ALTER
   TABLE to change CHECK constraints, so we must rebuild the table", with the
   create-copy-drop-rename at `:75`), plus
   `src/policies/database-manager.ts:111-125` and `src/tasks/database.ts:140-153`.
   Because the coordination DB has no version marker, the migration must be
   guarded by a `PRAGMA table_info` probe to stay idempotent across opens — an
   unguarded `ALTER` next to `CREATE TABLE IF NOT EXISTS` will throw on second
   open.

6. **Controller discovery is new work, not reuse.** §4.3 says the lifecycle
   helper "already passes `UAP_DASHBOARD_URL` to the proxy"; that string appears
   nowhere in the repo except this spec, and the proxy reads no `DASHBOARD`
   environment variable. Separately, the dashboard binds `requestedPort` which
   may be `0` (OS-picked, resolved as `boundPort` after `listen`,
   `src/dashboard/server.ts:680`) and may bind `0.0.0.0` with an explicit
   "reachable on the LAN" notice. A control endpoint that stops and starts
   systemd units must be loopback-bound regardless of `--host`, with
   `mutationAuthorized` on every write; state that in §4.7.

7. **`target` must be the placement target, not the model name.** The two live
   holders are already `agentic:${model.apiModel ?? 'default'}` and
   `model:${model.apiModel ?? 'default'}`. Deriving the new `target` column from
   `apiModel` would make a backend switch change the key, orphaning outstanding
   leases and resetting per-target backpressure — the same hazard
   `src/models/types.ts:229` documents. Define `target` as the stable device +
   endpoint identity from the ledger, and say so in §5.1.

## Recommended Changes

1. Rewrite §4.3's decision table to name the gated entry paths explicitly, and
   add a test that a request on `/v1/chat/completions` and on the passthrough
   path cannot reach a non-resident local model when `mode=ask`.
2. Add "invalidate upstream caches" to §4.6 step 7 and to §7.
3. Replace §4.5's phantom `_client_registry` / `/v1/api/clients` with the real
   primitives and add "in-flight-per-target endpoint on the proxy" as a phase-2
   deliverable.
4. Add tracked systemd units (with `Conflicts=` edges) for every placeable
   config to phase 0; correct the risk-table row that asserts the edges already
   exist.
5. Correct §5.1's call-site list and migration precedent; require a
   `PRAGMA table_info` idempotence guard; define `target` as endpoint identity.
6. Add a **phase 1.5: per-target upstream addressing**, before the proxy gate.
   `LLAMA_CPP_BASE` is a single module constant (`:289`) referenced 35 times,
   including every derived probe — `.replace("/v1", "/props")` (`:3403`,
   `:16452`), `/slots` (`:3470`, `:3529`, `:4926`, `:15073`), `/health`
   (`:5210`, `:16722`), `_upstream_port()` CLOSE-WAIT accounting (`:4580`), and
   the streaming retry loops (`:15065-15700`). A per-target semaphore on top of
   one upstream base admits per-target placement while the proxy can still only
   address one backend, which makes phases 3-4 decorative. The enabler is a
   resolved target object `{target_id, base_url, slots_url, props_url,
   health_url}` threaded through the send paths with `LLAMA_CPP_BASE` as the
   default target. It is the riskiest refactor in the file and should be
   sequenced and reviewed on its own, not folded into the gate.
7. Add an ownership table (registry vs `capacity-policy.json` vs
   `config/*-profiles` vs `src/models/types.ts`) so the registry does not
   become a second pinned-endpoint source.
8. Version `~/.uap/model-registry.json` explicitly (`version: 1`) and keep the
   `model_backpressure` rebuild mapped so `id = 1` remains `target = 'default'`,
   preserving a code-only revert.
9. Hand the `409 model_placement_pending` body to `api-designer` as a public
   contract before phase 2 ships.

## Debt assessment

Paying down real debt: the prose-in-five-profile-files problem, the
`DEFAULT_SLOTS = 2` lie on a single-rail backend (`src/utils/model-slots.ts:13`
— correctly flagged as safe for llama.cpp and unsafe for Strata), the
single-row `model_backpressure`, and the global `upstream_semaphore`. Adding new
debt only if phase 1.5 is skipped: a per-target policy layered on a
single-target transport is exactly the kind of "just for now" seam that becomes
permanent.

## Anti-patterns present

- None of the flagged anti-patterns (no shared mutable singleton, no new
  cross-cutting concern bolted onto one module, no schema change without a
  migration path). The `mode=off` default is a genuine kill switch.
- One near-miss: the registry risks becoming a public structure that leaks
  implementation detail (unit names, engine flags, on-disk GGUF paths) into the
  dashboard payload. Keep the read API in terms of target id, cost, and state.

## Coordination handoffs

- `api-designer`: the `409` body, the six `/api/placement/*` routes, and the
  new `placement` event-stream category.
- `compliance-officer`: open question 2 (whose consent for someone else's
  eviction) is a policy decision, not an engineering one; it needs a recorded
  answer before phase 3.
- `refactoring-specialist`: phase 1.5 per-target upstream addressing in
  `anthropic_proxy.py`.

## Appendix — ADR draft to file as ADR-0006

```markdown
# ADR-0006: Operator-directed model placement (registry + ledger + proxy gate)

## Status
Proposed

## Context
One 24 GiB GPU, seven placeable model configs, one of them resident and filling
the card (measured 21,812 MiB of 24,576; host RSS 52.9 GiB of 121.7 GiB). Model
switching today is a hand-run shell script (`~/.config/uap/model-switch.sh`)
with no drain, no verification, and no rollback. The proxy forwards to a single
upstream (`LLAMA_CPP_BASE`, one constant, 35 references) and has no model
lifecycle at all. Requests for a non-resident model either fail or silently get
rewritten by `_reconcile_wire_model()`.

## Decision
1. Two-file registry: reviewed defaults in `config/model-registry.json`,
   machine-local measured footprints in `~/.uap/model-registry.json`, deep-merged
   local-over-repo, with per-field provenance reported by `uap models validate`.
   Unknown cost fails closed: an unmeasured config can be served if resident but
   can never be loaded or evicted.
2. Placement state lives in a versioned, advisory-locked ledger
   (`~/.uap/placement.json`). The ledger records intent; a live probe records
   fact; when they disagree the probe wins and the disagreement is surfaced.
3. Enforcement is TypeScript, hosted on the dashboard server, invoked by the
   Python proxy over loopback HTTP. No new daemon; one process owns placement
   state, and the TUI and dashboard read the same one.
4. `paused` means weights offloaded and reloaded from disk later — not the
   proxy's existing save/restore, which checkpoints KV to host RAM and frees no
   VRAM. Where an engine has no reload path, `paused` is display-only and the
   only executable option is `kill`.
5. Admission runs in the proxy after wire-model resolution, default
   `PROXY_PLACEMENT_MODE=off`. Parked requests get `409
   model_placement_pending`; the proxy never holds a socket across an unbounded
   operator decision.
6. Leases and backpressure become target-keyed with an additive `target =
   'default'` legacy bucket, preserving the delete-then-count-then-insert
   transaction ordering that makes `acquireModelSlot()` safe today.

## Consequences
Positive: placement decisions become data (`uap doctor`, `uap models validate`)
instead of prose in profile files; displacement is expressed in MiB rather than
unit names; the operator sees the victim list before committing, and enforcement
aborts if the re-derived list differs.
Negative: the proxy gains a control-plane dependency on the dashboard process
(no dashboard means read-only admission and `reason: no_controller`); the
teardown/start time envelope is unmeasured, so drain and hold timeouts ship as
conservative defaults labelled unvalidated; the coordination DB gains a table
rebuild with no version marker, so the migration must be probe-guarded.
Neutral: `uap models` sits next to the existing `uap model` command.

## Alternatives Considered
- **Enforcement in the proxy (Python).** Rejected: the proxy has no subprocess
  or systemd machinery in 17k lines, and the TS side already owns the units, the
  capacity policy, the lease ledger, and the dashboard.
- **A dedicated placement daemon.** Rejected: two processes holding placement
  state, and a new thing to supervise on a box that already supervises too much.
- **Derive cost from GGUF file sizes.** Rejected by measurement: 79 GiB on disk
  for a 21.8 GiB GPU footprint, and 15 GiB on disk for a config needing 22+ GiB.
  Disk size is not a proxy for anything.
- **Use the existing save/restore path for `paused`.** Rejected: it frees no
  VRAM, costs 10-20 s per slot, and may not fit in 29.7 GiB of available host
  RAM against a 52.9 GiB resident process.
- **Advertise a fixed VRAM cost per model.** Rejected: cost is per config and
  drifts with engine build and flags; unmeasured entries are marked
  `unmeasured` rather than guessed.
```
