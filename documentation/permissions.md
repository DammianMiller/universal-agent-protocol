# Permissions

UAP has **no user-account system and no role-based auth**. It is a single-operator local
tool: the "roles" that matter are *trust tiers* — who or what is issuing an operation —
and every check is **code-enforced** (there is no database-level enforcement anywhere;
"RLS" does not apply to this system). This document maps each tier to what it can
actually do, where the check lives, and which protections hold at each plane.

## Trust tiers (the de-facto roles)

| Tier | Who it is | Trust level |
|---|---|---|
| **Operator** | The human launching processes; owns the shell env, systemd units, and config files | Full trust — every escape hatch keys off launch-time env vars |
| **Agent model (hooked session)** | Claude Code / Factory / Cursor session with UAP hooks installed | Semi-trusted — tool calls mediated by PreToolUse/Stop hooks |
| **Agent model (sandboxed)** | Same, launched under `uap sandbox` (bubblewrap) | Least privilege — kernel-enforced read-only filesystem outside allow-listed holes |
| **Deliver executor model** | The model driven by `uap deliver` (blind or agentic executor) | Semi-trusted — mediated by the applier/agentic-executor protected-path logic, not by hooks |
| **Project scripts** | `npm test`, build scripts, anything a verification gate spawns | Untrusted-adjacent — runs arbitrary project code on the host |
| **LAN peer** | Any machine that can reach this host's bound ports | Reaches the unauthenticated local-model proxy and the dashboard read routes; dashboard mutations are token-gated |

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
markdown says. Of the 50 policies active in the DB, **17** have executable tools and
therefore enforce:
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
and is the **only** control that holds under `--dangerously-skip-permissions`, where hook
exit-2 denials are ignored. Network is deliberately **not** restricted (the agent must
reach the proxy at :4000). It refuses to sandbox an over-broad workdir (`$HOME`, `/`,
`/home`; :81-83). `UAP_SANDBOX_OFF=1` is the operator escape.

Sandboxed sessions additionally advertise themselves with the `X-Uap-Sandbox: 1` header
(appended to `ANTHROPIC_CUSTOM_HEADERS`, `sandbox.ts:30-39`); the proxy strips browser
MCP tools (`mcp__claude-in-chrome__*`, configurable via
`PROXY_SANDBOX_UNREACHABLE_PREFIXES`) from the tool list because the Chrome extension
socket is not bound into the namespace (`anthropic_proxy.py:4393, 9339`).

### Deliver plane — applier + agentic executor + integrity guard
`uap deliver` is not hook-mediated; it carries its own controls, sharing one source of
truth (`protectedWritePathReason`, `applier.ts:164`):

- **Protected segments** (`applier.ts:96-106`): `.git`, `.uap`, `.uap-deliver`, `.husky`,
  `.github`, `.gitlab`, `.circleci`, `node_modules` — blocked anywhere in a write path.
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
- **Secret hygiene for gates** (`verifier-ladder.ts:124-131`): every gate spawn, `run_bash`
  spawn, and self-gate spawn strips env vars matching
  `/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` plus
  `SSH_AUTH_SOCK`/`DATABASE_URL`/`*_PRIVATE_KEY`/`KUBECONFIG` and sets `CI=true`, so
  project scripts never inherit provider credentials. Env-stripping is defense-in-depth;
  `run_bash` file/egress containment still requires `uap sandbox`.

## Resource × operation × tier matrix

| Resource | Operation | Operator | Hooked model | Sandboxed model | Deliver executor | LAN peer |
|---|---|---|---|---|---|---|
| Source files (worktree) | write | ✅ | ✅ via `uap deliver` route; direct edit **blocked** by `delivery_enforcement` (block mode) | same + kernel-limited to workdir | ✅ (protected paths excluded) | — |
| Tests/spec files (pre-existing) | write | ✅ | blocked (Plane A test-gate) | blocked | **blocked** (applier + integrity) | — |
| Gate configs, lockfiles, CI dirs, IaC | write | ✅ | blocked for source-edit routes | blocked + kernel | **blocked** (applier) | — |
| `.uap/`, `policies.db`, hook scripts, `src/policies/` | write | ✅ | **blocked** by `enforcement_self_protect` (hooked) | kernel-blocked outside workdir | `.uap` segment blocked by applier | — |
| Files outside workdir | write | ✅ | hook-blocked (`workdir-scope`); under `--dangerously-skip-permissions` only the sandbox holds | **kernel-blocked** | n/a (applier is root-relative) | — |
| Local model inference (:4000) | use | ✅ | ✅ | ✅ (network not namespaced) | ✅ | **✅ unauthenticated** |
| Anthropic passthrough | use | ✅ (needs credential) | via proxy w/ credential | same | same | with a valid credential |
| Dashboard read (:3847) | read | ✅ | ✅ | ✅ | — | ✅ if `--host 0.0.0.0` |
| Dashboard policy toggle (:3847) | mutate | ✅ (holds session token) | ✅ (holds session token) | ✅ | — | **blocked without the session token** |
| Git commit / push / deploy | execute | ✅ | commit gated by worktree policies; deploy queue | same | **never direct** — only `--deploy` enqueues to the deploy batcher | — |
| Provider API keys | read | ✅ (env, proxy.env) | gates never inherit them (env stripping) | same | same | file perms only |

## Specific protections

Each control below is a live guarantee of the current system.

1. **Self-protect enforcement.** `enforcement_self_protect.py` blocks a hooked agent from
   editing the enforcement control surface — `src/policies/`, `policies/`, `.uap.json`,
   `.policy-tools/` — and from exporting bypass env vars such as `UAP_DELIVER_BYPASS=1`.
   `ensureSelfProtect()` attaches the enforcer to an executable_tools row at `setup`/`init`
   (`src/cli/deliver-defaults.ts`), idempotently, so Plane A runs it: the hook fires on
   `isActive=1` plus an executable_tools row (level-independent). `UAP_SELF_PROTECT_OFF=1`
   is the operator escape. This containment is complete because the enforcer has no
   model-reachable bypass and the dashboard toggle that could disable it is token-gated.

2. **Proxy trust boundary — `__local_only__`.** The proxy (:4000) is unauthenticated and
   binds `0.0.0.0`, so any LAN host can drive the local model. Cloud passthrough is
   governed by `ANTHROPIC_PASSTHROUGH_MODELS`: the sentinel value `__local_only__` removes
   the cloud path entirely, so no model request reaches api.anthropic.com. The IaC
   (`~/.config/uap/anthropic-proxy.env`) sets `__local_only__`, applied on proxy start.
   For LAN protection of the local-model surface, bind `127.0.0.1` or add a shared-secret
   header. `_should_passthrough_model` / `_build_passthrough_headers`
   (`anthropic_proxy.py`) govern the passthrough decision and header construction.

3. **Dashboard mutation auth.** `POST /api/policy/:id/{toggle,stage,level}` — the routes
   that disable and persist security controls — require an unguessable per-session token
   (`X-Uap-Dashboard-Token`; the same-origin UI receives it via server-side injection).
   Read routes stay open. The default bind is `localhost`.
   The token is only as good as its confinement, so three things hold it in place. The
   page carrying the token (`/`, `/index.html`) is served with **no** CORS headers, so a
   foreign origin cannot read it — API reads keep `Access-Control-Allow-Origin: *`, but
   they carry no credential. WebSocket upgrades require a same-origin `Origin` (WS is
   exempt from both SOP and CORS, and the snapshot stream would otherwise be readable by
   any page); clients that send no `Origin` — CLI, curl — still connect. A dashboard
   started as a ride-along of `uap proxy` does not echo the token to stdout, because its
   stdout is an append-only log file. `GET /health` is deliberately unauthenticated and
   returns only `{ok, service, port, root}`. Together these keep the self-protect
   enforcer from being disabled over the network (LAN or cross-site), including for the
   whole session the ride-along dashboard is up.

4. **Hook enforcement vs `--dangerously-skip-permissions`.** In that mode the harness
   ignores hook exit-2 denials, so the Plane A gate does not fire. The bwrap sandbox is the
   designed compensating control: the workdir boundary is real only when the agent is
   launched under `uap sandbox`.

5. **Enforcer registry.** Plane A runs the enforcers present in `.policy-tools/` and joined
   in the DB. Additional enforcer sources exist in `src/policies/enforcers/`
   (`adr_guard`, `bearer_lockdown`, `design_token_gate`, `expert_review_required`,
   `iac_plan_destruction_check`, `local_build_before_push`, `ship_loop_gate`,
   `task_required`, and a UUID-prefixed architecture-review) that are not part of the
   `.policy-tools/` DB join and therefore do not run in Plane A.

6. **Markdown scope vs enforced scope.** `policies/*.md` documents are Plane-B keyword
   sources and human-intent statements, not the runtime contract. The runtime scope comes
   from the enforcer code: `delivery_enforcement.py` gates only `SOURCE_EXTS` and exempts
   `test/`, `docs/`, `policies/`, and `src/policies/`, regardless of prose in
   `worktree-enforcement.md`.

7. **`.uap-deliver/` self-gate protection.** The self-authored acceptance gate
   (`.uap-deliver/verify.sh`) is protected on two channels: `.uap-deliver` is a protected
   segment (blocking the applier and `write_file`), and the gate script is in the runtime
   integrity snapshot (a `run_bash` mutation discards the turn and restores the file). A
   model cannot overwrite its own sole required gate to make it vacuously pass.

8. **Escape hatches are env-gated by design** and the self-protect enforcer prevents a
   model from *persisting* them. Treat all of these as operator-only:
   `UAP_DELIVER_BYPASS=1`, `UAP_ENFORCE_DELIVERY=advisory|off`, `UAP_SELF_PROTECT_OFF=1`,
   `UAP_NO_WORKTREE`, `UAP_WORKDIR_SCOPE_OFF`, `UAP_SANDBOX_OFF=1`, `UAP_SANDBOX_ALLOW`.

## Related documents

- `architecture.md` — trust-boundary overview and process topology
- `flows.md` — where each check fires within a journey
- `variables.md` — the full env-var / secret inventory backing the escape hatches
