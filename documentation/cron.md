# Scheduled & Background Work

UAP has **no cron jobs and no scheduled cloud tasks**. What it has instead is (a) two
always-on systemd **user** services and (b) a set of in-process `setInterval`/`setTimeout`
loops and event-driven lifecycle hooks. This document inventories every recurring or
background behavior, its cadence, and whether it is idempotent / authenticated.

## Always-on services (systemd user units, opt-in at setup)

Installed to `~/.config/systemd/user/` by `src/cli/systemd-services.ts` (only when
`--systemd-services` / the Maximum profile's `proxy.autostart` is chosen). Both are
`Restart=always` — they self-restart on crash, not on a schedule.

| Unit | ExecStart | Restart | Purpose |
|---|---|---|---|
| `uap-anthropic-proxy` | `scripts/run-anthropic-proxy-continuity.sh` | `RestartSec=3` | The :4000 model proxy |
| llama-server (`uap-llama-server`) | `run-llama-server-continuity.sh` | `RestartSec=5` | The llama.cpp backend (:8080) |

Env comes from `~/.config/uap/anthropic-proxy.env` / `llama-server.env` via
`EnvironmentFile=`. `UAP_PROXY_NO_SYSTEMD` switches to a script-managed proxy instead.

## Interval loops (in-process, `.unref()`ed where long-lived)

| Loop | File | Cadence | Idempotent / notes |
|---|---|---|---|
| Agent heartbeat | `coordination/service.ts:52` | 30 s | Writes `last_heartbeat`; stale agents pruned after 3× interval. Local SQLite. |
| Background memory consolidation | `memory/memory-consolidator.ts:441` | 60 s | Consolidate + quality-decay short-term memory. Auto-started by setup. |
| Adaptive cache eviction | `utils/adaptive-cache.ts:137` | ~TTL (300 s default) | Evicts expired entries. |
| Qdrant health / idle | `memory/serverless-qdrant.ts:252,261` | health 30 s; idle check per `idleTimeoutMs` (300 s) | Keeps local Docker Qdrant warm; auto-stops when idle. |
| Deploy batcher windows | `coordination/deploy-batcher.ts:924` | `setTimeout` per action (commit 30 s / push 5 s / merge 10 s / deploy 60 s) | Batches git/deploy actions to reduce churn. |
| Dashboard SSE poller | `dashboard/server.ts:101` | 2 s | Reads new `dashboard_events` rows, fans out to SSE clients (cross-process feed). |
| Dashboard seeder heartbeat | `dashboard/data-seeder.ts:222` | 30 s | Liveness only; injects no fabricated data. |
| Recipe signal writer | `coordination/recipe-signal.ts:77` | per prompt (reactor) | Writes routing signals to `~/.cache/uap/recipe-signals`. |

## Event-driven lifecycle (not timed — triggered by harness hooks)

| Trigger | Handler | Effect |
|---|---|---|
| SessionStart hook | `proxy-lifecycle.ts` `ensureProxy` | Reference-counted proxy start/adopt (idempotent; adopts a healthy existing proxy, claims ownership only if it spawned one). |
| Stop hook | `proxy-lifecycle.ts` `releaseProxy` | Deregister client; stop proxy only if owner AND last client. |
| Stop hook | `handsfree stop-check` | Exit 2 to block premature session end while the ledger is incomplete (bounded). |
| Stop hook | `hooks.ts:632` (`UAP_VERIFY_ON_STOP`) | Optionally runs `uap verify`. |
| Each `uap setup` run | `self-update.ts:125` | `npm view` latest → `npm install -g` (unless CI / `UAP_NO_SELF_UPDATE`; 180 s timeout). This is the closest thing to an auto-updater. |

## Polling with internal-call auth

The **CI watcher** (`delivery/ci-watcher.ts`, only when `uap deliver --watch-ci`) commits
and pushes a feature branch, then polls **GitHub Actions** via the `gh` CLI every 15 s
(20-min timeout, 8 resolve attempts). Auth is the operator's existing `gh`/`GITHUB_TOKEN`
credential — UAP adds none. It **refuses to push `master`/`main`** (hardcoded guard). This
is the only recurring call that leaves the machine.

## Idempotency notes

- Heartbeats, memory consolidation, cache eviction, and the dashboard pollers are all
  read-modify-write on local SQLite with WAL + busy_timeout — safe to overlap across
  processes.
- The deploy batcher and CI watcher perform git actions; they are guarded (no
  `master`/`main` push, batch windows) but are the operations to review before enabling
  in a shared repo.
- No internal HTTP endpoint is called on a timer without a credential — the proxy and
  dashboard listeners are pulled *by* clients, not pushed to by a scheduler.

## Related documents

- `automation.md` — the event-driven agent automations these loops support
- `variables.md` — the interval/timeout env vars
- `architecture.md` — the services and their bind surface
