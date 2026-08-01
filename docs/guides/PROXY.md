# The Inference Proxy

UAP ships a local **inference proxy** — an Anthropic-Messages-compatible gateway
that sits in front of a local llama.cpp/Qwen backend, translates between the
Anthropic wire format and llama's OpenAI-compatible API, and applies a layer of
**reliability guardrails** on the way through. It's what lets a Claude-native
harness (Claude Code, Factory, …) drive a local model, and it's where most of
the "keep a small model from wedging" logic lives.

> Code: [`tools/agents/scripts/anthropic_proxy.py`](../../tools/agents/scripts/anthropic_proxy.py)
> (the server), `tools/agents/scripts/confidence_escalation.py` (serving
> recipes), and `src/cli/proxy.ts` / `src/cli/proxy-lifecycle.ts` (lifecycle).
> Related: [Local Models](LOCAL_MODELS.md) · [Configuration Reference](../reference/CONFIGURATION_REFERENCE.md).

---

## What it does

- **Protocol translation** — accepts Anthropic `POST /v1/messages` and forwards
  OpenAI-style requests to the local rail (`LLAMA_CPP_BASE`, e.g.
  `http://localhost:8080/v1`), streaming and tool-calls included.
- **Reliability guardrails** — detects and breaks the failure modes a small
  local model falls into (act/review loops, "I'm stuck" spirals, endless
  exploration with no deliverable) so a run terminates instead of burning turns.
- **Context management** — scales token counts so the client compacts *before*
  the local rail overflows, and prunes as a backstop.
- **Graceful degradation under load** — pool saturation returns a proper
  Anthropic `529 overloaded_error` with `retry-after` rather than failing hard.
- **Serving recipes** — optional confidence/fusion escalation to a stronger
  judge model, plus per-request routing from the reactor and the self-tuning
  real-time adaptor.

### Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/messages` (+ `/anthropic/v1/messages`) | Main Anthropic Messages endpoint (local model + guardrails) |
| `POST /v1/messages/count_tokens` | Token counting, scaled so the client compacts before the local rail overflows |
| `POST /v1/chat/completions` | OpenAI-compatible surface |
| `GET /v1/models` | Model list (honors the `__local_only__` passthrough sentinel) |
| `GET /health` | Liveness (probes the upstream; stays unauthenticated) |
| `GET /v1/context` | Per-session token-usage / utilization / guardrail telemetry (dashboards & debug) |

---

## Lifecycle: `uap proxy`

The proxy is **reference-counted and session-scoped**. Hooks call `ensure` when a
session starts and `release` when it ends, so it starts on demand and stops when
the last session leaves — but it **never** kills a proxy that systemd manages or
that other sessions are still using.

```
uap proxy [ensure | release | status | start | stop | restart | enable | disable | dashboard [on|off]]
```

| Subcommand | What it does |
|---|---|
| `ensure` | Start the proxy if none is running, or **adopt** a running one; register this session as a client; start-or-adopt the dashboard |
| `release` | Deregister this session; stop the proxy (and dashboard) **only if** we spawned it as a plain process and no other client remains |
| `status` | Report whether the proxy and dashboard are running, how (systemd vs spawned), ports, URL, and client count (`--json` for machine-readable) |
| `start` / `stop` / `restart` | Explicit control (e.g. `restart` after changing `PROXY_*` in `.uap/proxy.env`) |
| `enable` / `disable` | Toggle `.uap.json` `proxy.autostart` so hooks auto-start it (or not) |
| `dashboard [on\|off]` | Show or toggle the ride-along dashboard (`.uap.json` `proxy.dashboard`) |

| Flag | Purpose |
|---|---|
| `--client <id>` | Client/session id (defaults to the session env or parent pid) |
| `--client-pid <n>` | Long-lived agent pid for liveness (hooks pass `$PPID`) |
| `--port <n>` | Proxy port (default `4000` / `$PROXY_PORT`) |
| `--if-enabled` | No-op unless `.uap.json` `proxy.autostart` is `true` (hook-safe) |
| `--no-dashboard` | Don't *start* the ride-along dashboard on this `ensure`/`start` (teardown still reaps a dashboard we own) |
| `--quiet` / `--json` | Suppress output (hooks) / machine-readable status |

### Ride-along dashboard

**The operational dashboard starts with the proxy** — no second command. `ensure`
and `start` also start-or-adopt `uap dashboard serve` (default
<http://localhost:3847>), concurrently with the proxy so session start isn't
serialized behind two health waits. Teardown follows ownership: a dashboard **we**
spawned stops when the last client leaves (`release`) or immediately on an
explicit `stop`; one you started yourself is adopted and **never** stopped. If a
foreign process holds the port, UAP declines to spawn (fast, no stall) and tells
you to run `uap dash serve` manually.

| Setting | Where | Default |
|---|---|---|
| enabled | `.uap.json` `proxy.dashboard` (bool or `{enabled, port, host}`) / `UAP_PROXY_DASHBOARD=0\|1` | on |
| port | `proxy.dashboard.port` / `UAP_DASH_PORT` | `3847` |
| host | `proxy.dashboard.host` / `UAP_DASH_HOST` | `localhost` |
| startup wait | `UAP_DASH_HEALTH_WAIT_MS` | `10000` |

Env wins over config. These govern the **ride-along** only — `uap dash serve`
still takes its own `--port`/`--host`.

**Identification.** Liveness is `GET /health`, which returns
`{"ok":true,"service":"uap-dashboard","port":…,"root":"<project dir>"}`. UAP adopts
a dashboard only when that marker is present *and* `root` matches the current
project — a dashboard is per-project (every panel reads its own working
directory), even though the proxy client registry is per-user. A dashboard from an
older UAP has no `/health`; it is recognised by its `UAP Dashboard` page title and
adopted as-is, since it cannot state which project it serves.

```bash
uap proxy dashboard          # is it on, and where?
uap proxy dashboard off      # opt this project out
uap proxy start --no-dashboard
```

**Security note.** Because the dashboard is now up for the whole session rather
than only while you run it by hand, the page carrying the policy-mutation token is
served same-origin only, WebSocket upgrades require a same-origin `Origin`, and the
token is not echoed into the ride-along log. Binding beyond loopback
(`UAP_DASH_HOST`) is reported with a warning — set `UAP_DASHBOARD_TOKEN` if you do.

**How it's managed.** When available, the proxy runs as the systemd unit
`uap-anthropic-proxy.service`, reading its environment from
`~/.config/uap/anthropic-proxy.env`; a plain spawned proxy seeds the same file
for parity. The proxy also loads project-local `.uap/proxy.env` at startup
(real environment always wins). That search walks up from the working
directory and **stops at the repository root**, so a checkout nested inside an
unrelated checkout no longer inherits the outer repo's `PROXY_AUTH_TOKEN`; a
git *worktree* is the same repository, so its `.git` pointer is followed back
to the main checkout rather than terminating the search. If nothing is found
under the repo, `$XDG_CONFIG_HOME/uap/proxy.env` and `~/.uap/proxy.env` are
tried, matching the client-side resolver. The proxy logs which file it loaded
(or that it found none) plus its auth state at startup, so a discovery miss is
visible rather than silently degrading to defaults.

| Env (default) | Behavior |
|---|---|
| `UAP_PROXY_ENV_FILE` (unset) | Explicit path to a proxy.env, tried before the walk |
| `UAP_PROXY_ENV_AUTOLOAD` (**on**) | Set to `0` to make *importing* the proxy module inert — it then mutates no process environment. Used by the Python test suite so tests assert shipped defaults rather than the developer's config. Does not affect a server run |
| `PROXY_ALLOW_UNAUTHENTICATED_BIND` (**off**) | The proxy **refuses to start** on a non-loopback `PROXY_HOST` when `PROXY_AUTH_TOKEN` is empty, because the auth middleware treats an empty token as "no auth configured" and would leave every route open on the LAN. Set to `1` only if an open listener is genuinely intended |

PID reuse is defended with a `/proc/<pid>`
start-time token so `release` never kills an unrelated process that inherited an
old pid. Everything hook-driven **fails open** — if the proxy won't start, the
agent just runs without it.

```bash
uap proxy status --json
uap proxy restart          # pick up new PROXY_* values from .uap/proxy.env
uap proxy enable           # let session hooks autostart it
```

---

## Security

- **Loopback by default.** The proxy binds `127.0.0.1` (`PROXY_HOST`). This is
  deliberate: an unauthenticated `0.0.0.0` listener would let any host on your
  LAN drive the local model — and reach any cloud passthrough — so local-only is
  the safe default.
- **Shared-secret auth for LAN exposure.** To run it as a shared service, set
  `PROXY_HOST=0.0.0.0` **and** a `PROXY_AUTH_TOKEN`. With a token set, every model
  route requires `Authorization: Bearer <token>` (or `X-Uap-Proxy-Token`), checked
  in constant time; `/health` stays open. Never expose it beyond loopback without
  a token.
- **Passthrough credentials.** For requests routed to the cloud, the proxy
  forwards the client's OAuth `Authorization: Bearer` verbatim and does not also
  attach an `x-api-key` (Anthropic rejects both).

---

## Reliability guardrails

These are the heart of the proxy — the logic that keeps a weaker model from
wedging. Most are **on by default** and tuned via `PROXY_*` env vars (persisted
in `.uap/proxy.env` or the systemd EnvironmentFile). The high-signal knobs are in
the [Configuration Reference](../reference/CONFIGURATION_REFERENCE.md); the full
set is below.

### Termination breakers (on by default)

| Guardrail | Env (default) | Behavior |
|---|---|---|
| **Loop-breaker** | `PROXY_LOOP_BREAKER` (on) | Detects act/review cycles + no-progress streaks and releases `tool_choice` to `auto` so the model can actually terminate |
| **Stuck-break** | `PROXY_STUCK_BREAK` (on) | When the model self-reports "stuck in a loop" or hammers a rate-limited host, forces a terminal turn |
| **Deferral-break** | `PROXY_DEFERRAL_BREAK` (on) | The inverse: a no-tool turn that *defers* work ("I need more exploration cycles") is forced to act on the next turn |
| **Recon-convergence** | `PROXY_RECON_CONVERGENCE_THRESHOLD` (40) | After N tool-using turns with **no** write/deliverable, inject "stop exploring, produce the deliverable"; escalates to stripping tools if it persists (0 disables) |
| **Hard-finalize** | `PROXY_HARD_FINALIZE_TURNS` (40) | Absolute turn cap before a forced finalize |
| **MANDATE-DELIVER** | `PROXY_MANDATE_DELIVER` (on) | On the delivery-enforcer block marker, pin `tool_choice` to `deliver` so the next turn *must* route through the gated path — makes routing binding for weak models |

### Context & compaction

| Env (default) | Behavior |
|---|---|
| `PROXY_CONTEXT_WINDOW` (0 = auto) | Explicit local context window; 0 derives it from the live rail |
| `PROXY_COUNT_TOKENS_SCALE` (auto) | Scales the reported token count so the client auto-compacts before the local rail overflows |
| `PROXY_CONTEXT_PRUNE_THRESHOLD` (0.85) / `PROXY_CONTEXT_PRUNE_TARGET_FRACTION` (0.50) | Backstop pruning: prune at 85% of the window, land the session at ~50% |

### Connection health & backpressure

| Env (default) | Behavior |
|---|---|
| `PROXY_MAX_CONNECTIONS` (20) | httpx pool size; a large pool + 529 backoff absorbs connection churn gracefully |
| `PROXY_UPSTREAM_RETRY_MAX` (3) / `PROXY_UPSTREAM_RETRY_DELAY_SECS` (5) | Transient-failure retry budget for upstream calls, on both the buffered and the streaming path. Values below 1 are clamped to 1 |
| **503 "Loading model"** (no toggle) | llama-server answers 503 while a GGUF is still being mapped. Both paths treat it as transient: wait for `/health` (up to 60s), then retry. A wait that times out surfaces the 503 rather than stacking another — so a cold start costs at most ~60s of extra latency per attempt, not `RETRY_MAX × 60s` of dead air |
| **529 backpressure** (no toggle) | A pool timeout returns HTTP **529 `overloaded_error`** with `retry-after` — pure graceful degradation, not a hard failure |
| `PROXY_CLOSEWAIT_REAP_INTERVAL` (0 = **off**) | Opt-in CLOSE-WAIT reaper (pool self-heal); off by default because pool-swap churn can harm a saturated upstream |
| `PROXY_TOOL_NARROWING` (**off**) | Opt-in: drop cycling/banned tools from the set on loops — always keeps the Bash/WebFetch/Agent escape hatch + write tools (a floor invariant that never strands the agent) |

> **Off-by-default knobs to know:** `PROXY_TOOL_NARROWING`, the CLOSE-WAIT reaper
> (`PROXY_CLOSEWAIT_REAP_INTERVAL=0`), `PROXY_POOL_SWAP_ON_SATURATION`, and the
> serving recipes (`PROXY_CONFIDENCE_ESCALATE`). Everything else above is on.

---

## Serving recipes & escalation

The proxy can run a bounded **micro-agent recipe** in front of the local model —
escalating low-confidence or hard turns to a stronger **judge** model — behind
the same single model API. It is **off by default and fails open**.

| Env (default) | Meaning |
|---|---|
| `PROXY_CONFIDENCE_ESCALATE` (off) | Master switch for serving recipes |
| `PROXY_RECIPE` (auto) | `single \| confidence \| fusion` (+ `ratings \| remom`); `auto` routes by signal |
| `PROXY_CONFIDENCE_THRESHOLD` (0.5) | Below this confidence, escalate the turn to the judge |
| `PROXY_FUSION_N` (3) | Candidates the fusion recipe samples before the judge picks/merges (2–6) |
| `PROXY_ESCALATE_MODEL` / `PROXY_ESCALATE_ENDPOINT` / `PROXY_ESCALATE_API_KEY` | The stronger judge backend |

A judge-dependent recipe requires a judge **distinct from** the primary model —
a same-model "qwen judging qwen" setup downgrades to `single` unless
`PROXY_ALLOW_SELF_JUDGE=1`. The judge model id is configured on the harness side
via `recipes.judge.model` (see the [recipes settings](../reference/CONFIGURATION_REFERENCE.md));
`uap setup` / `uap config` seed the `PROXY_ESCALATE_*` triple into the proxy env.

### Cross-process signals

Because the proxy freezes its `PROXY_*` env at startup and has no reload
endpoint, two features steer it **per request** via small signal files (each a
best-effort read, TTL ~180s, never fatal):

- **Recipe signal** — the harness [Reactor](../design/UAP_REACTOR.md) writes its
  per-prompt routing decision to `~/.cache/uap/recipe-signals/`; the proxy prefers
  that fresh signal over re-deriving complexity itself.
- **Adaptation signal** — the [LLM self-tuning](SELF_TUNING.md) real-time adaptor
  writes per-session adjustments (escalate / recipe / recon threshold / force
  synthesis) to `~/.cache/uap/adaptation-signals/`. Consumed when
  `PROXY_REALTIME_ADAPT` is on (**auto-on**; opt out with `0`).

---

## Configuration

Proxy settings are `PROXY_*` environment variables. Persist them with
`uap config set` (which writes `.uap/proxy.env`) and `uap proxy restart` to apply:

```bash
uap config set PROXY_RECON_CONVERGENCE_THRESHOLD 30
uap config set PROXY_AUTH_TOKEN "$(openssl rand -hex 16)"
uap proxy restart
```

The curated high-impact subset is documented in the
[Configuration Reference](../reference/CONFIGURATION_REFERENCE.md#proxy);
the exhaustive list lives as module-level constants in `anthropic_proxy.py`.

> **Note:** the upstream backend default in the checked-in scripts
> (`LLAMA_CPP_BASE`) points at a specific host/port — always set it (or your
> model's `endpoint`) to your own llama.cpp/Qwen server.
