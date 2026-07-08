# Test Coverage Map

Coverage for the security- and boundary-relevant rules in `permissions.md`, `flows.md`,
and `automation.md`. Status is honest: **existing** means a test in the repo asserts the
rule *today*; **proposed** means recommended but not yet written; **none** means the
documented rule has no verification at all.

Test inventory at time of writing: **210 vitest (`test/*.test.ts`)** + **30 Python
(`tools/agents/tests/test_*.py`)**. The TS suite runs on every PR via
`.github/workflows/deploy-verify.yml` (`npm test`). **The 30 Python tests run in no CI
workflow** — see the CI-gate finding below; that is the single most important gap, because
the entire runtime enforcement plane (self-protect, delivery-enforcement, sandbox
tool-strip, path containment) is Python and can regress silently.

## Coverage table

| Use case | Rule (doc) | Expected behavior (+ deny case) | Evidence | Type | Status |
|---|---|---|---|---|---|
| Self-protect blocks tamper | permissions Finding 1 | Edit to `src/policies/`/`.uap.json`/`.policy-tools/`, `UAP_DELIVER_BYPASS=1` export, `rm` enforcer → **exit 2**; normal edit/bash → exit 0; `UAP_SELF_PROTECT_OFF=1` → allow | enforcer `enforcement_self_protect.py`; test `tools/agents/tests/test_enforcement_self_protect.py` (9 cases) | unit (py) | **existing** |
| Self-protect is *registered* | permissions Finding 1 | `ensureSelfProtect()` attaches the enforcer to an executable_tools row, idempotent (no dup) | `deliver-defaults.ts`; test `test/cli/deliver-defaults.test.ts` (2 new cases) | unit | **existing** (v1.125.0) |
| Self-protect actually *runs* after registration | permissions Finding 1 | With the policy registered, `uap-policy-gate.sh` executes it and returns exit 2 on a tamper edit | hook `templates/hooks/uap-policy-gate.sh` | integration (deterministic) | **none** — logic + registration tested separately; the wiring that joins them is not |
| Delivery-enforcement blocks direct source edit | flows Flow 1; permissions matrix | Direct `src/*.ts` edit in block mode → exit 2 + `route:deliver`; exempt paths (`test/`,`docs/`,`policies/`) → allow | `delivery_enforcement.py`; tests `test/policies/delivery-enforcement.test.ts`, `tools/agents/tests/test_delivery_enforcement_worktree.py` | unit | **existing** |
| Worktree/workdir scope enforced | permissions matrix | Edit outside worktree/workdir → exit 2 | `test/policies/workdir-scope.test.ts`, `test/cli/git-enforcer-worktree.test.ts`, `test_workdir_scope_enforcer.py`, `test/worktree-enforcement.test.ts` | unit | **existing** |
| Applier protected-path boundary | permissions deliver plane | Writes to `.git`/`.uap`/CI dirs, lockfiles, gate configs/IaC, pre-existing tests → rejected; traversal/symlink-escape → rejected | `applier.ts`; tests `applier-hardening.test.ts`, `gate-config-protection.test.ts`, `protect-tests.test.ts`, `spec-imports.test.ts`, `applier.test.ts` | unit | **existing** |
| Agentic executor shares the same guard | permissions deliver plane | `write_file` refuses protected paths; `run_bash` snapshots+restores protected files it mutates | `agentic-executor.ts`; test `test/delivery/agentic-executor.test.ts` | unit | **existing** (guard); **none** for the run_bash snapshot-restore assertion |
| Runtime integrity guard | flows Flow 2 step 5 | A gate run that mutates a protected file → result discarded, file restored | `integrity.ts`; test `test/delivery/integrity.test.ts` | unit | **existing** |
| Gate spawns strip secrets | flows Flow 2 step 4 | A spawned gate/entrypoint cannot see `*_API_KEY` env; `CI=true` set | `verifier-ladder.ts`, `execution-gate.ts`; tests `verifier-ladder.test.ts`, `execution-gate.test.ts` | unit | **existing (partial)** — only names matching `/(API_KEY\|TOKEN\|SECRET\|PASSWORD\|CREDENTIAL)/i` |
| Gate strip covers real cred names | (audit finding) | `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `NPM_TOKEN` also stripped | `verifier-ladder.ts:sanitizedEnv` | unit | **none** — regex misses these; see audit |
| Static server no traversal | permissions deliver plane | `..`, `%2f`, absolute, symlink-to-`/etc/passwd` requests → refused | `execution-gate.ts:startStaticServer`; test `execution-gate.test.ts` | unit | **existing (partial)** — confirm the encoded/symlink cases are asserted |
| Self-authored gate not vacuous | flows Flow 2 | An authored `.uap-deliver/verify.sh` that passes on the unsolved repo → rejected & regenerated | `self-gate.ts`; test `test/delivery/self-gate.test.ts` | unit | **existing** |
| Self-gate script not model-writable mid-run | permissions Finding 7 | Model cannot overwrite `.uap-deliver/verify.sh` to make it vacuously pass | `applier.ts` PROTECTED_SEGMENTS (`.uap-deliver` absent) | unit | **none** — pending audit confirmation |
| Context auto-size / rail fit | (this session) | Budget resolves env→cfg→preset; hard stop before overflow; epic split on exhaustion; churn breaker caps rejections; `--max-turns` hard cap | tests `context-budget.test.ts`, `convergence-loop.test.ts`, `acceptance-judge.test.ts`, `epic-controller.test.ts` | unit | **existing** (v1.123–1.124) |
| Acceptance judge evidence not starved | (v1.124.1) | Config/source files present in evidence even with large data files | `acceptance-judge.ts`; test `acceptance-judge.test.ts` (gatherEvidence cases) | unit | **existing** |
| Sandbox strips unreachable browser tools | flows Flow 4 | `X-Uap-Sandbox:1` → `mcp__claude-in-chrome__*` removed from tool list | `sandbox.ts`, proxy `_strip_sandbox_unreachable_tools`; tests `test/cli/sandbox-headers.test.ts`, `test_sandbox_tool_strip.py` | unit | **existing** |
| Sandbox refuses over-broad workdir | flows Flow 4 | `$HOME`/`/`/`/home` as workdir → refuse (exit) | `sandbox.ts:81-83` | unit | **none** — no test asserts the guard |
| Proxy path containment | permissions proxy plane | Garbled tool-call path snapped back into workdir; no escape | `toolcall_path_normalizer.py`; tests `test_path_containment.py`, `test_path_normalizer_hardened.py` | unit (py) | **existing** |
| Proxy env loader precedence | variables | process env wins over `.uap/proxy.env` | `test_proxy_env_loader.py` | unit (py) | **existing** |
| Proxy `__local_only__` disables cloud | flows Flow 3; permissions Finding 2 | With sentinel set, **no** model reaches api.anthropic.com | proxy `_should_passthrough_model` | integration (deterministic) | **none** — mechanism unit-untested |
| Proxy unauth passthrough w/ server key | permissions Finding 2 (audit) | A no-credential request for a Claude model must **not** use the server `ANTHROPIC_API_KEY` fallback | proxy `_build_passthrough_headers` | integration (deterministic) | **none** |
| Dashboard rejects unauth policy mutation | permissions Finding 3 (audit) | `POST /api/policy/:id/toggle` with no credential → **rejected** (currently accepted) | `dashboard/server.ts:201-255` | integration (deterministic) | **none** — 8 dashboard test files, none assert authz |
| Dashboard vendor path traversal | permissions Finding 3 | `/vendor/../..` → refused | test `test/dashboard-vendor-assets.test.ts` | unit | **existing** |
| Hands-free can't wedge | automation §2 | Stop-check honors `stop_hook_active`, gives up at maxBlocks/stagnation | `handsfree.ts`; test `test/delivery/handsfree.test.ts` | unit | **existing** |
| No autonomous push to default branch | automation "don't exist" | CI watcher refuses `master`/`main` push | `ci-watcher.ts`; test `test/delivery/ci-watcher.test.ts` | unit | **existing** |

## Existing coverage (rules pinned today)

Strong, and notably including the security core:

- **Enforcer logic** — self-protect (9 cases), delivery-enforcement + worktree, workdir-scope, git-worktree: all have dedicated tests. The enforcers' *decisions* are well-pinned.
- **Applier boundary** — five test files cover protected segments, gate-config/IaC protection, pre-existing-test protection, and the spec oracle import graph. This is the best-tested security surface.
- **Deliver convergence** — the whole context-autosize / acceptance-judge / epic-split / `--max-turns` cap work from this session is unit-covered (28+ cases across 4 files).
- **Gate secret-stripping** — proven by the "entrypoint throws iff it sees the secret" pattern in two suites (real, clever tests).
- **Proxy Python** — path containment, env-loader precedence, sandbox tool-strip, streaming.

## Proposed tests (recommended, not yet existing)

Grouped by the boundary they defend. Prefer the smallest test that pins each rule.

**Enforcement wiring (highest value — closes the gap the self-protect bug lived in):**
- *`self-protect runs end-to-end`* — integration: seed a temp `policies.db`, run `ensureSelfProtect()`, then invoke `uap-policy-gate.sh` (or its dispatch logic) with a tamper edit payload; assert exit 2. Negative: a normal edit → exit 0. This is the test that would have *caught the inert-gate bug* — logic-tested + registration-tested still passed while the wiring was broken.

**Gate secret hygiene:**
- *`sanitizedEnv strips non-API_KEY creds`* — unit: assert `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `NPM_TOKEN` are removed from the spawned env. Negative: a benign var (`PATH`, `HOME`) survives. Drives the regex fix from the audit.

**Dashboard authz:**
- *`policy-mutation POST requires a credential`* — deterministic integration: start the server, `POST /api/policy/<id>/toggle` with no auth header; assert it is rejected (once a token/loopback-only guard exists). Negative: an authorized request succeeds. Pairs with the audit's dashboard fix.
- *`policy POST is not cross-site forgeable`* — assert an `Origin`-mismatched request is rejected (CORS/CSRF).

**Proxy trust boundary:**
- *`__local_only__ blocks all passthrough`* — deterministic integration against a stub upstream: with the sentinel set, a Claude-model request never hits the Anthropic base. Negative: without it, a matching model does.
- *`no-credential passthrough is refused`* — assert a passthrough request with no client credential does **not** silently use the server key (per the audit's finding).

**Small guard gaps:**
- *`sandbox refuses $HOME/root workdir`* — unit on `sandbox.ts`'s over-broad-workdir guard.
- *`run_bash snapshot-restore`* — unit: a `run_bash` that mutates a protected file has it restored.
- *`.uap-deliver self-gate is protected`* — unit: model write to `.uap-deliver/verify.sh` is rejected (after the audit's PROTECTED_SEGMENTS fix).

## Recommended CI gate

`deploy-verify.yml` already runs build + typecheck + `npm test` on `pull_request` — good. Two
changes make it a real green-before-merge gate for the **security** layer:

1. **Add the Python enforcer/proxy suite to CI** (it currently runs nowhere). Suggested job
   (not applied — for your approval):

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

Guarded-live (a real llama backend / cloud passthrough / a running dashboard socket) stays
opt-in and never blocks the default PR run.

## Gaps — documented but unverified (the backlog, ranked by exposure)

1. **Python enforcer suite is in no CI gate.** All 30 tests — the entire runtime
   enforcement plane — can regress and merge green. *Exposes:* silent loss of self-protect,
   delivery-enforcement, workdir-scope, sandbox tool-strip. **Fix first** (CI change above).
2. **No end-to-end test that a registered policy actually runs via the hook.** Logic and
   registration are tested in isolation; the join is not — exactly the seam the inert-gate
   bug lived in. *Exposes:* a future refactor of the hook SQL/dispatch silently disabling
   all enforcement.
3. **Dashboard policy-mutation has zero authz test** (and, per the audit, no authz at all).
   *Exposes:* unauthenticated disable of security controls via CSRF or LAN.
4. **Proxy passthrough credential handling is unit-untested.** *Exposes:* an unauthenticated
   peer using the operator's cloud key / billing (audit Finding).
5. **Secret-strip regex completeness untested.** *Exposes:* a malicious gate/test script
   exfiltrating `AWS_*`/`DATABASE_URL`/`SSH_AUTH_SOCK` that survive the strip.
6. **`.uap-deliver/` self-gate writability, sandbox over-broad-workdir guard, run_bash
   restore** — small, each a one-test fix.

## Related documents

- `permissions.md` — the rules and findings these tests defend
- `flows.md` — the journeys each integration test exercises
- `automation.md` — the agent output-contract limits under test
