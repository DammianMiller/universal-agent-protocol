# Operator-Directed Model Placement (MOS + MPC)

Status: draft for review. Not implemented.
Scope: local inference placement — which model sits on which device, who is
allowed to ask for a different one, and what happens to everyone already
resident when the answer is no.

## 1. The problem

Model choice in UAP is a **deployment-time** decision, not a request-time one.

Today the operator picks a backend by hand. `~/.config/uap/model-switch.sh`
takes one of `flash | exl3 | signal | gsq | ampere | swift | strata`, disables
every other backend unit, starts the chosen one, and blocks on
`http://127.0.0.1:8080/health`. The units are mutually exclusive by
declaration — `uap-strata-server.service` carries:

```
Conflicts=uap-exl3-server.service uap-llama-server.service uap-ampere-server.service
          uap-swift-server.service uap-signal-server.service uap-gsq-rco-server.service
          uap-flashnext-server.service uap-dflash-server.service
```

So the card holds exactly one model at a time, and switching it is a manual,
blind act. Three consequences:

1. **A request can name a model the machine cannot load, and nothing says
   so.** The proxy rewrites the wire model (`_reconcile_wire_model()`,
   `tools/agents/scripts/anthropic_proxy.py:1681`, called at `:15036`) and
   forwards. If the named model is not resident, the request either gets the
   resident model or fails downstream, after the client has already paid the
   round trip.
2. **Switching destroys work with no warning.** There is no view of who is
   attached to the resident model, what they are doing, or how much context
   they lose. The operator chooses blind.
3. **The cost of loading a second model is unknown at decision time.** The
   numbers exist — but only as prose in profile comments.
   `config/exl3-profiles/qwen38-27b-exl3.env:17` records
   `VRAM resident: 20964 MiB / 24576 MiB`;
   `config/llama-profiles/qwen38-27b-dflash2.env:37` records
   `23449 / 24576 MiB` at `--parallel 2`;
   `config/llama-profiles/gemma4-26b-a4b-mtp.env:38` records
   `~20-21 GB, leaving headroom for the ub2048 compute buffers`.
   Nothing machine-readable consumes them.

What is wanted: an agent (coding, video, image) asks UAP for a model path; the
system answers with what it *can* do on this hardware right now; the operator
chooses which models load on which devices; and a forced switch shows, before
it happens, exactly what gets killed or paused.

## 2. What already exists (verified)

Do not rebuild these. Placement composes on top of them.

| Concern | Existing mechanism |
| --- | --- |
| Declared service budgets, headroom, restart budgets | `config/capacity-policy.json`, `src/capacity/policy.ts` |
| Health semantics, fail-open vs fail-closed probes | `docs/guides/CAPACITY_POLICY.md`, `src/capacity/probe.ts` |
| Free VRAM probe | `probeGpuFreeMiB()` — **GPU 0 only** |
| Post-load config verification | `metricsMustMatch` (`{"kv":"int8","max_context":131072}` for `strata-server`) |
| Slot budget: env → config → probe → default | `src/utils/model-slots.ts` (`DEFAULT_SLOTS = 2`, 30s cache) |
| Cross-process slot semaphore, AIMD backpressure | `src/utils/model-slot-lease.ts`, `src/coordination/service.ts:1045-1174` |
| Lease persistence | `model_leases` table, `src/coordination/database.ts` |
| Local server discovery (no hardcoded port) | `src/utils/llama-discovery.ts` (`ss -ltnp`) |
| Inference quality, not just liveness | `uap inference health`, `src/inference/strata.ts` |
| Dashboard write authorization | `mutationAuthorized(req)` in `src/dashboard/server.ts` |
| Operator's current manual switch | `~/.config/uap/model-switch.sh` |

Two gaps that shape the design:

- **`model_backpressure` is one row** (`id = 1 CHECK`). Every target shares one
  adaptive limit. Two models on one machine cannot have independent pressure.
- **`upstream_semaphore` is global**, sized from `PROXY_CONCURRENCY_LIMIT`
  (default `1`). One card-wide gate for every upstream, whatever is resident.

## 3. Decisions taken

From the operator, before drafting:

1. **Surface:** a shared core with two front ends — TUI (`uap models`) and a
   dashboard Models tab. Neither is authoritative; both read the same state.
2. **Trigger:** the proxy admission gate. Every client is covered — Claude
   Code, Codex, OpenCode, UAP agents — because they all enter through
   `:4000/v1`. A gate in the TypeScript router alone would cover only UAP's
   own callers.
3. **Eviction:** prompt first. Never evict without an explicit yes. Auto mode
   may load alongside; it may never displace.
4. **Devices:** multi-device abstraction from the start — GPU0, GPU1, CPU
   offload tier, each with its own budget. Single-GPU is the degenerate case,
   not the model.

Eight more were settled while reviewing this draft. Each one changed the design
rather than just the wording:

5. **Registry location:** repo defaults **merged with** machine-local overrides.
   `config/model-registry.json` is the shipped template; `~/.uap/model-registry.json`
   carries this machine's measured numbers and wins on conflict. The measured
   figures in this spec are machine state, so they cannot live only in the repo.
6. **Enforcement host:** a TypeScript module mounted on the **dashboard server**,
   reached by the proxy over localhost HTTP. Not a new daemon, because the
   lifecycle helper already starts, reference-counts, and hands the proxy
   `UAP_DASHBOARD_URL`.
7. **Alternate configs are not measured now.** Every non-active config ships with
   `status: "unmeasured"` and is refused until `uap models measure` fills it in.
   Measuring them means taking the live backend down.
8. **`paused` means offload and reload from disk later.** It is not the proxy's
   existing KV checkpoint, which saves KV to host RAM and frees no VRAM. §4.5
   states what this machine can actually do about that today.

## 4. Architecture

```
                    ┌──────────────────────────────────────────┐
  client request ──►│ proxy admission gate (anthropic_proxy.py)│
                    │  before _reconcile_wire_model()          │
                    └───────┬──────────────────────────┬───────┘
                            │ resident fits            │ needs a decision
                            ▼                          ▼
                    forward upstream        POST /api/placement/*  (core)
                                                        │
                                    ┌───────────────────┼──────────────────┐
                                    ▼                   ▼                  ▼
                            model registry        placement ledger    enforcement
                            (cost, static)        (live state,        (systemd +
                             fail-closed)         pending requests)    verify)
                                    │                   │                  │
                                    └──── TUI (uap models) + dashboard Models tab
```

The core is a library (`src/placement/`) hosted by the dashboard server, not a
new daemon. Decision 2 in §9 forces this: the proxy calls a loopback control
endpoint, so some process must be alive to answer it, and that process is the
one that owns the ledger. The CLI talks to the same server over loopback HTTP;
when the server is down, `uap models status` reads the ledger file directly and
says so, but `apply` refuses rather than racing a live writer. No new
long-lived process: the dashboard server is already running, and the proxy is
already the only component that sees every request.

### 4.1 Model registry — `config/model-registry.json`

Machine-readable cost per **config**, replacing the prose in profile comments.
Two files, merged. `config/model-registry.json` in the repo carries the shape:
devices, models, config names, advertised ids, task affinity. `~/.uap/model-registry.json`
on the machine carries the measurements, because a footprint is a property of
*this hardware*, not of the repo, and a second box with a different card must
not inherit this box's numbers. The machine-local file overrides per config; a
config that appears only in the repo file is `unmeasured`. `uap models validate`
prints which file each entry came from, so a wrong number is at least
attributable.

Cost is per config, not per model: the same weights cost 21.8 GiB under Strata
with `--kv-resident 32768` and a different amount under a different pack or
context size. The entry below is **measured on this machine**, not estimated:

```json
{
  "version": 1,
  "devices": {
    "gpu0": {
      "kind": "gpu", "name": "NVIDIA GeForce RTX 3090", "total_mib": 24576,
      "reserved_mib": 2048,
      "reserve_reason": "1516 MiB attributed to desktop compute processes (Xorg 1227, Chrome 214, Steam 75) + ~900-1000 MiB of graphics memory that --query-compute-apps does not attribute to any PID; permanent while the desktop is up"
    },
    "cpu0": {
      "kind": "cpu", "total_mib": 126944, "reserved_mib": 8192,
      "reserve_reason": "page cache and the TS side must survive a 52 GiB engine attach"
    }
  },
  "models": {
    "qwen3.8-flash-next": {
      "display": "Qwen3.8 Flash Next",
      "engine": "strata",
      "unit": "uap-strata-server",
      "launch": "/home/cogtek/dev/strata/run-iq3_xxs.sh",
      "endpoint": "http://127.0.0.1:8080",
      "rails": 1,
      "rails_source": "metrics:expert_slots",
      "task_affinity": ["code", "general"],
      "affinity": { "device": ["gpu0"] },
      "configs": {
        "strata-iq3_s": {
          "resident_gpu_mib": 21812,
          "host_rss_mib": 52857,
          "context_pool_cells": 131072,
          "per_session_cap_cells": 114688,
          "kv_resident_cells": 32768,
          "kv_mib_per_1k_cells": 12.2,
          "measured_at": "2026-10-08T14:02:00Z",
          "measured_on": "gpu0",
          "flags": ["--max-context", "131072", "--kv", "int8", "--kv-resident", "32768", "--vram-reserve-mib", "1200"]
        }
      },
      "advertises": ["qwen3.8-flash-next-iq3_s", "gpt-5.1-codex"]
    },
    "qwen3.8-27b": {
      "display": "Qwen3.8 27B",
      "engine": "llama.cpp",
      "unit": "uap-llama-server",
      "profile": "config/llama-profiles/qwen38-27b-mtp.env",
      "endpoint": "http://127.0.0.1:8080",
      "task_affinity": ["code", "general"],
      "affinity": { "device": ["gpu0"] },
      "configs": {
        "llama-mtp": { "status": "unmeasured" },
        "exl3-4bit": { "status": "unmeasured" },
        "gsq-rco": { "status": "unmeasured" }
      }
    }
  }
}
```

The second entry is the honest state of every alternate on this machine: the
units exist, the profiles exist, the VRAM prose exists in the profile comments,
and none of it is machine-readable. They ship as `status: "unmeasured"` and stay
that way until `uap models measure` fills them in, which requires taking the
active backend down.

`resident_gpu_mib` is the whole-config footprint attributed to the **engine's own
PID** (`nvidia-smi --query-compute-apps=pid,used_memory`), taken with the server
idle. It is not weights plus overhead: as §4.1.1 shows, this engine streams
expert weights through an elastic VRAM cache, so there is no honest weights
number to add to an overhead number. Admission cost is the resident figure plus
marginal KV beyond the pool the config already paid for at startup:

```
cost(config, cells) = resident_gpu_mib
                    + max(0, cells - kv_resident_cells) / 1000 × kv_mib_per_1k_cells
```

For the live config, `cells ≤ 32768` costs exactly 21,812 MiB — the KV pool is
already resident. Requesting the full 114,688-cell session cap costs
21,812 + 81,920/1000 × 12.2 ≈ **22,810 MiB**, which exceeds the card. That is
not a rounding error; it is the reason the profile caps sessions at 114,688
against a 131,072 pool and why the pool itself is the constraint the operator
is really trading.

Rules:

- **Unknown cost fails closed.** A config with no `measured_at` is not
  placeable. It may be served if already resident; it may never be loaded, and
  it never enters an eviction candidate set. Guessing a footprint is how a
  24 GiB card gets OOM-killed. `status: "unmeasured"` is the shipped default for
  every config that has not been measured, so the registry can describe the
  machine's full option set without making any claim it has not verified.
- **`measured_on` gates reuse.** A footprint measured on `gpu0` (24 GiB, sm_86)
  is not valid for another device class or a different engine build. A stale or
  mismatched measurement is treated as unknown.
- **Host RAM gates placement too.** `host_rss_mib` is checked against host
  availability alongside `resident_gpu_mib`; §4.1.1 is why.
- **Cross-check against `config/capacity-policy.json`.** `uap models validate`
  fails if a registry entry contradicts the policy it should agree with:
  `metricsMustMatch` (`kv`, `max_context`), the launch flags in
  `execStartMustContain` (`-c 229376`, `-np 2`, `--vbr-vram 5120M`,
  `--cache-ram 32768` for `gsq-rco-server`), and the declared headroom
  (`gpuMinFreeMiB: 200` for `strata-server`). One source of truth per number;
  the registry references the policy, it does not restate it.
- **`rails` is not the model's concurrency claim.** `config/model-profiles/qwen38.json`
  says `concurrency: 1` because Strata exposes one rail, while
  `config/llama-profiles/qwen38-27b-mtp.env` sets `LLAMA_PARALLEL=2`. The
  registry states it per config, cross-checked against a live probe. A mismatch
  is surfaced, never silently resolved — `src/utils/model-slots.ts:13` falls
  back to `DEFAULT_SLOTS = 2` when the probe fails, which is **safe for
  llama.cpp and unsafe for Strata**: handing two concurrent requests to a
  1-rail server is exactly the overflow the profile warns about. Rail discovery
  must become backend-aware before the registry can be trusted to allocate.

**Ownership — the registry must not become a fifth source of truth.** Endpoints
already live in four places: `src/models/types.ts:229` pins the live-backend
alias with a comment explaining why pinning more would "turn a backend switch
into an outage"; `config/model-profiles/`; `config/llama-profiles/`; and
`config/capacity-policy.json`. The registry therefore **references** rather
than restates, and `models validate` fails on a contradiction:

| Number | Owner | Registry holds |
| --- | --- | --- |
| Endpoint the proxy forwards to | proxy env (`LLAMA_CPP_BASE`) | read-only echo for display, never consumed by routing |
| Liveness + budget + metrics identity | `config/capacity-policy.json` (`services` is a **list** keyed by `name` — lookups must not assume a map) | the service `name` it cross-checks against |
| Launch flags per llama profile | `config/llama-profiles/*.env` | the profile path |
| Advertised model ids + session caps | `config/model-profiles/*.json` | cross-check only |
| Measured footprints (`resident_gpu_mib`, `host_rss_mib`, KV geometry) | `~/.uap/model-registry.json` | the only owner |
| Device totals + `reserved_mib` | `~/.uap/model-registry.json` | the only owner |

#### 4.1.1 What measurement actually returns (measured on this host)

The naive recipe — file size for weights, `nvidia-smi` used-minus-weights for
overhead — is wrong on both counts, and the numbers below are why.

Current live config: `strata-iq3_s.json`, engine `strata`, pack `iq3_s`,
`--max-context 131072 --kv int8 --kv-resident 32768 --vram-reserve-mib 1200
--spec 8 --mtp rt --expert-cache auto`.

| Quantity | Measured | Source |
| --- | ---: | --- |
| GPU total | 24,576 MiB | `nvidia-smi` |
| GPU used, engine pid 246788 | 21,812 MiB | `nvidia-smi compute-apps` |
| GPU used, non-backend processes | 290–1,516 MiB, varies by sample | same |
| GPU free | 245–975 MiB, drifting | `nvidia-smi`, `/metrics` |
| Engine host RSS | 52,857 MiB | `ps -o rss` |
| Server (python) RSS | 247 MiB | `ps -o rss` |
| Host RAM used / total | 92 GiB / 121 GiB | `/metrics` |
| GGUF on disk (native + PLE) | 52 GiB + 27 GiB | `ls -lh` |
| MTP draft on disk | 1.1 GiB | `ls -lh` |
| `expert_slots` | 7,736 | `/metrics` |
| `expert_cache_mib` | 15,017 MiB | `/metrics` |
| `arena_mib` | 47,962 MiB | `/metrics` |
| `vram_free_mib` | 917 MiB | `/metrics` |

Four conclusions the registry schema has to absorb:

1. **Disk size is not a proxy for anything.** The GGUFs total 79 GiB; the GPU
   footprint is 21.8 GiB. Expert weights are streamed from disk into a
   15 GiB VRAM cache sized by what is left over (`--expert-cache auto`). So no
   pinned-weights figure can come from `ls`, and none can come from the engine
   either: the pinned/cache split is not derivable from the fields Strata
   reports. The registry therefore stores the whole-config **resident** figure
   and nothing else.
2. **The engine preallocates at startup.** `--vram-reserve-mib 1200` and
   `--expert-cache auto` mean the process claims the card at load time. Free
   VRAM after a load is a leftover, not a budget — which is why "free + what
   the victim frees" is the only meaningful headroom question, and why
   `load_alongside` is effectively unavailable on this host right now.
3. **Host RAM is a first-class constraint, not a footnote.** The engine holds
   52.8 GiB of RSS (mmap'd GGUFs) against 121 GiB total with 92 GiB used. A
   placement decision that fits VRAM and blows the page cache is a bad
   decision. `host_rss_mib` therefore gates placement alongside
   `resident_gpu_mib`: a candidate is admissible on a device only if that
   device's measured host free RAM covers the candidate's RSS. (At measure time
   the model is already resident, so the check belongs to admission, not
   measurement — `measure` records the footprint and the host state it saw.)
4. **The desktop is a permanent tenant, and it is bigger than the floor
   assumes.** Non-backend GPU use measured 290–1,516 MiB across samples: one
   sample showed Xorg 1,227 + Chrome 214 + Steam 75 = 1,516 MiB with 975 MiB
   free; another showed only Warp 206 + nautilus 52 + the Logi overlay 24 +
   snapd-desktop-integration 8 = 290 MiB, with `memory.used` at 23,105 MiB
   against 21,812 + 290 = 22,102 accounted, leaving ~1,003 MiB attributed to no
   PID at all. So `--query-compute-apps` is not a reliable census of GPU
   consumers — Xorg appears in it sometimes and not others. The robust
   quantity is the *unattributed remainder*, and `uap models measure` should
   derive `reserved_mib` as `device.capacity_mib − free − Σ(compute apps that
   are UAP backends)`, which captures graphics memory whether or not it is
   attributed to a PID. Call it 1–1.5 GiB, about 5% of the card, permanently
   unavailable to any backend. `config/capacity-policy.json` sets
   `gpuMinFreeMiB: 200` for `strata-server`, which is why the doctor reports
   GREEN at 245 MiB free: the policy's floor is smaller than the tenant it is
   meant to protect. The placement layer must not inherit that number; it needs
   its own measured per-device `reserved_mib`.

So `uap models measure` records, per *config*: `resident_gpu_mib` and
`host_rss_mib` from the live process, `context_pool_cells` /
`kv_resident_cells` / KV dtype from `/metrics`, and `expert_cache_mib` +
`arena_mib` where the engine reports them. Those last two are diagnostic only:
the admission cost uses the whole-config resident figure, because splitting an
elastic expert cache into "pinned" and "streamed" halves does not make the
decision any safer. Where an engine reports no cache, no split is invented.

`measure` refuses to write a footprint when the reading is not trustworthy:
engine PID not found, `resident_gpu_mib` below a sanity floor, a compute-apps
reading that includes another backend's allocation, or a device whose derived
`reserved_mib` exceeds its own capacity. It records `measured_on`,
`measured_at`, and the host free RAM it saw alongside every number, and
`validate` fails an entry whose measurement predates the unit's current
`ExecStart`.

### 4.2 Placement ledger — `~/.uap/placement.json`

Live state. Written under an advisory lock; every writer re-reads before
committing so a stale view cannot clobber.

```json
{
  "version": 1,
  "updated_at": "2026-10-08T14:02:11Z",
  "devices": {
    "gpu0": { "kind": "gpu", "total_mib": 24576, "free_mib": 1016,
              "reserved_mib": 1293, "source": "nvidia-smi" },
    "gpu1": { "kind": "gpu", "total_mib": 0, "free_mib": 0,
              "headroom_mib": 0, "source": "absent" },
    "cpu0": { "kind": "cpu", "total_mib": 126944, "free_mib": 30424,
              "headroom_mib": 8192, "source": "MemAvailable" }
  },
  "residents": [
    { "model": "qwen3.8-flash-next-iq3_s", "config": "strata-iq3_s",
      "device": "gpu0", "engine": "strata",
      "endpoint": "http://127.0.0.1:8080", "unit": "uap-strata-server",
      "state": "hot", "gpu_mib": 21812, "host_rss_mib": 52857,
      "holders": [], "since": "2026-10-08T09:14:02Z" }
  ],
  "pending": [
    { "id": "plc-7f2a", "requested_model": "qwen3.8-27b", "client": "claude-code",
      "session": "sess-…", "pid": 41122, "created_at": "…", "expires_at": "…",
      "options": [ … ], "reason": "not_resident" }
  ]
}
```

`free_mib` for `gpu0` is what `nvidia-smi` reports right now (1,016 MiB at the
time of writing; observed range 245–1,016 as the engine's expert cache grows
and shrinks), not what would be free after a victim is drained — see §4.4.

Host RAM is a placement constraint in its own right, which is why `cpu0` is a
device and not a footnote. `free -m` on this box: 123.8 GiB total, 89.1 GiB
used, 29.7 GiB available. The Strata engine's RSS is 52.9 GiB (VmPeak 54.4
GiB) because mmap'd GGUF pages count toward RSS, and the expert cache is
15,017 MiB of it. Two consequences:

- A CPU-offload candidate costs host RAM, so `cpu0.free_mib` is the budget and
  `headroom_mib` must stay large enough for the proxy, the dashboard, and page
  cache. Loading a second large model host-side would push this machine into
  swap, which is a worse failure than refusing the request.
- `load_alongside` must check **both** devices. A candidate that fits the GPU
  but not host RAM is infeasible, and the reason string must name the device
  that failed rather than reporting a generic "insufficient memory".

Resident states: `hot` (serving), `warming` (loading, not yet accepting),
`paused` (offloaded, reloadable from disk — see below), `draining` (marked
for removal, refusing new requests, finishing in-flight).

`free_mib` is refreshed on read from `probeGpuFreeMiB()` — never trusted from
the last writer's snapshot. The ledger records intent; the probe records fact.
When they disagree, the probe wins and the disagreement is surfaced.

#### What `paused` is, and what it is not

Per Decision 4 in §9, `paused` means **the config's weights are offloaded and
will be reloaded from disk on resume**. It is not the proxy's existing
save/restore plumbing (`PROXY_SLOT_SAVE_RESTORE`,
`/slots/{id}?action=save|restore`), which is the right mechanism for a
different problem and the wrong answer here:

- A saved slot is a **host-RAM** artifact. It frees no VRAM, so pausing that
  way cannot make room for a model that does not fit.
- The save path is single-threaded and slow: 10–20 s per slot at 128k context.
  A pause that takes longer than a model load is not a pause.
- With 29.3 GiB of host RAM free against a 52.9 GiB resident process, there
  may be no headroom for a checkpoint at all.

So a paused entry records the config's offload location and is resumable by
reloading from disk. No engine on this host has that reload path today: Strata
claims the card at startup (`--expert-cache auto`, `--vram-reserve-mib 1200`)
and has no in-process unload. Until one exists, `paused` is a **display state
the ledger can hold but the executor cannot produce**, and the only executable
option in the preview is `kill`. The preview must label which one it is
offering, because "pause" sounds free and currently is not.

### 4.3 Admission gate — in the proxy

The gate runs **after** the wire model is resolved and **before** anything is
sent upstream. On `/v1/messages` this is exactly `_reconcile_wire_model()`
(`anthropic_proxy.py:1681`, called at `:15036`): a pure rewrite with no side
effects, so calling it first and gating on its result is correct — the gate
sees the same value the upstream will.

But **it is not unbypassable, and an earlier draft claimed it was.**
`_reconcile_wire_model` has exactly one call site, on `/v1/messages`. The proxy
also sends upstream from `/anthropic/v1/messages` (`:15743`),
`/v1/chat/completions` (`:15832`), `/api/chat` (`:16618`), and `/api/generate`
(`:16655`), plus the passthrough client (`_pt_client`, `:14473`) and the
save/restore client (`_sr_client`, `:13823`). So the gate must be a function of
the resolved wire model, not a side effect of one route's rewrite step:

- `/v1/messages` — gate after `_reconcile_wire_model()`. Every named client
  (Claude Code, Codex, OpenCode, UAP agents) enters here; this is the phase-2
  deliverable.
- `/v1/chat/completions`, `/anthropic/v1/messages` — same gate, resolved from
  the body's `model`. Same phase.
- `/api/chat`, `/api/generate` (Ollama-compatible) — same gate; these are
  local-only routes, so a non-resident model here is exactly the case to park.
- Passthrough (`_pt_client`) — exempt by definition: the model is cloud, it
  has no local cost, and it never reaches `:8080`.

The §7 test list includes a test that each non-exempt route, in `mode=ask`,
parks rather than forwards when the requested local model is not resident.
"Gate the choke point" was the right instinct; "the choke point covers
everything" was a false statement about 17k lines and is now corrected.

Decision order:

| Condition | Action |
| --- | --- |
| Resolved model already resident and satisfies the request | forward |
| Cloud preset (no local cost) | forward, no placement decision |
| In registry, fits in free − reserve, `mode=auto` | load alongside, then forward |
| In registry, fits in free − reserve, `mode=ask` | park, ask operator |
| In registry, fits only by displacing | park, ask operator with impact preview |
| Not in registry | park, ask operator; **never auto-load** |
| `mode=off` | current behavior, byte-identical |

Parked requests return `409` with a machine-readable body:

```json
{ "error": { "type": "model_placement_pending",
             "placement_id": "plc-7f2a",
             "requested_model": "qwen3.8-27b",
             "retry_after_ms": 2000,
             "resolve_with": "uap models apply plc-7f2a <option>  |  dashboard Models tab" } }
```

`409` rather than a hang: the client keeps control, the proxy holds no socket
open across an unbounded operator decision, and a client that understands the
code can fall back on its own. `PROXY_PLACEMENT_HOLD_MS` optionally holds the
connection for a bounded window first, for clients too dumb to retry.

Pending requests dedupe on `(client, requested_model)`: ten concurrent Claude
Code requests for the same unloaded model produce one operator prompt, not ten.

Environment: `PROXY_PLACEMENT_MODE=off|ask|auto` (default `off`),
`PROXY_PLACEMENT_HOLD_MS` (default `0`).

#### The proxy cannot load a model today

This is the largest piece of new machinery and the spec should not imply
otherwise. `anthropic_proxy.py` has no subprocess spawn, no systemd call, and
no model lifecycle anywhere in its 17,000 lines. It forwards, and it discovers
what is already listening (`_discover_local_llama_base()` via `ss -ltnp`).
Model switching is a shell script an operator runs by hand.

So enforcement is a new module, `src/placement/enforce.ts`, invoked by the
proxy over a local control socket (or by the CLI/dashboard directly), which:

1. drains victims (§4.5),
2. `systemctl --user stop <victim unit>`,
3. polls `nvidia-smi` until the expected MiB are actually released — with a
   timeout, because a process that lingers holds the card,
4. `systemctl --user start <new unit>` with the profile's flags,
5. polls `/health`, then `/slots`, then `/metrics`, applying the capacity
   policy's `metricsMustMatch` so a server that came up with the wrong KV
   quant or context is caught rather than served,
6. writes the ledger, releases the pending request,
7. on any failure, rolls back: restart the victim unit, mark the request
   failed, and let parked clients fall back.

Steps 2–5 are already what `~/.config/uap/model-switch.sh` does by hand,
including the `Conflicts=` unit graph. The script is the reference
implementation; the module is that script with drain, verification, and
rollback.

**One caveat the earlier draft glossed: those units are machine-local.**
`grep -rn "Conflicts=" config/` returns nothing — the mutually-conflicting
backend units live in `~/.config/systemd/user/`, installed by hand, and the
capacity policy itself records `strata-server` as unit-less. Enforcement
step 4 (`systemctl --user start <new unit>`) depends on units the repo does
not ship. Phase 2 therefore needs tracked unit templates with the `Conflicts=`
edges (extending `src/cli/systemd-services.ts`, which already installs
`uap-anthropic-proxy.service` and `uap-llama-server.service`), or the
registry must record that a unit's provenance is machine-local and
enforcement must refuse configs whose unit it cannot install. Degrading to
raw `systemd kill`/`ExecStart` strings is the failure the risk table already
forbids.

Two things that script does not do, and that the module must:

**Rollback after a failed start is the trust-critical step.** A failed start
that leaves the old unit stopped means the operator has no backend at all. The
module restarts the victim, captures its stderr into the event, and if the
rollback start also fails it stops trying and surfaces the observed state as a
red banner rather than looping. This path must be exercised in tests against a
simulated failed start before `auto` mode is available at all.

**The timeouts have an envelope nobody has measured.** The drain timeout, the
hold ceiling, and the release gate all need numbers, and those numbers depend on
how long this machine actually takes to tear a backend down and bring one up.
The only way to measure that is to perform a switch while watching, which takes
the live backend down and interrupts whatever is using it. So it is sequenced
deliberately: measure the envelope during one planned switch with the operator's
go-ahead, and until then the timeouts are conservative defaults labelled
unvalidated. Publishing a hold ceiling without a measured envelope behind it is
the same mistake as publishing a VRAM cost without a measurement.

**How the proxy finds the controller.** This is new wiring, not reuse — an
earlier draft claimed the lifecycle helper already passes `UAP_DASHBOARD_URL`
to the proxy; that variable exists nowhere in the repo. The proxy reads no
dashboard address today. So: `uap setup` emits `PROXY_PLACEMENT_CONTROLLER`
into `.uap/proxy.env` next to the other `PROXY_*` knobs it already emits, and
the unit file's `EnvironmentFile` picks it up. The value is a loopback URL.
Two constraints from the existing server code (`src/dashboard/server.ts`): the
dashboard may bind port 0 (OS-picked, resolved only after `listen`), and it may
bind `0.0.0.0` for LAN reachability — a placement control endpoint that stops
and starts systemd units must be **loopback-bound regardless of `--host`**,
with `mutationAuthorized(req)` on every write. If the controller URL is unset
or nothing answers it, admission runs read-only: it can answer "already
loaded" from the ledger, but it cannot load anything, so an unloaded request
gets `model_placement_pending` with reason `no_controller`, and
`uap models pending` tells the operator to start the dashboard or act from
the CLI.

#### Concurrency must become per-target

`upstream_semaphore` is one global `asyncio.Semaphore(PROXY_CONCURRENCY_LIMIT)`
(default 1) created at startup. With two models resident, one global limit is
wrong in both directions: a 2-slot llama.cpp server is throttled to 1, and a
1-rail Strata server is allowed 2 and overflows.

Replace it with a per-target semaphore map keyed by the resolved wire model's
target, sized from the registry's `rails` and cross-checked against the live
`/slots` count — the same reconciliation `getModelSlotBudget()` already does
for the TypeScript side. The wire-model decision and the concurrency gate must
read the same target or they will disagree under load.

`model_backpressure` is likewise one row (`CHECK(id = 1)`), so exhaustion on
one endpoint currently suppresses every other endpoint. Key it by target id.
`model_leases` has no target column at all, so a lease taken against one
budget is consumed by a different model's request. Both changes are additive
schema migrations with a default target for existing rows.

### 4.4 Options and cost math

Cost is per **config**, not per model, and it is measured rather than derived
from file sizes. Measured today:

| Config | Disk | GPU (measured) | Host RSS (measured) |
| --- | --- | --- | --- |
| `strata-iq3_s` | 79 GiB (52 native + 27 PLE) | **21,812 MiB** | **52,857 MiB** |
| `strata-ple` | ~52 GiB | not measured | not measured |
| `qwen38-27b-mtp` (llama.cpp) | 15 GiB | not measured | not measured |

Disk size is useless as a cost proxy: the active config puts 79 GiB on disk and
21.8 GiB on the card, while the exl3 config puts 15 GiB on disk and needs more
than 22 GiB on the card. `nvidia-smi --query-compute-apps=pid,used_memory`
against the engine's own PID is the only number that means what the admission
gate needs, and `uap models measure` reads it from there.

The other half of the row is host RAM, and on this machine it is the binding
constraint. The Strata engine's resident set is 52.9 GiB of a 128 GiB host with
30 GiB available — it keeps the 52 GiB native GGUF and the 27 GiB PLE file
mapped. A second config of that shape does not fit on the host even if the card
had room, so `fits_host` is not a formality and the registry must carry
`host_rss_mib` as a measured field with the same fail-closed rule as the GPU
number.

What the measured row corresponds to, from the live unit's `ExecStart`
(`config/strata-configs/strata-iq3_s.json`):

```
--max-context 131072 --kv int8 --kv-resident 32768
--vram-reserve-mib 1200 --expert-cache auto --spec 8 --spec-min-p 0.8
```

`/metrics` reports `expert_cache_mib: 15017` and `expert_slots: 7736` for that
config. So `kv_resident_cells` is 32768, not 131072: the first 32k cells of
context are already inside the 21,812 MiB, and marginal KV only starts accruing
past that. `--vram-reserve-mib 1200` is the engine's own internal floor and
belongs in `reserved_mib` for the device, not in the config's cost.

```
cost_mib(config, cells) = resident_gpu_mib(config)
                        + max(0, cells − kv_resident_cells(config))
                          × kv_mib_per_1k_cells(config) / 1000

fits_gpu   = cost_mib ≤ device.total_mib − Σ(resident_gpu_mib of everything
           staying loaded) − device.reserved_mib
fits_host  = host_rss_mib(config) ≤ cpu0.free_mib − cpu0.reserved_mib
fits       = fits_gpu AND fits_host
```

Three things that formula gets right and the naive version gets wrong:

**The device budget is a sum, not a free-memory reading.** The card is 24,576
MiB. The running engine holds 21,812 MiB and the desktop holds 1,516 MiB of
attributable compute plus roughly another 900 MiB of unattributed graphics
memory. The correct question is "does the set I intend to have loaded fit in
24,576 minus the device's reserved floor minus nothing else", not "does
`nvidia-smi` say there is room".
`probeGpuFreeMiB()` reads `memory.free`, which on this machine reports 245–975
MiB at steady state — a number that is true and useless at the same time,
because it describes what is left after the operator's chosen configuration
already filled the card.

**`free_mib` must exclude the process being displaced.** Reading free memory
while the victim still holds the card reports the opposite of the truth: the
preview would promise room that does not exist until the victim is gone, and
the load would then OOM. Concretely, free is 975 MiB and the victim holds
21,812 MiB, so a displacement that needs 22.5 GiB has 22,787 MiB to work with —
and only after the stop is verified, not before.

**Host RSS is a hard gate, not a footnote.** 52.8 GiB of the machine's 121.7
GiB is held by the running engine, with 29.7 GiB available. A placement that
fits the GPU and OOMs the host is still a failed placement. This is also what
makes `pause` expensive: save/restore moves KV to host RAM, and on this machine
there is not a lot of host RAM to move into.

`resident_gpu_mib` already contains whatever the engine preallocates, so no
separate overhead term is needed for the common case. For the live Strata
config, `/metrics` reports `expert_cache_mib: 15017` and `arena_mib: 47962`
inside the 21,812 MiB resident total; those are reported for diagnosis only and
never enter the decision. The marginal KV term matters only when a request asks
for more context than the measured pool (`--max-context 131072` with
`--kv-resident 32768` today); below that, the pool is already paid for.

`reserve_mib` is the operator's placement reserve, declared in the placement
config, and it is a different number from the capacity policy's
`gpuMinFreeMiB`. The policy's `200` for `strata-server` is a doctor floor
deliberately set low, because that service fills the card by design and the
measured steady state with the desktop sharing the GPU is ~245 MiB free; a
600 MiB floor would hold the doctor permanently RED at the operator's chosen
operating point and train everyone to ignore it. The placement reserve is the
opposite question — how much to keep back so the *next* model can load — and
on a 24 GiB card it has to be stated explicitly or it is silently zero.

On today's machine the arithmetic is blunt: 24,576 total, 21,812 held by one
config, ~290 by the desktop, and every alternate config in the registry needs
22–25 GiB. `load_alongside` has no solutions. Displacement is the only option,
and that is the correct output, not a bug — it is the same conclusion the
`Conflicts=` graph already encodes, now stated in MiB instead of unit names.

Generated options, in ranking order:

1. **reuse** — a resident model already satisfies the request.
2. **load_alongside** — fits on a device with room; nothing is displaced.
3. **displace** — minimal eviction set that makes room, smallest first.

Ranking: reuse > load_alongside with matching `task_affinity` > load_alongside
> smallest displacement > largest displacement. The operator always sees the
full list; the ranking only sets default order and the recommended row.

### 4.5 Impact preview

Every `displace` option carries the victim list. This is the answer to "what
will be killed or paused", and it is computed **before** the operator commits.

| Victim state | In flight | Consequence |
| --- | --- | --- |
| `hot` | yes | active generation aborted; context lost |
| `hot` | no | session idle, context lost, reload needed |
| `warming` | — | load wasted; VRAM returns on stop |
| `paused` | — | already offloaded; restore path lost |

Per victim: model, state, device, holders (client, pid, job, turns, context
cells), in-flight flag, cost it frees, and estimated reload cost for the
displaced model.

Two sources exist and neither alone answers "who is using this model":

- `model_leases` (`src/coordination/database.ts`) has a `holder` column, but
  `activeModelLeases()` (`src/coordination/service.ts:1061`) returns only a
  count, and the holder is a lease-holder string (`model:<apiModel>`,
  `agentic:<apiModel>`), not a client identity.
- The proxy holds the live request state, but it is **not exposed**. An
  earlier draft named a `_client_registry` served at `/v1/api/clients` —
  neither exists. The real primitives are `_current_request_session`
  (contextvar, `:4853`), the in-flight counters hung on the httpx client
  (`_inflight_inc`/`_inflight_dec`, `:4628-4637`), session admission state
  (`_admitted_sessions`, `:4920`), and client identity
  (`resolve_client_id` + `_client_request_times`, `:2011-2053`). None has a
  route.

So the preview needs a **new proxy endpoint** — in-flight work per target
(client id, session, request id, started-at) — as an explicit phase-2
deliverable, not a join of two existing registries. Until it exists, the
holder column of the preview says `unknown (lease holder only)` and the
operator approves displacement knowing the model but not the victim. That is
an honest v1 limitation, and the preview must display it rather than paper
over it. The lease side still needs a target column (§4.3) before it can
attribute a holder to a specific resident model.

Nothing in this view is advisory-only: the enforcement step re-derives the
same list and **refuses to proceed if it differs** from what the operator
approved. A preview that lies is worse than no preview.

### 4.6 Enforcement

Only after an explicit operator yes. The sequence is §4.3's module, with the
failure modes the repo has already recorded:

1. Mark victims `draining`; refuse new requests to them.
2. Wait `drain_ms` for in-flight work to finish. Do not cut it off silently.
3. Stop the victim unit (`systemctl --user stop`).
4. **Verify the VRAM actually came back.** `qwen38-27b-dflash2.env:50-56`
   documents the failure mode: a server started outside systemd was observed
   leaving an orphaned `llama-server` holding 21362 MiB with no listening
   socket, starving the real service on load. Check
   `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` for an
   orphan before concluding the load failed for capacity reasons.
5. Start the new unit with the profile's flags.
6. Poll `/health`, then `/slots` and `/metrics`, applying `metricsMustMatch`.
   A server that comes up with the wrong `kv` kind or pool size is RED, not
   up — that is the existing `execStartMustContain` doctrine applied to a
   service with no `ExecStart`.
7. **Invalidate the proxy's cached view of the upstream, then** update the
   ledger; release the pending request; the client retries and is served.
   `_upstream_model_ids_cached()` (`:1648`) caches the upstream's advertised
   ids **for the process lifetime** ("fetched at most once per process"), and
   `_upstream_model_name()` (`:1724`) reads the same cache. Skip this and the
   first request after a successful switch fails the `requested in ids`
   check and gets silently rewritten to the *previous* backend's first id —
   no banner, wrong model. The invalidation must also cover the `/props` and
   `/slots` snapshots, `_admitted_sessions` (`:4920`), and the pooled
   connections pointed at the old process. This is a step in the sequence and
   a row in the §7 test list, not an implementation detail.
8. Any step fails → roll back to the previous resident set and return a
   fallback to the client rather than leaving the machine with nothing loaded.

Step 8 is the one that decides whether this feature is trustworthy. A partial
enforcement leaves the machine with no model loaded and every agent pointed at
`:4000`. The rollback must be exercised in tests against a simulated failed
start, not only in the success path.

**The enforcement envelope is unmeasured, and it needs to be.** The pending-hold
timeout and the drain timeout in step 3 are constants in every draft so far.
They should come from a measured teardown/start envelope per config: how long
`systemctl --user stop <unit>` takes, whether VRAM release can be confirmed by
re-probing the engine PID rather than trusting unit state, and how long the
alternate profile takes to reach `/health` warm versus cold. Measuring this
means briefly taking the live backend down, so it needs the operator's explicit
go-ahead; it is the first thing to do once they are ready to touch a running
model.

### 4.7 Surfaces

Namespace note: `uap models` (plural, placement) sits next to the existing
`uap model` (singular, multi-model routing at `src/bin/cli.ts:2035`) — a
near-homonym, kept because they answer different questions (where does it
live vs which model answers). Help text for both cross-references the other.

**TUI** — `uap models`:

```
uap models status                 residents, devices, free/headroom, holders
uap models pending                parked requests with ranked options
uap models apply <id> <option>    explicit yes; prints the impact list first
uap models dismiss <id>           refuse; client gets a clean fallback
uap models load <model> [--device]      operator-initiated, same gate
uap models unload <model>               operator-initiated, same preview
uap models measure <model>              populate measured footprints
uap models validate               registry ↔ capacity-policy cross-check
```

**Dashboard** — replace the Models tab stub. `web/dash/tab-models.js` prints
"Models — coming soon"; `web/dash/tabs.js:494` registers a `models` tab that
renders cost and routing only. Neither shows placement. New routes on the
existing server:

```
GET  /api/placement/state     GET  /api/placement/pending    GET  /api/placement/preview
POST /api/placement/resolve   POST /api/placement/dismiss
POST /api/placement/load      POST /api/placement/unload
```

Reads are open, like other dashboard reads. Writes go through
`mutationAuthorized(req)`, the same gate as `/api/policy/*/toggle`. Push uses
the existing event stream; it needs a new category (`placement`) alongside
`policy`, `memory`, `deploy`, `agent`, `task`, `skill`, `pattern`, `cost`,
`system`.

Both surfaces call the same `src/placement/` functions. A decision made in the
TUI appears in the dashboard on the next event, and vice versa.

## 5. What this forces us to fix

Not optional extras — the design does not work without them.

1. **Per-target leases and backpressure.** `model_backpressure` is one row, so
   two residents share one adaptive limit; a struggling model would throttle a
   healthy one. Key `model_leases` and `model_backpressure` by target id,
   keeping the single-transaction reap → count → insert that makes
   `acquireModelSlot()` safe today.
2. **Per-target upstream semaphores.** `upstream_semaphore` is one global gate
   sized from `PROXY_CONCURRENCY_LIMIT`. With two residents it lets traffic
   aimed at model A queue behind model B. The wire-model decision and the
   concurrency gate must not diverge — `qwen38-27b-mtp.env` already warns to
   keep `PROXY_CONCURRENCY_LIMIT` equal to the slot count and
   `PROXY_CONTEXT_WINDOW` equal to per-slot context.
3. **Backend-aware rail discovery.** `getModelSlotBudget()` falls back to
   `DEFAULT_SLOTS = 2` when a probe errors. On a single-rail backend that is a
   silent lie: it advertises two slots to a card that has one. A live server
   answering 404/405/501 at `/slots` is already treated as single-rail; an
   unreachable or unrecognized backend must not default to 2.
4. **Multi-GPU probing.** `probeGpuFreeMiB()` reads GPU 0 only. The
   multi-device abstraction needs per-UUID readings.

### 5.1 The lease migration, concretely

Item 1 is the only change here that touches live state, so it gets its own
sketch. Today (`src/coordination/service.ts:1050-1088`):

```ts
acquireModelSlot(holder: string, budget: number, ttlMs = 120_000): number | null {
  const txn = this.db.transaction((): number | null => {
    const nowIso = new Date(Date.now()).toISOString();
    // DELETE first so the transaction takes the write lock before counting.
    this.db.prepare(`DELETE FROM model_leases WHERE expires_at < ?`).run(nowIso);
    const c = (this.db.prepare(`SELECT COUNT(*) as c FROM model_leases`).get() as { c: number }).c;
    if (c >= Math.max(1, budget)) return null;
    const info = this.db
      .prepare(`INSERT INTO model_leases (holder, acquired_at, expires_at) VALUES (?, ?, ?)`)
      .run(holder, nowIso, new Date(Date.now() + ttlMs).toISOString());
    return Number(info.lastInsertRowid);
  });
  return txn();
}
```

The safety property is the ordering: delete, then count, then insert, inside
one transaction, so the write lock is held before the count is read. Any
target-keyed version must preserve that ordering. The change is a `target`
column and a `WHERE target = ?` on the count:

```sql
ALTER TABLE model_leases ADD COLUMN target TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_model_leases_target ON model_leases(target, expires_at);
```

`model_backpressure` drops its `CHECK(id = 1)` constraint in favour of a
primary key on the target id. SQLite cannot drop a table constraint in place,
so this is the standard create-new-table → copy → drop → rename, inside one
transaction. Map the legacy `id = 1` row to `target = 'default'` in the copy so
a revert of the code loses no operator-tuned state — that keeps the one-way
door reversible in code only.

Three rules keep this from breaking anything:

- **`target = 'default'` is the legacy bucket.** Existing rows and existing
  callers that do not pass a target land there, so behaviour is unchanged
  until a caller opts in by naming a target. The migration is additive.
- **`target` is the placement target identity (device + endpoint from the
  ledger), never the model name.** The existing holder strings already embed
  the model id (`model:<apiModel>`, `agentic:<apiModel>` — see
  `src/models/openai-compat-client.ts:260` and
  `src/delivery/agentic-executor.ts:2569`). Keying `target` on `apiModel`
  would make a backend switch change the key mid-flight: outstanding leases
  orphan, and per-target backpressure resets — the exact hazard
  `src/models/types.ts:229` documents for pinned endpoints. The ledger's
  target id is stable across model changes on the same endpoint.
- **`acquireModelSlot` keeps its current signature** with `target` as an
  optional trailing argument. The only direct TS caller is
  `src/utils/model-slot-lease.ts:94` (an earlier draft also listed
  `src/cli/coord.ts` — it does not call it); the real consumers all go through
  `withModelSlot()` at `src/models/openai-compat-client.ts:260` and
  `src/delivery/agentic-executor.ts:2569`. None of them changes in the same
  commit that adds the column.

**The migration needs an idempotence guard this database does not have.**
`src/coordination/database.ts` contains only `CREATE TABLE IF NOT EXISTS` — no
`ALTER TABLE`, no `PRAGMA user_version`, no version marker at all, so an
unguarded `ALTER` next to the creates throws on the second open. The precedent
to follow is `src/memory/short-term/schema.ts:23` — probe
`PRAGMA table_info(model_leases)`, add the column only if `target` is absent,
and guard the `model_backpressure` rebuild on its actual column shape. The
backpressure rebuild copies the same create-new-table → copy → drop → rename
shape that file's comment describes verbatim ("SQLite doesn't support ALTER
TABLE to change CHECK constraints, so we must rebuild the table").

## 6. Phasing

| Phase | Ships | Proxy mode |
| --- | --- | --- |
| 0 | registry, `models validate`, `models measure` | `off` |
| 1 | ledger, `models status`, `models pending`, cost math, preview | `off` |
| 2 | proxy gate, `409` pending, dashboard state/pending, Models tab | `ask` |
| 3 | enforcement: drain, stop, verify-free, start, verify-metrics, rollback | `ask` |
| 4 | affinity-driven auto-load alongside; never displacement | `auto` |

Phase 0 is useful on its own: it turns the prose in five profile files into
data `uap doctor` can act on. Nothing gates on the rest.

Two ordering constraints, plus one refactor the review forced us to schedule:

- **Item 3 (backend-aware rail discovery) lands in phase 0, not later.** The
  registry's `rails` field is only trustworthy if the probe that fills it
  distinguishes "single rail" from "probe failed". Fixing the fallback after
  building on top of it means re-measuring every entry.
- **Item 1 (target-keyed leases and backpressure) lands between phases 1 and
  2.** The ledger can be built against today's single-row backpressure, but
  the proxy gate cannot: a gate that admits per-target while the lease budget
  and the upstream semaphore are global will admit more traffic than the
  resident model can serve. Phase 2 does not open until the lease table
  carries a target column and the semaphore map is keyed the same way.
- **Phase 1.5: per-target upstream addressing in the proxy.** A per-target
  semaphore on top of a single upstream address is decorative: `LLAMA_CPP_BASE`
  is one module constant with 35 references, including every derived probe
  (`.replace("/v1", "/props")` at `:3403`/`:16452`, `/slots` at `:3470`/
  `:3529`/`:4926`/`:15073`, `/health` at `:5210`/`:16722`), CLOSE-WAIT
  accounting (`_upstream_port()`, `:4580`), and the streaming retry loops
  (`:15065-15700`). The enabler is a resolved target object
  `{target_id, base_url, slots_url, props_url, health_url}` threaded through
  the send paths, with `LLAMA_CPP_BASE` as the default target so single-backend
  behavior is unchanged. It is the riskiest refactor in a 17k-line file; it
  gets its own branch, its own review, and lands before the phase-2 gate —
  otherwise phases 3–4 admit per-target placement the proxy cannot address.
- **Tracked unit templates are a phase-2 prerequisite** (see §4.3's caveat):
  enforcement can only `systemctl --user start` units that exist, and today
  the `Conflicts=` graph lives only in `~/.config/systemd/user/`.

Implementation runs in `.worktrees/345-model-placement/` on
`feature/345-model-placement`, per the worktree gate.

## 7. Tests

- Cost math: boundary at exactly `free − headroom`; unknown footprint fails
  closed; `kv_per_1k` scaling.
- Preview: minimal eviction set selection; victim list matches enforcement
  (a mismatch must abort).
- Registry: schema validation; disagreement with `capacity-policy.json` fails.
- Ledger: concurrent writers, pending expiry, dead-PID holder pruning.
- Proxy gate: `409` shape, dedupe per `(client, model)`, **`mode=off`
  produces byte-identical behavior to today** — the regression that matters
  most, because the proxy serves every client — and, per §4.3's route list,
  **each non-exempt entry route parks in `mode=ask`** when the requested
  local model is not resident (`/v1/chat/completions`, `/api/chat`,
  `/api/generate`, `/anthropic/v1/messages`), while passthrough stays exempt.
- Enforcement: after a successful swap the proxy's upstream id cache is
  invalidated — the next request must not be rewritten to the previous
  backend's id (§4.6 step 7).
- Dashboard: writes require `mutationAuthorized()`; reads do not.
- Existing suites must stay green: `test/models/lease-heartbeat.test.ts`,
  `test/models/openai-compat-lease.test.ts`,
  `test/coordination/adaptive-backpressure.test.ts`,
  `test/coordination/model-slot-lease.test.ts`.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Footprint drift: measured cost stops matching reality | `models measure` re-measures; `doctor` compares resident actual vs declared and flags drift |
| Orphaned VRAM after a failed stop | query compute-apps for orphans before diagnosing capacity; documented in the profile since 2026-08-20 |
| Operator absent, requests park forever | `expires_at` on every pending request; expiry returns a clean fallback to the client |
| Two controllers race on the ledger | advisory lock + re-read-before-commit; enforcement re-derives the victim set |
| A monitor watchdog fights enforcement | the units already declare `Conflicts=`; enforcement uses `systemctl --user`, never raw signals |
| Preview and enforcement disagree | enforcement aborts rather than acting on a stale preview |
| A backend with no systemd unit cannot be displaced | the capacity policy probes `strata-server` over HTTP precisely because the repo ships no unit for it; enforcement treats "no unit" as a distinct state, never as zero cost, and phase 2 ships tracked unit templates (§4.3) |
| Auto mode displaces something important | `auto_load.displace: false` is the default and the only supported value in phase 4 |

## 9. Decisions taken

These were open in earlier drafts and are now settled.

1. **Registry location: repo defaults merged with machine-local overrides.**
   `config/model-registry.json` holds the model names, engines, units, launch
   scripts, rails, and context geometry — everything reviewable and mostly
   machine-independent. `~/.uap/model-registry.json` holds the measured numbers
   for this machine: device totals, `reserved_mib`, and each config's
   `resident_gpu_mib` / `host_rss_mib`. The loader deep-merges the local file
   over the repo file per model and per device, and `uap models validate`
   reports which file each field in each entry came from, so a stale machine
   number is never mistaken for a reviewed default. A machine with no local
   file has no measured footprints, which means everything fails closed — the
   correct outcome for an unmeasured box.
2. **Enforcement lives on the TS side, invoked by the proxy over loopback
   HTTP.** The proxy is Python and has no systemd machinery; the TS side already
   owns the units, the capacity policy, the lease ledger, and the dashboard.
   The proxy calls a loopback control endpoint exposed by the dashboard server
   (`src/dashboard/server.ts` already runs an HTTP server with mutation
   authorization) rather than by a new daemon, so there is one process holding
   placement state and the TUI and dashboard read the same one. The drain
   therefore reaches the proxy's live request state through an endpoint, not
   in-process.
3. **Alternate configs stay unknown and fail closed.** Only the running config
   has a measured footprint. The other seven backends keep `cost: null` until
   the operator runs `uap models measure` against a live instance of each,
   which means they appear in the UI as "not measured" rather than as loadable
   options. Deliberately not measuring them now: measuring requires starting
   each one, which takes the live backend down.
4. **`paused` means offload and reload from disk later.** It is not the proxy's
   existing save/restore mechanism, which checkpoints one slot's KV to host RAM
   and keeps the slot — it frees no VRAM, is opt-in, gated on single-session
   use, and with 29.3 GiB of host RAM available against a 52.9 GiB resident
   process may not have headroom for a checkpoint at all. A paused config is
   recorded with its offload location and is resumable by reloading from disk.
   Until that reload path exists for a given engine, `paused` is display-only
   for that config and the only executable option is `kill`.

## 10. Open questions

1. **Video and image models.** They are the trigger the operator described but
   they are not LLMs and have a different cost shape. Do they get a separate
   placement lane in v1, or does the registry stay LLM-only?
2. **Whose consent for someone else's eviction.** The operator confirms. Does
   the client whose live generation is being aborted also get a say, or is the
   operator's yes sufficient? v1 assumes the latter.
3. **Cloud models as placement options.** They cost nothing locally, so they
   pass through. Should they appear in the ranked list as a fallback when
   nothing fits locally?
4. **The enforcement time envelope.** The drain timeout and the pending-hold
   timeout are constants in every draft so far. They need a measured teardown
   and start envelope per config: how long stopping each unit takes, whether
   VRAM release can be confirmed by re-probing the engine PID rather than
   trusting unit state, and how long the alternate profile takes to reach
   `/health` warm versus cold. Measuring it takes the live backend down, so it
   needs the operator's explicit go-ahead.
5. **Is host RSS a hard gate or a warning?** It is the binding constraint on
   this machine (92.4 GiB of 121.7 GiB used), but the number is dominated by
   mmap'd weights and page cache, so a naive threshold risks false alarms.
6. **How `paused` reload actually works per engine.** Strata's `--vram-elastic`
   and `POST /v1/vram` adjust the arena between requests, which is a different
   lever from offloading a whole config to disk and bringing it back. Which
   engines can do the latter at all, and what it costs, is unmeasured.
