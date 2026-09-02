# Architecture

**What UAP is (intent):** a discipline layer that sits *underneath* an AI coding agent's
harness (Claude Code, Factory, Cursor, OpenCode, oh-my-pi) and mediates its work through
memory injection, policy enforcement, verification gates, and tool-output compression —
"a station at every point where the line usually breaks."

**What UAP is (implementation):** a TypeScript/Node CLI (`uap`, `src/bin/cli.ts`, ~43
top-level commands, 60 registrations including subcommands) plus a Python FastAPI model proxy, wired into harnesses via shell
hooks, four SQLite databases, an optional Docker Qdrant vector store, and a bubblewrap
kernel sandbox. Version: **v1.224.0**.

## Stack

| Layer | Technology | Where |
|---|---|---|
| CLI + subsystems | TypeScript (Node ≥18), 367 modules in 26 `src/` subsystems | `src/` |
| Model proxy | Python FastAPI/uvicorn, ~10.6k lines | `tools/agents/scripts/anthropic_proxy.py` |
| Policy enforcers | Python scripts (exit 0=allow / 2=block) | `src/policies/enforcers/*.py` → materialized to `.policy-tools/` |
| Harness integration | Shell hook scripts installed into per-platform `settings.local.json` | `templates/hooks/`, `src/cli/hooks.ts` |
| Persistence | SQLite ×4 (tasks, coordination, policies, telemetry) + JSON/JSONL ledgers | see table below |
| Vector memory | Qdrant (auto-started Docker `uap-qdrant`, :6333) or cloud; in-memory fallback | `src/memory/serverless-qdrant.ts` |
| Sandbox | bubblewrap (`bwrap`) read-only root + writable holes | `src/cli/sandbox.ts` |
| Browser | CloakBrowser (Playwright-compatible, stealth) — execution/visual gates only | `src/browser/web-browser.ts` |
| Services | systemd **user** units (`uap-anthropic-proxy`, llama-server), `Restart=always` | `src/cli/systemd-services.ts` |

## Process topology

```
┌─ Agent harness (Claude Code / Factory / Cursor / …) ──────────────┐
│  hooks: SessionStart · UserPromptSubmit · PreToolUse · PostToolUse│
│         Stop · SessionEnd    (installed in settings.local.json)   │
└──────┬──────────────────────────────────┬─────────────────────────┘
       │ shell hooks → uap CLI            │ Anthropic Messages API
       ▼                                  ▼
  uap CLI (deliver/memory/task/…)    anthropic proxy :4000 (0.0.0.0)
       │  blind executor → :4000          │ guardrails, pruning, grammar,
       │  agentic executor → :8080 direct │ sandbox tool-strip, passthrough
       ▼                                  ▼
  SQLite DBs · Qdrant :6333          llama.cpp :8080 (LAN) · embeddings :8081
  dashboard :3847 (HTTP/WS/SSE)      api.anthropic.com (passthrough only)
  mcp-router (stdio, no port)
```

## Auth flow

There is **no user authentication anywhere in the system** — it is a single-operator
local tool. Identity boundaries are process/trust-tier based (see `permissions.md`):

- The **proxy** (:4000) accepts any request; cloud passthrough forwards the *client's*
  `Authorization`/`x-api-key` (or falls back to server `ANTHROPIC_API_KEY`), returning
  401 only when no credential exists for a passthrough model. The
  `ANTHROPIC_PASSTHROUGH_MODELS=__local_only__` sentinel disables cloud entirely.
- The **dashboard** (:3847) has no auth and `Access-Control-Allow-Origin: *`, including
  its policy-mutating POST endpoints.
- Provider keys are env-var-only in code (`apiKeyEnvVar` on model presets); the one
  disk-persisted secret is `PROXY_ESCALATE_API_KEY` in `.uap/proxy.env` (chmod 600,
  gitignored). A guard refuses to send credentials to non-local hosts over plain HTTP
  (`openai-compat-client.ts:92-97`).

## Trust boundaries

1. **Kernel (strongest):** `uap sandbox` — bwrap read-only root; only the workdir,
   tmp dirs, and `~/.claude`/`~/.cache`/`~/.npm` are writable. Holds even under
   `--dangerously-skip-permissions`. Network deliberately unrestricted.
2. **Hook plane:** PreToolUse gate (`uap-policy-gate.sh`) runs Python enforcers from
   `.policy-tools/` per the `policies.db` `executable_tools` join; Stop hook
   (`handsfree stop-check`, exit 2) blocks premature session end. Bypassed by
   `--dangerously-skip-permissions` (known; sandbox is the compensating control).
3. **Deliver plane:** applier/agentic-executor protected paths (`.git`, `.uap`, CI dirs,
   lockfiles, gate configs, IaC, pre-existing tests + their oracle import graph),
   runtime integrity snapshot/restore, secret-stripped gate spawns (`CI=true`, all
   `*_API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` removed).
4. **Proxy plane:** ~90 `PROXY_*` guardrails (loop/starvation/contamination breakers,
   context pruner, session admission, grammar constraints, sandbox tool-stripping via
   the `X-Uap-Sandbox: 1` header).
5. **LAN boundary (weakest):** proxy binds `0.0.0.0:4000` unauthenticated; dashboard
   optionally `0.0.0.0:3847` unauthenticated. See `permissions.md` findings.
6. **Internet egress (three paths only):** api.anthropic.com passthrough, OpenAI
   presets if routed, Qdrant Cloud if configured. Everything else is localhost/LAN.
   No analytics/telemetry leaves the machine.

## Persistence map

| Data | Path | Format |
|---|---|---|
| Tasks (epic/story/task DAG) | `.uap/tasks/tasks.db` + git-syncable `tasks.jsonl` | SQLite WAL + JSONL |
| Coordination (agents, messages, leases, deploy queue, findings, challenges) | `agents/data/coordination/coordination.db` (`UAP_COORD_DB`) | SQLite WAL |
| Policies + executable tools + audit | `agents/data/memory/policies.db` | SQLite WAL |
| Telemetry / dashboard events | `agents/data/memory/telemetry.db` (busy_timeout 2s, best-effort) | SQLite WAL |
| Deliver run state (resume) | `.uap/deliver-runs/<runId>/state.json` (sanitized on read) | JSON |
| Completion ledger (definition of done) | `.uap/completion-ledger.json` | JSON |
| HALO traces (on by default; local only) | `.uap/halo/traces.jsonl` (10 MB rotation) | JSONL |
| Practice cards / mined weaknesses | `.uap/delivery-practices.json`, `.uap/halo/weaknesses.json` | JSON |
| Vector memory | `agents/data/qdrant/` (Docker) or Qdrant Cloud | Qdrant |
| Proxy/llama service env (operator-managed) | `~/.config/uap/*.env` + systemd user units | env files |
| Proxy runtime registry (refcounting) | `$XDG_RUNTIME_DIR/uap-proxy` (0700) | JSON |

## Notable intent-vs-implementation deltas

- **Self-protect enforcement** (`enforcement_self_protect.py`) is registered in the gate
  hook (v1.224): it guards `policies.db`, the hook scripts, and the trust anchors
  (`.uap/operator-overrides.json`, `.uap/policy-liveness.json`) against tampering —
  including interpreter-mediated writes (`python3 -c 'open(...,"w")'`) that text scans
  can't see. The delivery enforcer still exempts the policy directories — see
  `permissions.md` §Findings.
- Of 50 active policy rows, only **17 enforce at runtime**; the rest are markdown-keyword
  (Plane B) advisories that never see native Edit/Write/Bash.
- The agentic executor enforces protected paths, snapshot-restore, and a context budget.
  Worktree-isolated parallel verification is implemented in `candidate-workspace.ts`.

## Conditional capabilities

- **Emails/notifications: absent.** No SMTP/webhook/chat-provider code exists; the only
  "notification" channel is inter-agent messages in the local coordination DB.
- **SEO: not applicable.** No public web product; the dashboard is a local console, and
  the only page rendering is the headless visual gate.
- Scheduled/background work exists → see `cron.md`. Embedded automation exists
  extensively → see `automation.md`.

## Related documents

- `flows.md` — permission-relevant journeys and their side effects
- `permissions.md` — trust tiers, enforcement planes, resource matrix, findings
- `variables.md` — configuration and secrets mapped to risk
- `cron.md` — scheduled and interval work inventory
- `automation.md` — embedded agents/automations, guardrails, approval gates
- Existing narrative docs: `docs/INDEX.md` (guides per subsystem), `docs/guides/SANDBOX.md`
