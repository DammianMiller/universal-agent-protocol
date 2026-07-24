# Permissions

UAP has **no user-account system and no role-based auth**. It is a single-operator local
tool: the "roles" that matter are *trust tiers* — who or what is issuing an operation —
and every check is **code-enforced** (there is no database-level enforcement anywhere;
"RLS" does not apply to this system). This document maps each tier to what it can
actually do, where the check lives, and where the checks are weaker than the prose
documentation claims.

## Trust tiers (the de-facto roles)

| Tier | Who it is | Trust level |
|---|---|---|
| **Operator** | The human launching processes; owns the shell env, systemd units, and config files | Full trust — every escape hatch keys off launch-time env vars |
| **Agent model (hooked session)** | Claude Code / Factory / Cursor session with UAP hooks installed | Semi-trusted — tool calls mediated by PreToolUse/Stop hooks |
| **Agent model (sandboxed)** | Same, launched under `uap sandbox` (bubblewrap) | Least privilege — kernel-enforced read-only filesystem outside allow-listed holes |
| **Deliver executor model** | The model driven by `uap deliver` (blind or agentic executor) | Semi-trusted — mediated by the applier/agentic-executor protected-path logic, not by hooks |
| **Project scripts** | `npm test`, build scripts, anything a verification gate spawns | Untrusted-adjacent — runs arbitrary project code on the host |
| **LAN peer** | Any machine that can reach this host's bound ports | **Effectively operator-level on two services** (see Findings) |

## Enforcement planes (where checks actually live)

There are two **independent** enforcement planes plus per-subsystem guards. The
distinction matters because the `policies/*.md` documents blur them.

### Plane A — runtime hook plane (real enforcement for interactive sessions)
`templates/hooks/uap-policy-gate.sh`, installed into each harness's hooks by
`uap hooks install` / `uap setup` (`src/cli/hooks.ts:221-286`). On every
`PreToolUse` for `Edit|Write|MultiEdit`, `Bash`, and `Task|Agent|ToolSearch|ExitPlanMode`
it queries `agents/data/memory/policies.db` and executes the matching Python enforcers in
`.policy-tools/*.py`. An enforcer exits **0 = allow, 2 = block** (`_common.py:24-28`);
block reasons go to the model via stderr.

**Load-bearing detail:** the gate's SQL joins `policies` to `executable_tools` — a policy
row **without** an `executable_tools` row is invisible to Plane A no matter what its
markdown says. As of this audit, 50 policies are active in the DB but only **17** have
executable tools and therefore actually enforce:
`cluster-routing, iac-parity, worktree-required, schema-diff-gate, parallel-reads,
mcp-router-first, memory-before-plan, test-gate, doc-live-over-report, artifact-hygiene,
coord-overlap, session-memory-write, codebase-read-before-plan, validate-plan-before-build,
rtk-wrap, delivery-enforcement, workdir-scope`.

### Plane B — TypeScript PolicyGate (mcp-router path only)
`src/policies/policy-gate.ts` keyword/anti-pattern matches a tool operation against
policy `rawMarkdown` (`extractRules` :337, `checkRule` :305). It gates **only** tools
routed through UAP's own mcp-router `execute` tool (`src/mcp-router/tools/execute.ts:204`)
— it never sees native Edit/Write/Bash. Only `level === 'REQUIRED'` violations block
(`policy-gate.ts:252`). This is best understood as advisory defense-in-depth, not the
primary control.

### Kernel plane — `uap sandbox` (bubblewrap)
`src/cli/sandbox.ts:51` wraps the agent process in `bwrap` with a read-only root and
writable holes only for: the workdir, `/tmp`, tmpfs `/var/tmp`, `/run`, `~/.claude`,
`~/.cache`, `~/.npm`, plus `UAP_SANDBOX_ALLOW` extras (:86-105). Writes elsewhere fail at
the kernel (EROFS/EACCES) — this binds Write/Edit, Bash, and every subprocess equally,
and is the **only** control that holds under `--dangerously-skip-permissions` (hook
exit-2 denials are ignored in that mode — see CHANGELOG v1.63.0). Network is deliberately
**not** restricted (the agent must reach the proxy at :4000). Refuses to sandbox an
over-broad workdir (`$HOME`, `/`, `/home`; :81-83). `UAP_SANDBOX_OFF=1` is the operator
escape.

Sandboxed sessions additionally advertise themselves with the `X-Uap-Sandbox: 1` header
(appended to `ANTHROPIC_CUSTOM_HEADERS`, `sandbox.ts:30-39`); the proxy strips browser
MCP tools (`mcp__claude-in-chrome__*`, configurable via
`PROXY_SANDBOX_UNREACHABLE_PREFIXES`) from the tool list because the Chrome extension
socket is not bound into the namespace (`anthropic_proxy.py:4393, 9339`).

### Deliver plane — applier + agentic executor + integrity guard
`uap deliver` is not hook-mediated; it carries its own controls, sharing one source of
truth (`protectedWritePathReason`, `applier.ts:164`):

- **Protected segments** (`applier.ts:96-106`): `.git`, `.uap`, `.husky`, `.github`,
  `.gitlab`, `.circleci`, `node_modules` — blocked anywhere in a write path.
- **Protected basenames** (:107-116): `package.json`, all lockfiles, `.npmrc`, `.yarnrc`.
- **Gate-config / IaC protection** (:126-149): ts/test-runner configs, pytest/setup
  configs, docker-compose, Dockerfile, `*.tf`, pulumi, serverless — blocks "gate rigging
  by indirection". Default on.
- **Pre-existing test/spec protection** plus the spec's oracle import graph
  (fixtures/snapshots/golden files — `spec-imports.ts`). New tests are allowed.
- **Path validation** (:508-564): rejects absolute paths, traversal, leading-`-`
  (CLI-arg injection), symlink targets and symlink-escaping parents; 1 MB per-file cap.
- **Agentic executor** re-applies the same rules on `write_file` and snapshot-restores
  protected files that a `run_bash` command mutated (`agentic-executor.ts:241-272`).
- **Runtime integrity guard** (`integrity.ts`): sha256 snapshot of protected files after
  baseline; any gate run that mutates one has its result **discarded** and the file
  restored — closing the "model-authored test rewrites the oracle at runtime" channel.
- **Secret hygiene for gates** (`verifier-ladder.ts:124-131`): every gate spawn strips
  env vars matching `/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` and sets `CI=true`,
  so project scripts never inherit provider credentials.

## Resource × operation × tier matrix

| Resource | Operation | Operator | Hooked model | Sandboxed model | Deliver executor | LAN peer |
|---|---|---|---|---|---|---|
| Source files (worktree) | write | ✅ | ✅ via `uap deliver` route; direct edit **blocked** by `delivery_enforcement` (block mode) | same + kernel-limited to workdir | ✅ (protected paths excluded) | — |
| Tests/spec files (pre-existing) | write | ✅ | blocked (Plane A test-gate) | blocked | **blocked** (applier + integrity) | — |
| Gate configs, lockfiles, CI dirs, IaC | write | ✅ | blocked for source-edit routes | blocked + kernel | **blocked** (applier) | — |
| `.uap/`, `policies.db`, hook scripts | write | ✅ | **⚠ partially open — see Finding 1** | kernel-blocked outside workdir | `.uap` segment blocked by applier | — |
| Files outside workdir | write | ✅ | hook-blocked (`workdir-scope`) — **not** under `--dangerously-skip-permissions` | **kernel-blocked** | n/a (applier is root-relative) | — |
| Local model inference (:4000) | use | ✅ | ✅ | ✅ (network not namespaced) | ✅ | **✅ unauthenticated — Finding 2** |
| Anthropic passthrough | use | ✅ (needs credential) | via proxy w/ credential | same | same | with a valid credential — Finding 2 |
| Dashboard read + policy toggle (:3847) | read/mutate | ✅ | ✅ | ✅ | — | **✅ if `--host 0.0.0.0` — Finding 3** |
| Git commit / push / deploy | execute | ✅ | commit gated by worktree policies; deploy queue | same | **never direct** — only `--deploy` enqueues to the deploy batcher | — |
| Provider API keys | read | ✅ (env, proxy.env) | gates never inherit them (env stripping) | same | same | file perms only |

## Findings — where enforcement diverges from documented intent

1. **`enforcement_self_protect` was inert — FIXED (v1.125.0).** The enforcer exists
   (`src/policies/enforcers/enforcement_self_protect.py`) and is documented as active,
   but its policy rows were all `RECOMMENDED` with **zero `executable_tools` rows**, so
   Plane A never ran it, and the active `delivery_enforcement.py` **exempts**
   `src/policies/`/`policies/`. Net effect: a hooked agent could edit the enforcement
   control surface. **Fixed:** `ensureSelfProtect()` now attaches the enforcer at
   `setup`/`init` (`src/cli/deliver-defaults.ts`); the hook runs on `isActive=1` + an
   executable_tools row (level-independent), so it is now live. **This containment
   depends on Finding 3** — the enforcer has no model-reachable bypass, but the
   dashboard toggle (now token-gated) was the one way to disable it.
2. **The proxy (:4000) is unauthenticated and binds `0.0.0.0` by default.** Any LAN host
   can drive the local model; with a valid Anthropic credential (or the server's, via a
   fallback) it can use cloud passthrough. `ANTHROPIC_PASSTHROUGH_MODELS=__local_only__`
   is the operator policy that removes the cloud path — **audited live and found NOT set
   (empty) on this deployment**; the IaC (`~/.config/uap/anthropic-proxy.env`) has been
   **restored to `__local_only__`** (applies on next proxy restart; no live exposure
   meanwhile as `ANTHROPIC_API_KEY` is unset). The local-model surface remains open to
   the LAN — bind `127.0.0.1` or add a shared-secret header for real LAN protection.
   Recommended code fix: remove the `or ANTHROPIC_API_KEY` passthrough fallback
   (`anthropic_proxy.py:9214`).
3. **The dashboard (:3847) mutation routes were unauthenticated — FIXED (v1.127.0),
   token-exfiltration hole closed when the dashboard became always-on.**
   `POST /api/policy/:id/{toggle,stage,level}` disable+persist security controls and had
   no auth + `Access-Control-Allow-Origin: *` — a single request (LAN, or cross-site via
   CORS `*`) disabled enforcement, undoing Finding 1's fix. **Fixed (v1.127.0):**
   mutations require an unguessable per-session token (`X-Uap-Dashboard-Token`;
   same-origin UI gets it via server-side injection). Read routes stay open. Default
   bind remains `localhost`.
   **Follow-up:** the v1.127.0 note claimed CORS blocked a cross-origin read of the
   token-bearing page. It did not — the wildcard `Access-Control-Allow-Origin` was set
   on *every* response before routing, so any page the operator visited could read `/`,
   scrape the token, and drive every mutation route (including `POST
   /api/deliver/launch`). Now that the dashboard rides along with `uap proxy` and is up
   for the whole session, that was closed: the token-bearing page (`/`, `/index.html`)
   is served **without** CORS headers, WebSocket upgrades require a same-origin `Origin`
   (WS is exempt from SOP/CORS and was leaking full snapshots), and a ride-along
   dashboard does not echo the token into its log file. `GET /health` is intentionally
   unauthenticated and returns only `{ok, service, port, root}`.
4. **Hook enforcement does not survive `--dangerously-skip-permissions`.** Known and
   documented (CHANGELOG v1.63.0): exit-2 denials are ignored in that mode. The bwrap
   sandbox is the designed compensating control — the workdir boundary is only real
   when the agent is launched under `uap sandbox`.
5. **10 enforcers exist in source but are not registered** (`adr_guard`,
   `bearer_lockdown`, `design_token_gate`, `expert_review_required`,
   `iac_plan_destruction_check`, `local_build_before_push`, `ship_loop_gate`,
   `task_required`, `enforcement_self_protect`, one UUID-prefixed architecture-review) —
   present in `src/policies/enforcers/` but absent from `.policy-tools/` and the DB join.
6. **`policies/*.md` scope ≠ enforced scope.** Example: `worktree-enforcement.md` says
   "no file type is exempt"; the running `delivery_enforcement.py` gates only
   `SOURCE_EXTS` and exempts `test/`, `docs/`, `policies/`, `src/policies/`. The
   markdown documents are Plane-B keyword sources and human intent, not the runtime
   contract.
7. **`.uap-deliver/` self-gate was overwritable — FIXED (v1.126.0).** The self-authored
   acceptance gate (`.uap-deliver/verify.sh`) was not in PROTECTED_SEGMENTS, so a model
   could overwrite its own sole required gate with `exit 0`. **Fixed:** `.uap-deliver` is
   now a protected segment (blocks the applier/`write_file`) and the gate script is in
   the runtime integrity snapshot (catches the `run_bash` vector → turn discarded). Also
   in v1.126.0: `run_bash` and self-gate spawns now use the secret-stripped env (was full
   host env), and the strip regex covers `SSH_AUTH_SOCK`/`DATABASE_URL`/`*_PRIVATE_KEY`/
   `KUBECONFIG`/etc. Env-strip is defense-in-depth; `run_bash` file/egress containment
   still requires `uap sandbox`.
8. **Escape hatches are env-gated by design** and the model is prevented from
   *persisting* them only by the (currently inert) self-protect enforcer. The intended
   list: `UAP_DELIVER_BYPASS=1`, `UAP_ENFORCE_DELIVERY=advisory|off`,
   `UAP_SELF_PROTECT_OFF=1`, `UAP_NO_WORKTREE`, `UAP_WORKDIR_SCOPE_OFF`,
   `UAP_SANDBOX_OFF=1`, `UAP_SANDBOX_ALLOW`. Treat all of these as operator-only.

## Related documents

- `architecture.md` — trust-boundary overview and process topology
- `flows.md` — where each check fires within a journey
- `variables.md` — the full env-var / secret inventory backing the escape hatches
