# Embedded Automation

UAP *is* an automation layer — most of its value is behavior that runs without an explicit
per-action command. This document inventories each embedded agent/automation: its trigger,
tool surface, whether guidance is soft (steerable) or a hard guardrail, its output
contract, the app-owned side effects, and where a human approval gate exists (or doesn't).

## 1. The Reactor (per-prompt context injection)

- **Trigger:** every `UserPromptSubmit` hook (`uap-reactor-prompt.sh` → `coordination/reactor.ts`).
- **Tool surface:** read-only — reads DESIGN.md, project-state manifest, collaboration
  board, completion ledger; routes the prompt through the capability router + pattern
  router. Writes only a recipe signal file.
- **Steering vs guardrail:** **soft.** It *injects* up to 6 context blocks (≤1200 chars
  each) — design summary, project state, board, active-collab note, hands-free directive,
  and a `deliver:routing` nudge. Nothing is blocked here.
- **Output contract:** context strings prepended to the model's prompt; deduped per session
  by a "surfaced key" so the same block isn't injected twice.
- **Approval gate:** none — it is advisory context. Auto-spawn of an expert droid only
  *recommends* (produces a `spawn-expert` action) at confidence ≥ 0.80; it does not
  autonomously start work.

## 2. Hands-free persistence loop (Stop-hook driven)

- **Trigger:** `Stop` hook (`stop.sh` → `handsfree stop-check`). On by default; disable via
  `UAP_HANDSFREE=0` or `.uap.json` `handsfree.enabled=false`.
- **Tool surface:** reads `.uap/completion-ledger.json`; can auto-seed the ledger from the
  model's `TodoWrite` plan (`sync-todos`, PostToolUse hook).
- **Steering vs guardrail:** **hard on the session boundary** — while the ledger has
  remaining items it exits 2 to *block session end*, forcing the agent to continue.
- **Output contract:** exit 0 (allow stop) / exit 2 + a model-facing stderr message
  (continue, here's what's left).
- **Guardrails against runaway:** honors `stop_hook_active` (never re-blocks), gives up at
  `profile.maxBlocks` or after N no-progress blocks (stagnation limit), and a bounded
  pre-ledger nudge (`PRE_LEDGER_MAX`, default 1) only for the local model family that
  stalls at planning.
- **Approval gate:** none — this is the "keep going until done" automation; the operator's
  control is the master switch and the stagnation bounds.

## 3. `uap deliver` autonomous build loop

The largest automation. Detailed in `flows.md` Flow 2; automation-relevant facts:

- **Trigger:** explicit `uap deliver …`, or the reactor's `deliver:routing` nudge steering
  a blocked Edit into it.
- **Tool surface (agentic executor):** `read_file`, `list_dir`, `run_bash`, `write_file`,
  `finish` — a bounded tool loop (default 12 rounds, 30 s bash timeout).
- **Steering vs guardrail:** **both.** Soft: prompts, practice cards, mined-weakness
  guidance, critic fix-lists. Hard: the applier/executor protected-path set, the runtime
  integrity guard, secret-stripped gate spawns, the acceptance judge + churn breaker, and
  the context-budget hard stop.
- **Output contract:** file writes (whole-file `file:path` fences for blind; direct FS for
  agentic) + a delivery result (success/turns/score/feedback); run state persisted for
  `--resume`.
- **App-owned side effects:** the project tree, `.uap/deliver-runs/`, practices, HALO
  traces, mined weaknesses, task DB (if present). **Git:** none by default — a commit is
  only *enqueued* to the deploy batcher when `--deploy` is passed.
- **Approval gates:** commit/push/deploy are all opt-in flags (`--deploy`, `--watch-ci`,
  `--until-deployed`) even when the auto-optimizer's plan turns on other aids. The deploy
  batcher and CI watcher refuse to push `master`/`main`.

## 4. Multi-agent coordination (announcement-based, not locking)

- **Trigger:** agents register/heartbeat via the coordination DB when they start work
  (e.g. a deliver run registers itself through `run-coordinator.ts`).
- **Tool surface:** the coordination SQLite DB — agent registry, message bus, work
  announcements, model-slot leases, deploy queue, findings ledger, challenge leaderboard.
- **Steering vs guardrail:** **soft by design.** `announceWork` "does NOT lock — just
  informs other agents" (`service.ts:298`). The one hard constraint is the **model-slot
  lease** — a cross-process semaphore over the llama.cpp inference slots so the fleet
  respects the backend's capacity (fail-open if the coordination DB is unavailable).
- **Output contract:** rows in `coordination.db`; overlap warnings surfaced to agents.
- **Approval gate:** none — coordination is cooperative; conflicts are surfaced, not
  prevented.

## 5. Self-improvement (HALO trace → mine → weakness guidance)

- **Trigger:** automatic after every deliver run (HALO tracing on by default;
  `UAP_HALO_AUTOMINE` on). Also the `self-harness` command for the deeper mine→propose→
  validate→decide loop.
- **Tool surface:** reads its own `.uap/halo/traces.jsonl`; writes ranked
  `.uap/halo/weaknesses.json`.
- **Steering vs guardrail:** **soft.** Recurring failure kinds translate to
  harness-authored prompt guidance injected into the *next* run. All guidance is
  regenerated from templates, never echoed model output (provenance-safe), and error
  strings replayed into an LLM are sanitized (control chars stripped, capped).
- **Output contract:** guidance lines with a 7-day TTL that retire when the pattern stops
  recurring.
- **Approval gate:** none — but it only changes prompts, never code or config. All local;
  no egress (the trace file is fed to the external HALO CLI manually if at all).

## 6. Proxy guardrail automations (server-side)

The proxy autonomously reshapes in-flight requests: loop/starvation/contamination/attractor
breakers (reset transcript tail, bump temperature, drop forced-tool mode), context pruning
at the window threshold, grammar constraints on tool calls, and sandbox tool-stripping.
These are **hard guardrails** on the model's behavior, all local, configured by ~90
`PROXY_*` env vars (see `variables.md`). No approval gate — they are the mediation layer.

## Automations that DON'T exist (checked)

- **No email/chat notifications** — no SMTP/webhook/Slack/Discord/Telegram/Twilio code.
  The only "notify" is inter-agent messages in the local coordination DB.
- **No outbound analytics/telemetry** — all telemetry is local SQLite / JSONL.
- **No autonomous git push to a default branch** — hard-guarded off.
- **No autonomous cloud calls** except the three opt-in/config-gated egress paths
  (Anthropic passthrough, OpenAI presets, Qdrant Cloud).

## Related documents

- `flows.md` — the deliver and interactive flows these automations drive
- `cron.md` — the interval/lifecycle machinery underneath
- `permissions.md` — which automations are hard guardrails vs advisory, and the inert ones
