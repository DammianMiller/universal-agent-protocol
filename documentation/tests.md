# Test Coverage Map

Coverage for the security- and boundary-relevant rules in `permissions.md`, `flows.md`,
and `automation.md`. It maps each rule to the test that asserts it, the test file, and the
level (unit / integration / manual). Where a rule has no verifying test, that is called
out explicitly.

Test inventory: **210 vitest (`test/*.test.ts`)** + **30 Python
(`tools/agents/tests/test_*.py`)**. The TS suite runs on every PR via
`.github/workflows/deploy-verify.yml` (`npm test`). The 30 Python tests run in no CI
workflow — see the CI-gate section below; this is the most important gap, because the
entire runtime enforcement plane (self-protect, delivery-enforcement, sandbox tool-strip,
path containment) is Python and can regress silently.

## Coverage table

| Use case | Rule (doc) | Expected behavior (+ deny case) | Evidence | Type | Coverage |
|---|---|---|---|---|---|
| Self-protect blocks tamper | permissions §self-protect | Edit to `src/policies/`/`.uap.json`/`.policy-tools/`, `UAP_DELIVER_BYPASS=1` export, `rm` enforcer → **exit 2**; normal edit/bash → exit 0; `UAP_SELF_PROTECT_OFF=1` → allow | enforcer `enforcement_self_protect.py`; test `tools/agents/tests/test_enforcement_self_protect.py` | unit (py) | covered |
| Self-protect is *registered* | permissions §self-protect | `ensureSelfProtect()` attaches the enforcer to an executable_tools row, idempotent (no dup) | `deliver-defaults.ts`; test `test/cli/deliver-defaults.test.ts` | unit | covered |
| Self-protect actually *runs* after registration | permissions §self-protect | With the policy registered, `uap-policy-gate.sh` executes it and returns exit 2 on a tamper edit | hook `templates/hooks/uap-policy-gate.sh` | integration (deterministic) | **gap** — logic and registration are tested separately; the wiring that joins them is not |
| Delivery-enforcement blocks direct source edit | flows Flow 1; permissions matrix | Direct `src/*.ts` edit in block mode → exit 2 + `route:deliver`; exempt paths (`test/`,`docs/`,`policies/`) → allow | `delivery_enforcement.py`; tests `test/policies/delivery-enforcement.test.ts`, `tools/agents/tests/test_delivery_enforcement_worktree.py` | unit | covered |
| Worktree/workdir scope enforced | permissions matrix | Edit outside worktree/workdir → exit 2 | `test/policies/workdir-scope.test.ts`, `test/cli/git-enforcer-worktree.test.ts`, `test_workdir_scope_enforcer.py`, `test/worktree-enforcement.test.ts` | unit | covered |
| Applier protected-path boundary | permissions deliver plane | Writes to `.git`/`.uap`/CI dirs, lockfiles, gate configs/IaC, pre-existing tests → rejected; traversal/symlink-escape → rejected | `applier.ts`; tests `applier-hardening.test.ts`, `gate-config-protection.test.ts`, `protect-tests.test.ts`, `spec-imports.test.ts`, `applier.test.ts` | unit | covered |
| Agentic executor shares the same guard | permissions deliver plane | `write_file` refuses protected paths; `run_bash` snapshots+restores protected files it mutates | `agentic-executor.ts`; test `test/delivery/agentic-executor.test.ts` | unit | covered (`write_file` guard); **gap** — `run_bash` snapshot-restore assertion |
| Runtime integrity guard | flows Flow 2 step 5 | A gate run that mutates a protected file → result discarded, file restored | `integrity.ts`; test `test/delivery/integrity.test.ts` | unit | covered |
| Gate spawns strip secrets | flows Flow 2 step 4 | A spawned gate/entrypoint cannot see `*_API_KEY` env; `CI=true` set | `verifier-ladder.ts`, `execution-gate.ts`; tests `verifier-ladder.test.ts`, `execution-gate.test.ts` | unit | covered for names matching `/(API_KEY\|TOKEN\|SECRET\|PASSWORD\|CREDENTIAL)/i` |
| Gate strip covers real cred names | permissions §secret hygiene | `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `NPM_TOKEN` also stripped | `verifier-ladder.ts:sanitizedEnv` | unit | **gap** — no test asserts these names are stripped |
| Static server no traversal | permissions deliver plane | `..`, `%2f`, absolute, symlink-to-`/etc/passwd` requests → refused | `execution-gate.ts:startStaticServer`; test `execution-gate.test.ts` | unit | covered (confirm the encoded/symlink cases are asserted) |
| Self-authored gate not vacuous | flows Flow 2 | An authored `.uap-deliver/verify.sh` that passes on the unsolved repo → rejected & regenerated | `self-gate.ts`; test `test/delivery/self-gate.test.ts` | unit | covered |
| Self-gate script not model-writable mid-run | permissions §.uap-deliver | Model cannot overwrite `.uap-deliver/verify.sh` to make it vacuously pass | `applier.ts` PROTECTED_SEGMENTS (`.uap-deliver`) | unit | **gap** — no test asserts the protected segment |
| Context auto-size / rail fit | deliver convergence | Budget resolves env→cfg→preset; hard stop before overflow; epic split on exhaustion; churn breaker caps rejections; `--max-turns` hard cap | tests `context-budget.test.ts`, `convergence-loop.test.ts`, `acceptance-judge.test.ts`, `epic-controller.test.ts` | unit | covered |
| Acceptance judge evidence not starved | deliver convergence | Config/source files present in evidence even with large data files | `acceptance-judge.ts`; test `acceptance-judge.test.ts` (gatherEvidence cases) | unit | covered |
| Sandbox strips unreachable browser tools | flows Flow 4 | `X-Uap-Sandbox:1` → `mcp__claude-in-chrome__*` removed from tool list | `sandbox.ts`, proxy `_strip_sandbox_unreachable_tools`; tests `test/cli/sandbox-headers.test.ts`, `test_sandbox_tool_strip.py` | unit | covered |
| Sandbox refuses over-broad workdir | flows Flow 4 | `$HOME`/`/`/`/home` as workdir → refuse (exit) | `sandbox.ts:81-83` | unit | **gap** — no test asserts the guard |
| Proxy path containment | permissions proxy plane | Garbled tool-call path snapped back into workdir; no escape | `toolcall_path_normalizer.py`; tests `test_path_containment.py`, `test_path_normalizer_hardened.py` | unit (py) | covered |
| Proxy env loader precedence | variables | process env wins over `.uap/proxy.env` | `test_proxy_env_loader.py` | unit (py) | covered |
| Proxy `__local_only__` disables cloud | flows Flow 3; permissions §proxy | With the sentinel set, **no** model reaches api.anthropic.com | proxy `_should_passthrough_model` | integration (deterministic) | **gap** — mechanism unit-untested |
| Proxy unauth passthrough w/ server key | permissions §proxy | A no-credential request for a Claude model must **not** use the server `ANTHROPIC_API_KEY` fallback | proxy `_build_passthrough_headers` | integration (deterministic) | **gap** — untested |
| Dashboard rejects unauth policy mutation | permissions §dashboard | `POST /api/policy/:id/toggle` with no token → **rejected** | `dashboard/server.ts:201-255` | integration (deterministic) | **gap** — 8 dashboard test files, none assert authz |
| Dashboard vendor path traversal | permissions §dashboard | `/vendor/../..` → refused | test `test/dashboard-vendor-assets.test.ts` | unit | covered |
| Hands-free can't wedge | automation §2 | Stop-check honors `stop_hook_active`, gives up at maxBlocks/stagnation | `handsfree.ts`; test `test/delivery/handsfree.test.ts` | unit | covered |
| No autonomous push to default branch | automation | CI watcher refuses `master`/`main` push | `ci-watcher.ts`; test `test/delivery/ci-watcher.test.ts` | unit | covered |

## Well-covered surfaces

The security core is strongly pinned:

- **Enforcer logic** — self-protect, delivery-enforcement + worktree, workdir-scope, and
  git-worktree all have dedicated tests. The enforcers' *decisions* are well-pinned.
- **Applier boundary** — five test files cover protected segments, gate-config/IaC
  protection, pre-existing-test protection, and the spec oracle import graph. This is the
  best-tested security surface.
- **Deliver convergence** — context-autosize, acceptance-judge, epic-split, and the
  `--max-turns` cap are unit-covered across four files.
- **Gate secret-stripping** — proven by the "entrypoint throws iff it sees the secret"
  pattern in `verifier-ladder.test.ts` and `execution-gate.test.ts`.
- **Proxy Python** — path containment, env-loader precedence, sandbox tool-strip,
  streaming.

## Uncovered rules (verification gaps)

Grouped by the boundary they defend. Each entry names the smallest test that would pin the
rule.

**Enforcement wiring (highest value — this is the seam where a self-protect regression
would hide):**
- *`self-protect runs end-to-end`* — integration: seed a temp `policies.db`, run
  `ensureSelfProtect()`, then invoke `uap-policy-gate.sh` (or its dispatch logic) with a
  tamper edit payload; assert exit 2. Negative: a normal edit → exit 0. Enforcer logic and
  registration can both pass while the wiring that joins them is broken; only an end-to-end
  test catches that.

**Gate secret hygiene:**
- *`sanitizedEnv strips non-API_KEY creds`* — unit: assert `AWS_ACCESS_KEY_ID`,
  `DATABASE_URL`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `NPM_TOKEN` are removed from the spawned
  env. Negative: a benign var (`PATH`, `HOME`) survives.

**Dashboard authz:**
- *`policy-mutation POST requires the session token`* — deterministic integration: start
  the server, `POST /api/policy/<id>/toggle` with no token; assert rejection. Negative: a
  request carrying the token succeeds.
- *`policy POST is not cross-site forgeable`* — assert an `Origin`-mismatched request is
  rejected (CORS/CSRF).

**Proxy trust boundary:**
- *`__local_only__ blocks all passthrough`* — deterministic integration against a stub
  upstream: with the sentinel set, a Claude-model request never hits the Anthropic base.
  Negative: without it, a matching model does.
- *`no-credential passthrough is refused`* — assert a passthrough request with no client
  credential does **not** silently use the server key.

**Small guard gaps:**
- *`sandbox refuses $HOME/root workdir`* — unit on `sandbox.ts`'s over-broad-workdir guard.
- *`run_bash snapshot-restore`* — unit: a `run_bash` that mutates a protected file has it
  restored.
- *`.uap-deliver self-gate is protected`* — unit: model write to `.uap-deliver/verify.sh`
  is rejected by PROTECTED_SEGMENTS.

## Recommended CI gate

`deploy-verify.yml` runs build + typecheck + `npm test` on `pull_request`. Two changes make
it a real green-before-merge gate for the **security** layer:

1. **Add the Python enforcer/proxy suite to CI** (it currently runs nowhere). Suggested
   job:

```yaml
# .github/workflows/deploy-verify.yml  →  add alongside "Build & Test"
  enforcers:
    name: Policy Enforcers (Python)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - name: Run enforcer + proxy tests
        run: python -m unittest discover -s tools/agents/tests -p 'test_*.py' -v
```

2. **Use `vitest run` in CI**, not bare `vitest` (watch mode). Either change the `test`
   script to `vitest run` or add `test:ci`:

```json
"scripts": { "test:ci": "vitest run" }
```

and call `npm run test:ci` in the workflow.

3. **Branch protection on `main`:** require the `Build & Test` **and** the new
   `Policy Enforcers (Python)` status checks to pass before merge. Settings →
   Branches → add rule for `main` → *Require status checks to pass* → select both jobs.

Guarded-live coverage (a real llama backend, cloud passthrough, or a running dashboard
socket) stays opt-in and never blocks the default PR run.

## Gap ranking (by exposure)

1. **Python enforcer suite is in no CI gate.** All 30 tests — the entire runtime
   enforcement plane — can regress and merge green. *Exposes:* silent loss of self-protect,
   delivery-enforcement, workdir-scope, sandbox tool-strip. Highest priority (CI change
   above).
2. **No end-to-end test that a registered policy actually runs via the hook.** Logic and
   registration are tested in isolation; the join is not. *Exposes:* a future refactor of
   the hook SQL/dispatch silently disabling all enforcement.
3. **Dashboard policy-mutation has no authz test.** *Exposes:* the token guard regressing
   unnoticed, re-opening unauthenticated disable of security controls via CSRF or LAN.
4. **Proxy passthrough credential handling is unit-untested.** *Exposes:* an
   unauthenticated peer using the operator's cloud key / billing.
5. **Secret-strip regex completeness untested.** *Exposes:* a malicious gate/test script
   exfiltrating `AWS_*`/`DATABASE_URL`/`SSH_AUTH_SOCK` that survive the strip.
6. **`.uap-deliver/` self-gate writability, sandbox over-broad-workdir guard, run_bash
   restore** — small, each a one-test fix.

## Related documents

- `permissions.md` — the rules these tests defend
- `flows.md` — the journeys each integration test exercises
- `automation.md` — the agent output-contract limits under test
