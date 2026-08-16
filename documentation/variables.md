# Variables & Secrets

Config comes from three merged sources, in precedence order:

1. **Process environment** (`process.env.*` in TS; the Python proxy also
   `os.environ.setdefault`s from its env file, so real process env always wins).
2. **`.uap.json`** (project root, or up to 3 parent dirs for worktrees;
   `src/utils/config-loader.ts`). Validated by the Zod schema in `src/types/config.ts`.
3. **`.uap/proxy.env`** — proxy-only runtime env (recipes, escalation, the one
   disk-persisted secret). Written chmod 600 by the setup wizard; gitignored.

Systemd deployments read a *separate* env file at `~/.config/uap/anthropic-proxy.env`
(and `llama-server.env`) via `EnvironmentFile=`, not `.uap/proxy.env`.

## Secrets (risk-ranked)

| Secret | Where it lives | Rotation | Risk |
|---|---|---|---|
| `PROXY_ESCALATE_API_KEY` | `.uap/proxy.env` (600, gitignored) **and** `~/.config/uap/anthropic-proxy.env` | edit file + restart proxy | **Only secret persisted to disk.** Cleartext; file perms are the sole protection. Absent on local-llama-only deployments. |
| `ANTHROPIC_API_KEY` | env only (`ideate.ts:91`; proxy passthrough fallback) | env | Cloud passthrough credential. Gate spawns strip it from child env. |
| `OPENAI_API_KEY` | env only (`embeddings.ts:281`, gpt-5 presets) | env | Only used if a routing preset selects OpenAI or OpenAI embeddings. |
| `QDRANT_API_KEY` / `QDRANT_URL` | env or `.uap.json` `memory.longTerm.qdrantCloud` | env preferred | Only for Qdrant Cloud; local Docker Qdrant needs neither. |
| `GITHUB_TOKEN` | env or `.uap.json` `memory.longTerm.github.token` | env preferred | GitHub memory backend (off by default) + `gh` CLI for CI watcher. |
| `UAP_VISION_API_KEY` | env only (`vision-judge.ts:89`) | env | Visual-gate judge model, if a remote vision model is configured. |
| `FACTORY_API_KEY` / `DROID_API_KEY` | env only | env | Benchmark harness only. |

**Repo scan result:** no live secret is checked into the repo. `.gitignore` covers
`.env*`, `.uap/`, `.uap-backups/`. The config schema *deliberately refuses* to store the
judge API key in `.uap.json` (`config.ts:406`) — it goes to `.uap/proxy.env` only.

## Environment variables (grouped)

Complete `process.env` inventory. "Default" blank = unset/feature-off.

### Delivery pipeline (`UAP_DELIVER_*`)
| Var | Effect | Default |
|---|---|---|
| `UAP_DELIVER_MODEL` | Primary deliver model id | `qwen35-a3b` |
| `UAP_DELIVER_ROUTING` | Complexity-tier routing preset | — |
| `UAP_DELIVER_UNTIL_DELIVERED` | Loop until gates pass (bounded by ceiling) | on (`0` disables) |
| `UAP_DELIVER_DECOMPOSE` | Phase decomposition | on (`0` disables) |
| `UAP_DELIVER_ORCHESTRATE` | Blackboard orchestrator | on/off/auto |
| `UAP_DELIVER_EPICS` | Multi-epic mode | auto for complex |
| `UAP_DELIVER_AUTOSIZE` | Rail-fit context auto-size | on (`0` disables) |
| `UAP_DELIVER_SESSION_TOKEN_BUDGET` | Per-session token budget override | model preset budget |
| `UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT` | Max consecutive acceptance-judge rejections of green turns | 2 |
| `UAP_DELIVER_MAX_PHASES` | Phase-count ceiling | 8 (hard cap 20) |
| `UAP_DELIVER_MAX_TASKS` | Orchestrator task cap | 40 |
| `UAP_DELIVER_EPIC_ATTEMPTS` | Fresh-session attempts per epic | 2 |
| `UAP_DELIVER_CONTEXT_BUDGET` | Orchestrator per-task char budget | 6000 |
| `UAP_DELIVER_PARALLEL_EXPLORE` | Git-worktree parallel best-of-N | off |
| `UAP_DELIVER_NO_DEPLOY` | Skip deploy-dev gate | — |
| `UAP_DELIVER_LOCAL_MODE` | Local-model enforcement relax (advisory/deliver/block) | advisory |
| `UAP_DELIVER_ACTIVE` / `UAP_DELIVER_BYPASS` | In-flight guard / enforcement escape | — (escape = operator-only) |

### Enforcement escape hatches (operator-only — see `permissions.md`)
`UAP_ENFORCE_DELIVERY` (block/advisory/off), `UAP_DELIVER_BYPASS=1`, `UAP_SELF_PROTECT_OFF=1`,
`UAP_NO_WORKTREE`, `UAP_WORKDIR_SCOPE_OFF`, `UAP_SANDBOX_OFF=1`, `UAP_SANDBOX_ALLOW`
(colon-separated writable prefixes), `UAP_SANDBOX_WORKDIR`. These are meant to be set only
in a trusted launch environment; the (currently inert) self-protect enforcer was intended
to stop a model from persisting them.

### Hands-free persistence (`UAP_HANDSFREE*`)
`UAP_HANDSFREE` (enable; on by default, `0` disables), `UAP_HANDSFREE_INTENSITY`
(moderate/aggressive), `UAP_HANDSFREE_PRELEDGER` (pre-ledger nudge; `0` disables),
`UAP_HANDSFREE_PRELEDGER_MAX` (default 1), `UAP_HANDSFREE_MIN_TODOS` (default 3).

### Observability (`UAP_HALO_*`) — all local, no egress
`UAP_HALO_TRACE` (**on by default**; `0` opts out), `UAP_HALO_TRACE_PATH`
(`.uap/halo/traces.jsonl`), `UAP_HALO_PROJECT_ID` (`uap`), `UAP_HALO_TRACE_MAX_BYTES`
(10 MB), `UAP_HALO_AUTOMINE` (`0` disables the after-run weakness miner).

### Model / inference
`UAP_INFERENCE_ENDPOINT` (base URL; blind path default `http://localhost:4000/v1`),
`UAP_MODEL_ENDPOINT` (slot probe), `UAP_MODEL_PROFILE`, `UAP_MODEL_LEASE` (`0` disables
cross-process slot leasing), `UAP_MODEL_HTTP_TIMEOUT_MS` (30 min), `UAP_ACTIVE_MODEL`,
`UAP_ESCALATE_MODEL`, `UAP_EMBEDDING_ENDPOINT` (default `http://192.168.1.165:8081` — a
**hardcoded LAN IP** fallback), `UAP_LLM_SERVER`, `UAP_VISION_ENDPOINT`/`_MODEL`/`_API_KEY`.

### Proxy lifecycle (TS side)
`PROXY_PORT` (4000), `UAP_PROXY_RUN_SCRIPT`, `UAP_PROXY_HEALTH_WAIT_MS`,
`UAP_PROXY_NO_SYSTEMD` (use script-managed proxy), `UAP_PROXY_RUNTIME_DIR`,
`UAP_SESSION_ID` (+ harness `CLAUDE_SESSION_ID`/`FACTORY_SESSION_ID`/`CURSOR_SESSION_ID`
for reference-counted proxy ownership).

### Proxy runtime (Python; ~90 `PROXY_*` vars)
The proxy reads roughly ninety `PROXY_*` variables — connectivity/timeouts, the context
pruner (`PROXY_CONTEXT_WINDOW`, `PROXY_CONTEXT_PRUNE_THRESHOLD` 0.85,
`PROXY_CONTEXT_PRUNE_TARGET_FRACTION` 0.50), loop/starvation/contamination/attractor
breakers, tool state machine, session admission, slot save/restore, stream heartbeat,
grammar constraints, and passthrough control. These are set in the operator's
`anthropic-proxy.env`, not in `.uap.json`. Key ones:

| Var | Effect | Default |
|---|---|---|
| `LLAMA_CPP_BASE` | Local backend URL (note: LAN, not loopback). A **pin**: kept while it answers `/health`, otherwise the launcher discovers the live llama-server (see below) | `http://192.168.1.165:8080/v1` |
| `UAP_LLAMA_UPSTREAM_AUTODISCOVER` | `off` pins `LLAMA_CPP_BASE` hard — no discovery even when it is dead | `on` |
| `UAP_LLAMA_UPSTREAM_WATCH` | Background guard that restarts the proxy when the upstream moves to a new port. `auto` = only under a supervisor (systemd sets `INVOCATION_ID`); `on` forces it; `off` disables. **Never run it unsupervised** — there, stopping the proxy is the end of it | `auto` |
| `UAP_LLAMA_UPSTREAM_WATCH_SECS` | Watcher poll interval; it acts only after 2 consecutive misses AND a live server on a different port | `20` |
| `UAP_LLAMA_PROBE_TIMEOUT` | Per-probe timeout (seconds) for `/health`, `/props`, `/v1/models` during resolution | `2` |
| `ANTHROPIC_API_BASE` | Passthrough target | `https://api.anthropic.com` |
| `ANTHROPIC_PASSTHROUGH_MODELS` | Cloud allowlist; `__local_only__` disables cloud | default Claude patterns |
| `PROXY_HOST` / `PROXY_PORT` | Bind (defaults expose the LAN) | `0.0.0.0` / `4000` |
| `PROXY_CONTEXT_WINDOW` | Prune window (0 = auto-detect from `/slots`) | 0 |
| `PROXY_CONCURRENCY_LIMIT` | Concurrent requests to the single llama slot | 1 |
| `PROXY_SESSION_ADMISSION` | Cap distinct hot sessions | off |
| `PROXY_SLOT_SAVE_RESTORE` | Cross-session KV save/restore | off |
| `PROXY_STREAM_HEARTBEAT_SECS` | SSE keepalive while buffering | 0 |
| `PROXY_SANDBOX_UNREACHABLE_PREFIXES` | Tool prefixes stripped for `X-Uap-Sandbox:1` | `mcp__claude-in-chrome__` |

(The full table with every breaker threshold lives in the operator's env file and the
proxy source header; treat that as the authoritative reference for tuning.)

### Sandbox / coordination / misc
`UAP_COORD_DB` (coordination SQLite path), `UAP_AGENT`/`UAP_AGENT_ID` (identity),
`UAP_RECIPE_SIGNAL_DIR` (`~/.cache/uap/recipe-signals`), `UAP_VERIFY_ON_STOP` (run `uap
verify` at session end), `UAP_SELF_UPDATE`/`UAP_NO_SELF_UPDATE`, `UAP_LOG_LEVEL`,
`UAP_MAX_PARALLEL`/`UAP_PARALLEL`. Note `UAM_ENV` (`serverless-qdrant.ts:65`) — an
apparent typo for `UAP_ENV`, read as-is; documented here so it isn't "fixed" blindly.

### Third-party / harness-injected
`OPENAI_BASE_URL`, `NODE_ENV`, `CI`, `HOME`/`USERPROFILE`/`APPDATA`, `XDG_RUNTIME_DIR`,
`TMPDIR`, `CLAUDE_PROJECT_DIR`/`FACTORY_PROJECT_DIR`/`CURSOR_PROJECT_DIR`.

## `.uap.json` sections (schema-backed)

`src/types/config.ts` roots at `AgentContextConfigSchema`. Sections: `project` (required),
`platforms`, `memory` (short-term SQLite + long-term Qdrant + patternRag), `worktrees`,
`droids`, `commands`, `template`, `costOptimization` (token budgets), `timeOptimization`
(batch windows, parallelism), `multiModel` (routing roles/matrix), `agentExecution`
(benchmark-tuned flags — temperature 0.15, soft/hard budgets 35/50), `collaboration`,
`modelConcurrency` (adaptive AIMD slot limiting), `recipes` (fusion/confidence; **API key
never stored here**), `delivery` (`enforcement`/`localMode`/`runtimeVerify` →
`UAP_ENFORCE_DELIVERY`/`UAP_DELIVER_LOCAL_MODE`), `design` (token gate), `reactor`,
`patternRL`. Defaults are documented inline in the schema.

## Files created outside the repo

Home-directory: `~/.config/uap/*.env` + systemd user units, `~/.uap/self-harness/`,
`~/.uap/halo/`, `~/.uap/omp/`, `~/.cache/uap/{recipe-signals,llama-slots}/`,
`$XDG_RUNTIME_DIR/uap-proxy/` (0700). Project-local (gitignored): the full `.uap/` tree
and `.uap-backups/<date>/`. See `architecture.md` persistence map for the in-repo DBs.

## Related documents

- `permissions.md` — how the escape-hatch vars gate enforcement
- `architecture.md` — persistence map and trust boundaries
- `cron.md` — which intervals/timeouts these vars tune
