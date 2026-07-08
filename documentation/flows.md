# Flows

The permission-relevant journeys through UAP, each showing where a check fires, which
trust boundary is crossed, and the side effects it causes. See `permissions.md` for the
enforcement planes referenced here and `architecture.md` for the process topology.

## Flow 1 — Interactive agent edits a source file (hooked session)

The core mediated path: a Claude Code / Factory / Cursor session with UAP hooks installed
tries to edit code.

1. **UserPromptSubmit** → `uap-reactor-prompt.sh` runs the reactor (`coordination/reactor.ts`),
   injecting up to 6 context blocks (design summary, project state, board, handsfree
   directive, and a `deliver:routing` note telling the model to route code writes through
   `uap deliver`). *Side effect:* context injected into the prompt; recipe signal written
   to `~/.cache/uap/recipe-signals`. No authz.
2. Model emits an `Edit`/`Write`/`MultiEdit` tool call.
3. **PreToolUse gate** (`uap-policy-gate.sh`) — trust boundary: hook plane. Queries
   `policies.db`, runs each registered enforcer's `.policy-tools/*.py`.
   - `workdir_scope` → blocks edits outside the workdir (**ignored under
     `--dangerously-skip-permissions`**).
   - `worktree_required` → blocks edits outside a git worktree.
   - `delivery_enforcement.py` (block mode) → **blocks a direct source edit** (exit 2) and
     emits `route:deliver`, telling the harness to go through `uap deliver` instead.
     Exempts `test/`, `docs/`, `policies/`, `src/policies/`, non-source extensions, and
     local-model sessions in advisory mode.
4. If allowed, the edit applies. **PostToolUse** → build-gate / schema-change reminders.
5. **Stop** → `handsfree stop-check`: if `.uap/completion-ledger.json` has remaining
   items, exits 2 to **block session end** and push the model to continue (bounded by
   `maxBlocks`/stagnation guards so it can't wedge). *Side effect:* the agent keeps going
   until the ledger is complete.

**Boundary note:** none of steps 3–5 hold under `--dangerously-skip-permissions`. The only
boundary that survives is `uap sandbox` (bwrap) — see Flow 4.

## Flow 2 — `uap deliver` drives a model to verified completion

Not hook-mediated; carries its own protections.

1. **Auto-optimizer** (`auto-optimizer.ts`) classifies instruction complexity and, for
   moderate/complex work, silently flips on candidates, critic, practices, acceptance
   judge, and (complex only) escalation — a ~4–5× model-call cost cliff.
2. **Executor selection** (`selectExecutorMode`): `auto` → agentic when the repo has gates
   or inspectable content, else blind.
   - **blind** executor → proxy **:4000** (think-stripping, clean file fences).
   - **agentic** executor → llama **:8080 direct** (tool loop; the proxy would stall it).
3. **Write authz (deliver plane):** every file write — via the applier (blind) or
   `write_file` (agentic) — passes `protectedWritePathReason`: blocks `.git`/`.uap`/CI
   dirs/`node_modules`, lockfiles, gate configs + IaC, pre-existing tests and their oracle
   import graph, absolute/traversal/symlink-escaping paths. Trust boundary: deliver plane.
4. **Gate execution:** the verifier ladder runs detected gates (build/typecheck/test/lint
   → runtime execution gate → integration → deploy-dev) cheapest-tier-first. *Each gate
   spawn strips all `*_API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` env vars and sets
   `CI=true`* — project scripts never see provider credentials.
5. **Runtime integrity guard:** after every gate run, protected files are re-hashed; any
   the gate's own code mutated are restored and that gate result is discarded (blocks
   "model-authored test rewrites the oracle at runtime").
6. **Acceptance judge** (when enabled): reads priority-ordered code evidence and grades the
   goal; a churn breaker caps consecutive rejections of objectively-green turns.
7. **Side effects:** run state to `.uap/deliver-runs/<id>/state.json`; practice cards,
   HALO trace, mined weaknesses; the project tree itself (rollback-snapshotted under
   `--no-regress`); task DB updated *only if one already exists*. **No git commit** unless
   `--deploy` is passed, which merely *enqueues* a commit into the deploy batcher.

## Flow 3 — Cloud passthrough vs local-only

1. Client calls proxy `/v1/messages` with a model id.
2. `_should_passthrough_model`: if `ANTHROPIC_PASSTHROUGH_MODELS` is set, exact-membership;
   else default Claude prefix patterns. The `__local_only__` sentinel makes every model
   fail the check → **nothing forwards to Anthropic**, all served locally.
3. On passthrough (trust boundary: **internet egress**): `_build_passthrough_headers`
   forwards the client's `Authorization: Bearer` (Claude Max/Pro OAuth) verbatim, or its
   `x-api-key`, or falls back to server `ANTHROPIC_API_KEY`; returns 401 if none.
4. Local path: request is rewritten for llama.cpp :8080, run through the full guardrail
   stack (grammar constraint, context pruner, loop/contamination breakers), think-stripped,
   and returned in Anthropic shape.

**Boundary note:** the proxy itself requires no credential — anything on the LAN reaching
:4000 can drive the local model, and can use passthrough if it supplies a valid Anthropic
credential.

## Flow 4 — Sandboxed session

1. Operator launches `uap sandbox -- env … claude --dangerously-skip-permissions …`.
2. `sandbox.ts` builds a bwrap namespace: read-only `/`, writable holes = workdir + tmp +
   `~/.claude`/`~/.cache`/`~/.npm` + `UAP_SANDBOX_ALLOW`. Refuses `$HOME`/`/`/`/home` as
   workdir. Trust boundary: **kernel** — writes elsewhere fail with EROFS regardless of
   what the model or its subprocesses attempt.
3. Sets `X-Uap-Sandbox: 1` header (via `ANTHROPIC_CUSTOM_HEADERS`) and `UAP_SANDBOX_ACTIVE=1`.
4. The proxy reads the header and strips unreachable browser MCP tools
   (`mcp__claude-in-chrome__*`) from the tool list, because the Chrome extension socket
   isn't bound into the namespace — otherwise the model loops on a dead-ended tool.
5. Network is unrestricted, so the sandboxed agent still reaches the proxy at :4000.

## Flow 5 — Dashboard access

1. `uap dashboard serve --host <host>` starts HTTP/WS/SSE on **:3847** (default
   `localhost`).
2. **No auth on any route**, `Access-Control-Allow-Origin: *` on every response.
3. `GET /api/dashboard` (snapshot), `GET /api/events` (SSE, fed from the persisted
   `dashboard_events` table on a 2s poll). `POST /api/policy/:id/{toggle,stage,level}`
   **mutates policy memory with no credential**.
4. With `--host 0.0.0.0`, all of the above — including policy mutation — is reachable by
   any LAN host. Only guards: 10 KB body cap and a vendor-dir path-traversal check.

## Side-effect summary

| Flow | External calls | Persistent writes | Irreversible? |
|---|---|---|---|
| 1 Interactive edit | recipe signal | prompt context, ledger blocks | edits are (usually) worktree-scoped |
| 2 Deliver | model inference; headless browser; `gh` if `--watch-ci` | project tree, run state, practices, HALO, task DB | tree mutated (snapshot-restorable with `--no-regress`); commit only with `--deploy` |
| 3 Passthrough | **api.anthropic.com** | proxy telemetry (local) | sends prompt to Anthropic |
| 4 Sandbox | model inference | workdir only (kernel-enforced) | no |
| 5 Dashboard | none | policy memory (via POST) | policy toggles persist |

## Related documents

- `permissions.md` — the enforcement planes and their gaps
- `automation.md` — the reactor, hands-free loop, and self-improvement automations
- `cron.md` — the interval work (heartbeats, pollers, CI watcher) these flows rely on
