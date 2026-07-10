# Changelog

## v1.135.1 (2026-07-10)

- fix(dashboard): self-diagnosing SQLite health — a missing/incompatible better-sqlite3 native binding (e.g. a global `npm i -g` done with --ignore-scripts, or a Node ABI bump) made every DB-backed panel silently read empty. getDashboardData now probes the binding and exposes a `health` field; dash serve prints a loud remediation warning at startup and the UI shows a fixed banner instead of a dead-looking dashboard.

## v1.135.0 (2026-07-10)

- feat(dashboard): tabbed console — Overview (aggregate KPIs + live charts + drill-down) plus Tasks & Epics, Agents & Sessions, Orchestration, Deliver, Policies, Models, Memory tabs
- feat(dashboard): full lifecycle management from the UI — create/update/close/delete tasks, advance/reset epic ledger, orchestrator on/off/auto, launch/cancel/resume deliver runs, deregister/clean agents (all behind the mutation-token gate, destructive actions confirmed)
- feat(deliver): cooperative cancel — per-turn stop-file poll in the convergence loop; deliver stamps its pid and marks a run interrupted on stop; run-state gains listRuns() + stop-file helpers; cancel is authoritative for orphaned runs
- feat(dashboard): per-agent/session drill-down drawers; modular web/dash/{core,tabs}.js + styles.css served under /dash/ (no-store for app code)

## v1.134.0 (2026-07-10)

- feat(setup): custom/expert config profile — a settings registry, `uap config`, and policy recommendations
- feat(proxy): compaction forcing — scale count_tokens so clients compact before the rail


## v1.133.2 (2026-07-10)

- fix(dashboard): bind ephemeral port in tests to kill EADDRINUSE flake


## v1.133.1 (2026-07-10)

- fix(hooks): stop the fresh-install Claude Code Stop-hook infinite loop


## v1.133.0 (2026-07-10)

- feat(bench): built-in mini-swe-agent adapter for paired uplift A/B
- docs: two-agent UAP walkthrough + SWE-bench Pro paired-uplift bench config
- feat: single-prompt epic missions — write-time compile feedback, zero-diff acceptance, gate integrity, advisory MCP caps
- fix: never bait the executor with optional-gate failure tails
- fix: pytest integration rung — vacuous pass on exit 5, --no-cov with pytest-cov
- fix: cargo gates in polyglot repos, dup-target latch, local-only pin survival


## v1.130.2 (2026-07-08)

- fix(policies): resolve built-in policy schema/enforcer dirs relative to the INSTALLED PACKAGE (dist/cli -> pkg root), not process.cwd(). A globally-installed uap found ZERO built-in policies when run from any project other than this repo, so 'uap policy install <name>' failed and 'uap policy matrix' showed 0 available. Verified: matrix lists all 33 built-ins (incl. the pay2u pack) from a fresh dir.


## v1.130.1 (2026-07-08)

- feat(policies): pay2u policy pack (pay2u-architecture-rules/quick-reference/enforcement-hooks) as an opt-in advisory example pack, selectable in the setup policy matrix and installable individually; new `uap policy matrix` lists ALL policies (built-in + installed) with status/level/stage/source and the toggle/adjust commands. Also fixed 3 pre-existing built-in schemas with out-of-enum categories (adr-guard/merge-deploy-monitor-verify/ship-loop-gate) that crash getAllPolicies() once installed; a new test validates the whole schema set.


## v1.130.0 (2026-07-08)

- test(dashboard): fix SSE partial-frame parsing + load-tolerant timeouts
- feat(dashboard): task board shows epic/story groupings and hierarchy
- fix(proxy): enforce local-only passthrough default in the ExecStart script


## v1.129.5 (2026-07-08)

- fix(proxy): enforce the local-only passthrough DEFAULT in the ExecStart continuity script (empty/unset ANTHROPIC_PASSTHROUGH_MODELS fails SAFE to __local_only__). A systemd Environment= pin does NOT hold — EnvironmentFile= overrides Environment= — and the env file keeps drifting to empty via routing/setup; the script export runs after systemd and wins. Explicit non-empty (cloud) values preserved. Verified: runtime __local_only__ with an empty env file.

## v1.129.4 (2026-07-08)

- fix(proxy): preserve an operator __local_only__ pin against routing/setup rewrites


## v1.129.3 (2026-07-08)

- fix(proxy): honor an operator LOCAL-ONLY pin. `uap model routing use <cloud-preset>` (and setup) regenerated ANTHROPIC_PASSTHROUGH_MODELS to empty, silently re-enabling api.anthropic.com passthrough and repeatedly clobbering an operator __local_only__ lockdown. The routing writer now PRESERVES an existing __local_only__ pin and tells the operator how to override (--allow-passthrough / UAP_ALLOW_PROXY_PASSTHROUGH=1). New readProxyEnvVar() helper reads the current pin.

- fix(proxy): real tool-turn output tokens + dashboard live-feed for plain sessions

## v1.129.2 (2026-07-08)

- fix(dashboard): record telemetry on the streaming path + configurable refresh interval
- fix(models): point qwen preset endpoints at 127.0.0.1:4000 (loopback)


## v1.129.1 (2026-07-08)

- fix(models): point qwen35-a3b/qwen36-a3b preset endpoints at 127.0.0.1:4000 (were 192.168.1.165:4000). After the proxy was bound loopback-only, the LAN-IP endpoint refused connections, so uap deliver/agentic tooling could not reach the model backend and sessions spiralled into backend-debugging loops. All consumers are on-host; loopback is correct.

## v1.129.0 (2026-07-08)

- fix(security): extend the runtime integrity snapshot to gate-config files (audit X5). The applier blocks the model WRITING package.json/tsconfig/vitest.config/etc., but run_bash bypasses the applier, so `run_bash("npm pkg set scripts.test=exit 0")` could rig the gate uncaught. deliver now snapshots existing gate-config + package/lockfiles (new applier.listGateConfigFiles, bounded shallow scan skipping node_modules/.git) alongside the self-gate script; any a gate run mutates is restored and the turn discarded. Gated on --protect-tests (on by default).


## v1.128.3 (2026-07-08)

- fix(delivery): snapshot follow-ups — secret exclusion, typed result, host-aware reaper
- ci: complete the enforcer job's Python deps (fastapi, uvicorn)
- ci: install httpx+openai for the Python enforcer job (red since it landed)


## v1.128.2 (2026-07-08)

- fix(policies): schema-diff-gate self-deadlock + marker table/timezone; delivery-enforcement fall-through returns


## v1.128.1 (2026-07-08)

- fix(security): audit hardening round 2 — proxy bind/auth, hook fail-closed, sandboxed run_bash, CI enforcer gate


## v1.128.0 (2026-07-08)

- fix(security): four audit hardening changes. (1) Proxy binds **127.0.0.1 by default** (was 0.0.0.0 unauthenticated); optional shared secret PROXY_AUTH_TOKEN (X-Uap-Proxy-Token / Authorization: Bearer, constant-time compare, /health+/v1/models open) for shared-LAN-service use. (2) policy-gate hook FAILS CLOSED for the enforcement control surface: an op touching policy DB/enforcers/.uap.json/proxy-env/hook-scripts (or a bypass/relax flag) is BLOCKED whenever self-protect cannot run (no DB, no sqlite3, missing/errored enforcer, or not registered) — normal ops still fail open so a broken enforcer never wedges all work. (3) agentic run_bash is DISABLED unless kernel-contained (uap sandbox → UAP_SANDBOX_ACTIVE=1, auto-detected) or explicitly allowed (--allow-bash / UAP_DELIVER_ALLOW_BASH=1) — an unsandboxed shell isn't contained to the workdir. (4) CI now runs the Python security-enforcer suite (npm run test:enforcers, 65 tests) as a job in deploy-verify.yml, and uses vitest run (test:ci). NOTE for shared-LAN deployments: set PROXY_HOST=127.0.0.1 OR add PROXY_AUTH_TOKEN + update clients.

## v1.127.2 (2026-07-08)

- chore: bump version to 1.127.1
- fix(delivery): harden --keep-best snapshots (tmpfs exhaustion, leaks, restore safety)
- docs: reverse-engineered documentation set + security audit report + fixes sync
- fix(security): authenticate dashboard policy mutations (audit D1 — keystone)


## v1.127.1 (2026-07-08)

- fix(delivery): harden --keep-best snapshots (tmpfs exhaustion, leaks, restore safety)
- docs: reverse-engineered documentation set + security audit report + fixes sync
- fix(security): authenticate dashboard policy mutations (audit D1 — keystone)

## v1.127.0 (2026-07-08)

- fix(security): authenticate dashboard policy mutations (audit D1 — the keystone). POST /api/policy/:id/{toggle,stage,level} disable+persist security controls (delivery-enforcement, self-protect) but had NO auth and CORS , so any LAN host (--host 0.0.0.0) or any web page the operator visited could neutralize enforcement — undoing the v1.125.0 self-protect registration with a single request. Now every mutation requires an unguessable per-session token in the X-Uap-Dashboard-Token header (override UAP_DASHBOARD_TOKEN, else random per boot, printed to the operator console). The same-origin dashboard UI gets it via server-side injection into the served page; a cross-origin page cannot read it and cannot forge the custom header on a simple request. Read routes stay open (localhost). Also (D1b) the /vendor/* static guard now uses a trailing-separator compare so sibling  dirs are not served.

## v1.126.0 (2026-07-08)

- fix(security): deliver-plane hardening from the static audit. (X2/X2b) The agentic executor's run_bash and the self-gate authoring/validation spawns now use the shared, secret-stripped env (previously ran with the full host env → a prompt-injected task could exfiltrate provider/host creds); the strip regex is broadened past API_KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL to also catch SSH_AUTH_SOCK, DATABASE_URL/*_URI, *_PRIVATE_KEY, KUBECONFIG, SESSION/COOKIE, DSN, SA_KEY. Secret-strip is now one module (was duplicated in verifier-ladder + execution-gate). (X1) .uap-deliver is a protected applier segment and the self-authored gate script is added to the runtime integrity snapshot, so a model can no longer overwrite its own acceptance gate to exit 0 (via write_file OR run_bash). Env-strip is defense-in-depth, not containment — file-based creds and egress still require uap sandbox.

## v1.125.0 (2026-07-08)

- fix(security): register the enforcement-self-protect enforcer at setup/init. It shipped as source + a policy doc but was never attached to an executable_tools row, so the runtime policy-gate hook never ran it — the gate was documented as non-disableable but was inert, and since delivery-enforcement exempts src/policies/, nothing stopped an agent editing the enforcement control surface (policy DB tooling, enforcers, .uap.json, proxy env, gate hook scripts). ensureSelfProtect() now attaches it idempotently (find-by-name, no duplicate rows) alongside ensureDeliveryEnforcement. Verified: enforcer blocks the 4 tamper paths, allows normal edits/bash, honors UAP_SELF_PROTECT_OFF=1.

## v1.124.1 (2026-07-08)

- fix(deliver): acceptance-judge evidence starvation — gatherEvidence walked directories alphabetically and let big flat data files (e.g. data/*.txt at 20K chars each) consume the whole 60K evidence budget, so the judge never saw package.json/src and correctly reported every requirement "not visible" (the real cause of judge-rejects-green-turns churn; the local qwen judge was fine). Evidence is now priority-ordered (configs+source > tests/json > docs/data), candidates are pooled before the file-count cap, and data files contribute a 1.5K head only. Secondary-mode judging also receives the objective-gates-passed fact as runtime evidence. Live probe: green project 0.00→1.00 on real specs; missing-implementation control still rejects at 0.00.

## v1.124.0 (2026-07-08)

- fix(deliver): acceptance-judge churn breaker — the secondary judge (objective gates green) can reject only N consecutive turns per spec (UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT, default 2) before the gates win; epic mode now grades the epic GOAL (+criteria) instead of the full process prompt whose unverifiable instructions caused perpetual rejections.
- fix(deliver): explicit --max-turns is a hard cap — the CLI records the option source, mirrors an explicit value into maxTurnsCeiling, and the loop now clamps escalation raiseMaxTurns to the ceiling ALWAYS (previously uncapped without untilDelivered), so neither default-on until-delivered nor auto-escalation can exceed an operator-set turn budget.

## v1.123.2 (2026-07-08)

- fix(deliver): budget-split sub-epics are no longer dep-chained — later pieces run despite an earlier partial failure (each is a fresh session over accumulated repo state), and a green FINAL piece counts the parent epic as delivered (earlier pieces often fail gates only because the whole was not assembled yet).

## v1.123.1 (2026-07-08)

- fix(deliver): propagate `[context-budget]` to the epic split path. The epic runner's failure summary is goal-based, so the executor's budget marker never reached the controller's split check (found in live verification; unit tests stubbed the boundary). ConvergenceLoop now tags `IterationRecord.budgetStopped` and the epic runner appends the marker to failed-run summaries when any turn was budget-stopped.

## v1.123.0 (2026-07-08)

- feat(deliver): context auto-size — epics/sessions sized to the serving rail (on by default). Session token budget resolves env → `.uap.json` deliver.sessionTokenBudget → model preset `modelContextBudget` (qwen presets → 180000, the 180k/rail llama serving window), × 0.7 working fraction (stays under the proxy prune threshold). Epic planner is told the per-session budget; the agentic executor hard-stops before an over-budget round (`[context-budget]` marker); the epic controller re-plans a budget-exhausted epic into sub-epics (one level). Epics now auto-enable for ANY complex mission (was: complex AND ≥1200 chars). Disable: `UAP_DELIVER_AUTOSIZE=0` / `deliver.autoSizeEpics=false`.

## v1.122.1 (2026-07-08)

- fix(dashboard): address review — advance SSE watermark unconditionally + 2s telemetry busy_timeout


## v1.122.0 (2026-07-08)

- feat(dashboard): wire Live Events cross-process + de-fabricate session panels; quiet sandbox log


## v1.121.0 (2026-07-07)

- feat(setup): add Maximum/Recommended/Minimal setup profiles
- chore: bump version to 1.119.4
- fix(sandbox): strip unreachable browser MCP tools from sandboxed sessions


## v1.120.0 (2026-07-07)

- feat(proxy): reference-counted, session-scoped proxy lifecycle via hooks
## v1.119.4 (2026-07-07)

- fix(sandbox): strip unreachable browser MCP tools from sandboxed sessions


## v1.119.3 (2026-07-07)

- fix(routing): clear stale toolCalls.modelProfile pin on `model routing use`
- chore: bump version to 1.119.1
- fix(proxy): reattach messages list in STUCK-BREAK injector when empty


## v1.119.2 (2026-07-07)

- chore: bump version to 1.119.1
- chore: bump version to 1.118.3
- fix(proxy): break RECON read-forever deadlock (proactive gate + firm-tier release)


## v1.119.1 (2026-07-07)

- chore: bump version to 1.118.3
- fix(proxy): break RECON read-forever deadlock (proactive gate + firm-tier release)


## v1.119.0 (2026-07-07)

- feat(proxy,handsfree): break deferral/plan-capitulation stalls for hands-free builds


## v1.118.2 (2026-07-07)

- fix(proxy): keep the exploration escape hatch available during cycle-break


## v1.118.1 (2026-07-07)

- refactor(tool-calls): make standalone `uap-tool-calls setup` fully automatic


## v1.118.0 (2026-07-07)

- feat(models): auto-switch tool-call profile from model routing


## v1.117.0 (2026-07-07)

- feat(dashboard): persist compression + performance panels to a cross-process store (telemetry.db, WAL); fix comp-calls fixed-0; shared computePercentiles


## v1.115.0 (2026-07-06)

- chore: bump version to 1.112.0
- feat(routing): wire proxy passthrough when a routing preset is applied


## v1.113.0 (2026-07-06)

- fix(dashboard): de-fabricate model panel via raw config; wire routing auto-activation into setup


## v1.111.3 (2026-07-06)

- fix(hooks): prevent SIGPIPE crash in Stop hook completion gate


## v1.111.2 (2026-07-06)

- fix(dashboard): de-fabricate session/model panels + fix proxy telemetry schema


## v1.111.1 (2026-07-06)

- perf(dashboard): cache `rtk gain` so refreshes drop ~2.8s -> ~10ms
- feat(proxy): add Sonnet 5 model support + active discrimination


## v1.111.0 (2026-07-06)

- feat(proxy): per-project routing/cost telemetry so dashboards see proxy model calls


## v1.110.0 (2026-07-06)

- feat(dashboard): configurable bind host + cross-process SSE live push + honest empty-analytics
- revert(claude-md): restore SESSION START block (lossy trim broke compliance gate)
- test: give policy-gate fixture a .git so the worktree guard engages
- fix: drop stray agents/docker-compose.yml duplicate (D10 guard; canonical is tools/agents/docker-compose.qdrant.yml)
- chore(harness): sync integration hooks/gates/policies; untrack secret-bearing settings.local.json


## v1.109.1 (2026-07-06)

- fix(dashboard): render idle/unmeasured influences explicitly, not a $0


## v1.109.0 (2026-07-06)

- feat(self-harness): close the loop — `uap self-harness run` + real paired-bench validator


## v1.108.1 (2026-07-06)

- docs: orchestrator + hands-free persistence + dashboard analytics (automagic)
- fix(policies): cluster-routing gates Bash commands only + strips heredocs (from pay2u)


## v1.108.0 (2026-07-05)

- fix(policies): cluster-routing scoped to Bash commands only + heredoc bodies stripped before pattern-matching (ported from pay2u) — file writes that merely mention cluster product names no longer trip the gate


## v1.108.0 (2026-07-05)

- feat(dashboard): real per-influence token savings + orchestration hierarchy


## v1.107.0 (2026-07-05)

- feat(policies): workdir-scope allows ~/.claude/projects (Claude Code auto-memory/session storage) — blocking it silently broke agent memory recording
- feat(policies): four new built-in policies ported from pay2u — adr-guard (ADR-embedded rule blocks gate writes), bearer-lockdown (cookie-only-frontend invariants), local-build-before-push (Docker compile gate before push/PR), ship-loop-gate (task completion requires merged/deployed/monitored/verified evidence)


## v1.106.0 (2026-07-05)

- feat(handsfree): full automation — auto-seed ledger from plan + auto-resume


## v1.105.0 (2026-07-05)

- feat(handsfree): Fable-parity hands-free persistence for ANY model (A+B+C+D)


## v1.104.2 (2026-07-05)

- fix(hooks): honor stop_hook_active in stop.sh so it can't wedge the agent


## v1.104.1 (2026-07-04)

- fix(dashboard): ship web/ + vendor uPlot locally so dash serve is fully wired


## v1.104.0 (2026-07-04)

- feat(deliver): epic controller — loop massive missions as fresh-session epics


## v1.103.0 (2026-07-04)

- test: raise timeout on heavy barrel-import tests to fix load flake
- feat(deliver): wire orchestrator memory in/out, re-planning feed, tunable phase cap
- chore: bump version to 1.102.0
- feat(cli): auto-on deliver orchestrator + on/off toggle commands


## v1.102.0 (2026-07-04)

- feat(cli): auto-on deliver orchestrator + on/off toggle commands


## v1.101.0 (2026-07-04)

- feat(delivery): P3 design store + P4 verified interface registry + P5 re-planning + P6 context governor


## v1.100.0 (2026-07-04)

- feat(deliver): complexity-tier model routing — pick the executor model by task complexity


## v1.99.0 (2026-07-04)

- feat(models): per-complexity model routing tiers — granular cost/speed control, coherent with lifecycle roles


## v1.98.1 (2026-07-04)

- fix(bench): lazy budget parity + track the real-gate-brutal suite in git


## v1.98.0 (2026-07-04)

- feat(deliver,bench,proxy,visual): measured-performance uplift — lazy-UAP, JSON-verdict grammar, thin-gate thickening, DAG phases, visual targets + vision judge, bounded bench prompts


## v1.97.0 (2026-07-03)

- feat(verify,deliver): visual gate — verify the RENDERED artifact behaves and looks right, not just that it loads


## v1.96.6 (2026-07-03)

- fix(proxy): no-tool thinking floor — evaluator verdicts were consumed by Qwen's mandatory <think>


## v1.96.5 (2026-07-03)

- fix(proxy): recon-convergence must count OpenAI-style tool-loop writes (write_file/edit_file/save_file)


## v1.96.4 (2026-07-03)

- fix(models): long HTTP timeouts + transient retry for model calls — undici's 300s headersTimeout was killing long local-model turns


## v1.96.3 (2026-07-03)

- fix(deliver): land the CLI-side agentic explorer guard (single-candidate turns + skip ideation)


## v1.96.2 (2026-07-03)

- fix(deliver): agentic runs never use the explorer — candidates require the file-block applier


## v1.96.1 (2026-07-03)

- fix(deliver): ideation seeds always generate — use the blind executor (agentic runs silently got static defaults) + retry transient empty completions


## v1.96.0 (2026-07-03)

- feat(delivery): close the self-improvement loop — mined-weakness prompt feedback, escalation-aware resume, parallel worktree exploration, trace rotation + beads sync


## v1.95.0 (2026-07-03)

- test(state): cover the no-scaffold guard for the state manifest
- feat(delivery): fable-grade orchestration — durable runs, decomposition, always-on self-improvement (P1–P5)


## v1.94.0 (2026-07-02)

- fix(proxy): resolve the single-oversized-message context-overflow wedge. Claude Code's auto-compact sends a `<transcript>` as ONE message that can exceed the whole context window; the pruner reduces context by *dropping* messages, so with one giant undroppable message it never converged and thrashed (prune → still >100% → retry, observed live at 105–115% util with rate climbing). The pruner's existing content-truncation only handled `tool_result` blocks — a giant *user/text* message was left intact. New `_truncate_oversized_message_content` truncates the largest content in-place (plain-string / `text` / `tool_result`, head+tail keep around a marker) so pruning always converges, and the `len(messages) <= 4` early-return now truncates instead of bailing when a few-message request still exceeds the window.
- feat(proxy): implement `POST /v1/messages/count_tokens` (was 404). Returns `{"input_tokens": N}` using the same `estimate_total_tokens` accounting the pruner uses, so Claude Code can measure against the real window and size its auto-compact input to fit — preventing the oversized-transcript request in the first place.
- test: 6 new cases (oversized string/text/tool_result truncation, prune convergence on a transcript larger than the window, count_tokens value + invalid-JSON 400). Fixed `test_prune_conversation_accepts_keep_last` to deepcopy its body (the two calls shared message objects via a shallow copy; in-place text truncation now exposes that).

## v1.93.1 (2026-07-02)

- chore: bump version to 1.91.1
- docs: reframe all documentation around the software-delivery pipeline (friendly, benefit-first)


## v1.93.0 (2026-07-02)

- feat(setup): make the 2 routing options pickable in the guided wizard


## v1.92.0 (2026-07-02)

- feat(models,proxy): 2 named routing options + Claude Max OAuth passthrough


## v1.91.0 (2026-07-01)

- feat(setup): guide setup through ALL features (recipes/escalation, delivery, concurrency, collaboration, design, reactor)


## v1.90.0 (2026-06-30)

- feat(proxy): unblock proxied recipes — no-tool empty-output guard + distinct-judge gating


## v1.89.0 (2026-06-30)

- feat(proxy): Ratings + ReMoM recipes (+ Workflow = deliver), completing the looper set


## v1.88.0 (2026-06-30)

- feat(reactor,proxy): cross-process recipe signals — proxy consumes the reactor's actual routeResult


## v1.87.0 (2026-06-30)

- feat(proxy): task-shaped recipe selection from reactor-aligned signals


## v1.86.0 (2026-06-30)

- feat(proxy): serving-layer recipe runtime — selector + Fusion + gate-as-confidence (#2,#3,#5)


## v1.85.0 (2026-06-30)

- feat(proxy): serving-layer confidence escalation (vLLM "Confidence" recipe)


## v1.84.1 (2026-06-30)

- perf(proxy): cache anthropic->openai tool conversion per session (A3)


## v1.84.0 (2026-06-30)

- feat(policy): UAP_DELIVER_LOCAL_MODE — route local sessions through deliver (verified) or advisory


## v1.83.0 (2026-06-30)

- fix(policy,proxy): resolve recon-loop deadlock for plain local sessions (#1+#2)


## v1.82.0 (2026-06-30)

- fix(policy,proxy): resolve worktree-creation loop on non-git projects (R1+R3+R4)


## v1.81.0 (2026-06-29)

- feat(deliver): separate generator from evaluator (loop-engineering rule #1)


## v1.80.0 (2026-06-29)

- feat(hooks): R1 follow-up — harness consumes route:deliver (deliver-autoroute)


## v1.79.0 (2026-06-29)

- feat(policies): enforcement self-protection (R2) + deliver routing signal (R1)


## v1.78.0 (2026-06-29)

- feat(proxy,deliver,reactor): stream-passthrough opt-in, tiered acceptance, reactor false-positive fix


## v1.77.0 (2026-06-29)

- feat(proxy,reactor): coordination-loop ban + deliver-routing guidance for local models


## v1.76.6 (2026-06-28)

- feat(proxy): streaming keep-alive heartbeat for the guarded-non-stream path (`PROXY_STREAM_HEARTBEAT_SECS`, default `0`=off). That path buffers the ENTIRE upstream generation before emitting any SSE bytes, so a long generation (e.g. a 28k-token runaway taking ~14 min at depth-slowed decode) sends the client nothing for the whole wait and the client's streaming idle-timeout fires → "API Error". When > 0, the proxy emits an immediate `message_start` then periodic `ping` events while it awaits+guards the buffered response, keeping the connection alive; the buffered content streams once ready. Guarded-path error returns become SSE `error` events (the stream has committed to HTTP 200). Default OFF preserves prior behavior exactly.

## v1.76.5 (2026-06-28)

- fix(deliver): normalize garbled tool-call paths in the agentic executor
- feat(proxy): session-admission control to cap distinct hot sessions to slots (#299)


## v1.76.4 (2026-06-27)

- feat(proxy): session-admission control (`PROXY_SESSION_ADMISSION=on`). Caps the number of DISTINCT "hot" sessions holding an upstream slot to `PROXY_SESSION_ADMISSION_LIMIT` (default = `PROXY_CONCURRENCY_LIMIT` = llama `--parallel` slots). The per-request semaphore limits concurrent *requests*; this limits concurrent *sessions* — a new session over the limit queues until an admitted session goes idle (`PROXY_SESSION_ADMISSION_IDLE_TTL`, default 90s) and is pruned, instead of evicting a hot session. On a multi-slot SSM/Mamba model (no partial-KV restore) every eviction is a full reprocess; admission prevents the >slots-sessions thrash. Sticky across a session's turns; graceful-degrades (force-admit, evict LRU) after `PROXY_SESSION_ADMISSION_WAIT_TIMEOUT` (default 300s). Default OFF.


## v1.76.3 (2026-06-27)

- fix(tool-calls): route top_k/min_p/grammar via extra_body (test was 0/6)
- fix(proxy): treat unclosed <think> as truncated reasoning, not malformed tool payload (#297)


## v1.76.2 (2026-06-27)

- fix(proxy): don't classify an UNCLOSED `<think>` block as a malformed tool payload. Under llama `--reasoning auto`, Qwen3.6 often runs out of token budget mid-reasoning, emitting `<think> …meta-tool talk… args=` with no `</think>`. The malformed-pseudo-tool detector only stripped *balanced* `<think>…</think>`, so the meta-tool talk inside the unclosed block tripped the structural-marker branch → false `malformed_payload` rejections that stalled agentic builds (~11 false rejections in 40 min stalling an Octopus Invaders generation). `_looks_malformed_tool_payload` now also strips a trailing unclosed `<think>` (keeping any text before the opener so a genuine malformed payload there is still detected).

## v1.76.1 (2026-06-27)

- fix(concurrency): deterministic backpressure cooldown (unflake CI)


## v1.76.0 (2026-06-27)

- feat(concurrency): route all model calls through the slot lease + 429 hooks


## v1.75.0 (2026-06-27)

- feat(concurrency): adaptive backpressure (AIMD) on model slots


## v1.74.0 (2026-06-27)

- feat(concurrency): cross-process model-slot lease (semaphore)


## v1.73.0 (2026-06-27)

- feat(concurrency): model-slot budget to avoid exhausting inference slots
- fix(deliver): route qwen35-a3b preset through the proxy (:4000) to strip <think> from authored gates (#291)
- feat(policy): add iac-plan-destruction-check enforcer (PR-file-aware merge gate) (#287)


## v1.72.1 (2026-06-26)

- fix(deliver): route the `qwen35-a3b` preset through the anthropic-proxy (:4000) instead of llama (:8080) directly. Hitting llama raw under `--reasoning auto` let Qwen `<think>` blocks leak into `uap deliver`-authored gate scripts, producing an unrunnable `verify.sh` (unclosed `<think>` → bash syntax error) and an infinite verify loop. The proxy strips `<think>` and applies tool/finalize guardrails on the OpenAI path too.

## v1.72.0 (2026-06-26)

- feat(coord): auto-activate collaboration + confirm heavy actions


## v1.71.0 (2026-06-26)

- feat(challenge): `uap challenge run --agents N` orchestrator


## v1.70.0 (2026-06-26)

- feat(challenge): open multi-agent challenge mode (capstone)


## v1.69.0 (2026-06-26)

- feat(coord): relay handoff + quota staging with credit
- docs(changelog): 1.64.5 — delivery-enforcement worktree bypass fix
- fix(policies): delivery-enforcement — `.worktrees/` no longer bypasses deliver


## v1.68.0 (2026-06-26)

- feat(coord): findings ledger + peer flagging (integrity & reversals)

## v1.67.1 (2026-06-26)

- fix(policies): **delivery-enforcement — `.worktrees/` no longer bypasses `uap deliver`**. `.worktrees/` was an unconditional exempt prefix, so the model could sidestep the deliver pipeline entirely by creating a worktree directory and writing source straight into it — observed live: 24 source files written to `.worktrees/001-space-shooter/` with no deliver run, so the verification gates were never invoked. The `UAP_DELIVER_ACTIVE=1` escape hatch was checked *after* the blanket exemption, so it never mattered. Dropped `.worktrees/` from `EXEMPT_PREFIXES`: a real `uap deliver` run writes into a worktree but sets `UAP_DELIVER_ACTIVE=1` (honored below), so legitimate deliver edits still pass while a manual worktree source write is now gated like any other direct source edit. Adds `test_delivery_enforcement_worktree.py` (6 tests).

## v1.67.0 (2026-06-26)

- feat(bench): practical-significance verdict — ties within noise are not wins


## v1.66.0 (2026-06-26)

- feat(coord): shared collaboration board + per-turn peer-knowledge injection


## v1.65.3 (2026-06-26)

- fix(policy): risk-scope expert-review gate + add env-free file waiver


## v1.65.2 (2026-06-25)

- fix(design,hooks): rgba overlays on-token + absolute Claude hook paths


## v1.65.1 (2026-06-25)

- feat(design): author UAP Console DESIGN.md + harden interrogator


## v1.65.0 (2026-06-25)

- feat(design): implement DESIGN.md — auto-interrogate existing UI + guide new
- chore(release): 1.64.4 — periodic turn-count breaker
- fix(proxy): TURN-COUNT FINALIZE BREAKER fires periodically, not every turn
- chore(release): 1.64.3 — assistant-prefill 400 fix
- fix(proxy): assistant-prefill 400 with the MTP/130-config template

## v1.64.4 (2026-06-25)

- fix(proxy): TURN-COUNT FINALIZE BREAKER now fires **periodically**, not on every turn. `_count_agent_tool_turns` is derived from the only-growing conversation, so once a session crossed `PROXY_HARD_FINALIZE_TURNS` the breaker stripped tools on *every* subsequent request — permanently denying tools and stalling a legitimately long agentic task (observed live: msgs 206→208→…→214 with the breaker firing each turn, then the client gives up mid-task). `reset_tool_turn_state` resets the state machine but not the conversation-derived count, so it never helped. Now gated on `count >= last_hard_finalize_turn_count + ceiling` (new `SessionMonitor` field, recorded on each fire) so it fires at the ceiling, 2×, 3×… as a periodic progress checkpoint with tools restored in between — long tasks complete, while a true runaway is still bounded (and the contamination/prune/cycle breakers catch fast loops). Message softened from "STOP now" to a checkpoint nudge. Adds 4 tests.

## v1.64.3 (2026-06-25)

- fix(proxy): assistant-prefill HTTP 400 with the MTP/130-config template. The `qwen3.5-enhanced.jinja` template (used by the draft-mtp throughput config) rejects an assistant **prefill** (trailing assistant message) unless thinking is disabled via `chat_template_kwargs` — the top-level `enable_thinking` flag the proxy sets is **not read** by that template, so every prefill/continuation request 400'd with *"Assistant response prefill is incompatible with enable_thinking"* (~38/hr observed after the MTP switch). When the final outgoing message is an assistant prefill, the proxy now sets `chat_template_kwargs.enable_thinking=false` (nothing to think about on a continuation) and drops the ignored top-level flag. Verified live: prefill requests return 200, 0 × 400 since deploy.

## v1.64.2 (2026-06-25)

- fix(hooks): runtime-gate timeout is portable (no bare `timeout`)


## v1.64.1 (2026-06-24)

- fix(policy): **workdir-scope no longer blocks `/dev/*` redirects** — the enforcer flagged any absolute redirect/write target outside the project root, including the null device, so routine commands like `uap worktree ensure --strict 2>(null device)` were blocked. `_check_path` now allows `/dev` device nodes (null/stdout/stderr/fd/tty/...), which never escape the workspace, while still blocking real out-of-scope absolute writes (e.g. `/etc/...`). Adds `test/policies/workdir-scope.test.ts` (5 tests).

## v1.64.0 (2026-06-24)

- feat(proxy): **tool-call path containment** — snap a small quant's garbled paths back onto the session workdir so it can actually build under the strict sandbox + workdir-scope stack. The weak model mangles intended in-workdir paths at every level — absolute prefix (`/home/cogtek`→`/home/cogtec`), workdir name (`octopus_invaders`→`octus_invaders`/`octopus-invaders`), subdir names (`space-shooter`→`space-shootr`/`space-Shooter`) — and with strict enforcement those garbles point at non-existent dirs and are correctly rejected as "outside", so the agent loops. Containment derives the session workdir VALIDATED against disk (the deepest existing project-root among the paths the model used + tool-result text; garbled variants don't exist, so the real workdir is recovered) and rewrites garbled paths onto it: fuzzy-matches the workdir-name component to fix the prefix, then fuzzy-corrects each garbled SUBDIR component against the real directories on disk (the final filename is never mangled). Applies to Write/Edit args AND Bash command tokens (`mkdir`/heredoc/redirect). Gated `PROXY_TOOLCALL_PATH_CONTAIN` (default on), runs before same-dir normalization. Safe precisely because the OS sandbox (`uap sandbox`, v1.63.0) contains any mis-snap to the workdir — the cross-project relocation risk that forced the normalizer to harden is gone. Verified end-to-end: a sandboxed, skip-permissions-free agent turn on the small quant built a complete, coherent canvas game (3 coherent files), with every garble contained to the one real workdir and nothing escaping. Adds `test/test_path_containment.py` (13 tests).

## v1.63.0 (2026-06-24)

- feat(sandbox): **`uap sandbox -- <command>`** — a kernel-enforced workdir boundary via bubblewrap, shipped in the package. The `workdir-scope` policy gate (PreToolUse hook) cannot enforce under `--dangerously-skip-permissions` (verified live: the hook fires but its deny — exit-2 and JSON `permissionDecision` alike — is ignored, so the write proceeds). `uap sandbox` runs a command under a read-only root with writable "holes" for only the current workdir + scratch/state (`/tmp`, `~/.cache`, `~/.npm`, `~/.claude`), so a write/mkdir anywhere else fails with `EROFS`/`EACCES` at the kernel — for Write/Edit tools, Bash, and any subprocess — and the client cannot escape the mount namespace. Network is shared so the agent still reaches the local proxy. Env: `UAP_SANDBOX_WORKDIR`, `UAP_SANDBOX_ALLOW` (extra writable prefixes), `UAP_SANDBOX_OFF=1` (bypass); a guard refuses an over-broad workdir (`$HOME`, `/`, `/home`). Wire it as `uap sandbox -- env … claude --dangerously-skip-permissions …`. Verified end-to-end: a real skip-permissions agent turn wrote into the workdir but could not create a sibling at `~/dev`.

## v1.62.0 (2026-06-24)

- feat(policies): **workdir-scope** policy — blocks file mutations outside the project working directory at the PreToolUse policy gate. Agents running with `--dangerously-skip-permissions` emit absolute paths that can escape the project (a sibling at `~/dev`, or a garbled name like `octopusspace-shooter`), silently creating directories/files outside the intended workspace. The enforcer blocks, by default, any `Write`/`Edit`/`MultiEdit`/`NotebookEdit` target — or `Bash` create/move destination (`mkdir`/`touch`/`cp`/`mv`/`install`/`tee`/output redirection) — that resolves outside the working tree. In scope: the working tree + main checkout (worktrees included), relative paths, reads, and a scratch allow-list (`/tmp`, `$TMPDIR`, `~/.cache/uap`, `~/.config/uap`, plus `UAP_WORKDIR_ALLOW`). Escape hatch: `UAP_WORKDIR_SCOPE_OFF=1`. Added to `MANDATORY_POLICIES` so it installs by default. Verified end-to-end through `uap-policy-gate.sh`; 16-test enforcer suite. Enforces the operator rule "never step outside the current path without explicit permission" at the correct layer (the proxy can't see a session's cwd; the policy gate runs in-project).

## v1.61.3 (2026-06-24)

- fix(self-harness): harden the tool-call path-normalizer to be **filesystem-verified, same-directory-only**. The heuristic version silently RELOCATED writes across projects/worktrees (e.g. `octopus_invaders/js/config.js` → `octopus-invader/space-shooter/js/config.js`; `s-space-shooter` → `s space-shooter`; `oct` → `octop`), turning a loud self-correcting "no such file" failure into a silent wrong-write that clobbered unrelated files. Onset correlated exactly with enabling the normalizer on 2026-06-23 — the model never changed. The v1.61.1 `dirCompatible` guard didn't close it (`squash()` collapsed punctuation/case; edit-distance guessed wrong filenames). The Python (proxy) normalizer now only repairs a FILENAME inside a directory that already exists on disk (absolute paths only, single real-sibling match, no edit-distance, directory used verbatim — no relocation), and otherwise returns the path unchanged to fail loud and self-correct; the TS reference core uses exact parent-dir matching and drops edit-distance. Adds `tools/agents/tests/test_path_normalizer_hardened.py` (11 tests, real temp dirs); updates the TS suite (17). Operational revert lever: `PROXY_TOOLCALL_PATH_NORMALIZE=off`.

## v1.61.2 (2026-06-24)

- fix(proxy): suppress prose->tool_call resurrection on hard finalize turns. When the TURN-COUNT FINALIZE BREAKER or SESSION CONTAMINATION LOOP strips tools to force a terminal text-only end_turn, the response-side extractor (`_maybe_extract_text_tool_calls`, also invoked inside `openai_to_anthropic_response`, plus the post-stream `<tool_call>` recovery) no longer promotes a contaminated model's `<function=...>`/`<tool_call>` prose back into a structured tool_use — which had let the client keep executing tool calls and continue the very loop the breaker was ending (observed live as a ~4 min / 104-message grind). Carried by a per-turn `SessionMonitor.suppress_text_tool_extraction` flag (reset at request entry, set by both breakers, honored at every resurrection site); the Hermes prose parser stays load-bearing on normal turns. Adds `test/test_finalize_suppression.py` (7 tests).

## v1.61.1 (2026-06-24)

- fix(self-harness): the tool-call path-normalizer must not RELOCATE a write across structurally-different directories — it now only fixes the filename / strips a wrong absolute prefix, never snapping to a candidate in a different directory tree (live bug: a garbled octopus_invaders write was being sent to a different project dir). Applied to both the TS reference and the proxy-side Python port.

## v1.61.0 (2026-06-23)

- feat(self-harness): self-improving harness (arXiv:2606.09498) — autonomous mine -> propose -> validate -> decide loop (bounded reversible Mod DSL, weakness/signature mining, paired-bench validation), tool-call path-normalizer middleware (cracks the small-model path-garbling ceiling), cross-model transfer store, online prod-trace mining with gated promotion, ablation prune, and a daily mine timer (`uap self-harness {analyze,transfer,mine-prod,pending,prune}`)
- fix(proxy): recon-convergence permanent tool-strip poison (guardrail death-spiral that could wedge tool access across sessions until restart) — now self-recovers
- fix(proxy): non-lossy tool-call JSON repair + tool-narrowing core-tool protection (was dropping Write/Edit/Bash) + uap-deliver pipeline robustness
- fix(llama-server): honor LLAMA_N_PREDICT env knob + proxy turn-count finalize backstop (catastrophic timeout loops -> fast clean termination)
- feat(bench): headless paired-bench claude adapter + real-gate-medium/-heldout suites

## v1.60.0 (2026-06-20)

- feat(deliver): prefer the acceptance judge over the brittle self-gate


## v1.59.0 (2026-06-20)

- fix(delivery): re-detect gates mid-loop + run the execution gate in deliver


## v1.58.0 (2026-06-20)

- feat(delivery): wire acceptance feedback into the deliver convergence loop


## v1.57.0 (2026-06-20)

- feat(delivery): acceptance judge — verify behavioral completeness against the spec


## v1.56.0 (2026-06-20)

- feat(delivery): `uap verify` + Stop-hook runtime enforcement (covers agentic/opencode)


## v1.55.0 (2026-06-20)

- feat(delivery): execution gate — verify generated code actually runs
- fix(hooks): resolve hook scripts via $CLAUDE_PROJECT_DIR with fail-open guard (#258)


## v1.54.0 (2026-06-20)

- feat(delivery): agentic executor recovers files from text when model skips tool calls


## v1.53.0 (2026-06-20)

- feat(delivery): lenient file-block decoder for non-compliant model output


## v1.52.1 (2026-06-19)

- docs(benchmarks): document controlled paired findings + wire into index/readme/architecture
- feat(bench): raw single-shot adapter with gate-enforced loop
- test(bench): add real-gate-gated suite (edge-case + in-repo tests)
- fix(bench): orphan-proof subprocess timeout via detached process-group kill
- test(bench): add real-gate-hard suite (6 harder fixtures)
- fix(bench): parse opencode --format json JSONL event stream
- chore: bump version to 1.51.0
- feat(bench): paired UAP-on/off benchmark harness


## v1.52.0 (2026-06-19)

- feat(coordination): always-on file announcements + live-conflict guard


## v1.51.0 (2026-06-19)

- feat(bench): paired UAP-on/off benchmark harness


## v1.50.1 (2026-06-19)

- docs(setup): document the guided wizard, backup, and custom-content extraction


## v1.50.0 (2026-06-19)

- feat(setup): port full wizard config into guided flow; retire legacy inquirer wizard


## v1.49.0 (2026-06-19)

- feat(setup): unified guided setup — arrow-key wizard, instruction backup, policy/skill extraction


## v1.48.1 (2026-06-18)

- docs(deliver): document tiered gates, CI/deploy feedback, and setup self-update


## v1.48.0 (2026-06-18)

- feat(setup): auto-update the UAP CLI to the latest published version on setup


## v1.47.0 (2026-06-18)

- feat(delivery): tiered validation gates + CI/deploy feedback for convergence loop
- fix(proxy): proxy death-spiral + recon doom-loop guards (#248)
- fix(policy): strip GIT_* env in enforcer subprocesses — prevent hook context poisoning (Fix G)
- fix(proxy): context death-spiral breaker — force end_turn on raw-ctx runaway (Fix F)
- docs: add automatic features guide + Qwen3.6 llama.cpp VRAM tiers
- fix(proxy): break recon doom-loop — release tool_choice on real context blow-up


## v1.46.7 (2026-06-18)

- Version bump


## v1.46.6 (2026-06-18)

- Version bump


## v1.46.5 (2026-06-18)

- fix(memory): tolerate Qdrant client/server version skew (checkCompatibility:false)


## v1.46.4 (2026-06-17)

- fix(proxy): bound Anthropic-passthrough upstream calls (PROXY_PASSTHROUGH_TIMEOUT)
- fix(bench): watchdog stall signal = file activity, not graded-trial count


## v1.46.3 (2026-06-17)

- feat(bench): stall-watchdog wrapper for harbor runs (auto-recover from hangs)


## v1.46.2 (2026-06-17)

- docs(bench): terminal-bench investigation findings + improvement plan
- chore: bump version to 1.46.1
- fix(bench): OpenCodeBaseline must invoke opencode with cd /app + --dir /app


## v1.46.1 (2026-06-16)

- fix(bench): OpenCodeBaseline must invoke opencode with cd /app + --dir /app


## v1.46.0 (2026-06-16)

- feat(deliver): real-gate detection + --keep-best (never-regress) + hybrid agent


## v1.45.1 (2026-06-16)

- revert(bench): remove transparent deliver-on-edit trigger (net-harmful)


## v1.45.0 (2026-06-15)

- feat(deliver): agentic (tool-using) executor with dynamic selection + alwaysVerify fix


## v1.44.0 (2026-06-15)

- feat(deliver): self-authored acceptance gate + activate real UAP/deliver in opencode benchmark


## v1.43.3 (2026-06-15)

- docs: add automatic-features guide + Qwen3.6 llama.cpp VRAM-tier setup


## v1.43.2 (2026-06-15)

- fix(pkg): remove malformed </path> filename that broke npm install
- fix(pkg): ship shebang scripts executable + prepublish guard


## v1.43.1 (2026-06-15)

- fix(opencode): mint droid parts with prt- prefixed ids


## v1.43.0 (2026-06-15)

- feat(policy): delivery-enforcement blocks by default


## v1.42.6 (2026-06-15)

- fix(bench): opencode agent model-agnostic config + native tool calls


## v1.42.5 (2026-06-14)

- fix(policy): iac-parity gates only mutating Bash commands, not content


## v1.42.4 (2026-06-14)

- fix(policy): rtk-wrap routes npm/pnpm/yarn builtins via `rtk proxy`


## v1.42.3 (2026-06-14)

- docs: index the Reactor design under Architecture


## v1.42.2 (2026-06-14)

- fix(reactor): gate experts/skills by confidence, independent of patterns


## v1.42.1 (2026-06-14)

- chore(hooks): install reactor adapter scripts in .claude/hooks


## v1.42.0 (2026-06-14)

- feat(reactor): phase 6 — enforce gap-fill (schema-change reminder) + status
- feat(reactor): phases 4-5 — harness parity + Codex MCP fallback
- feat(reactor): phase 3 — reference harness wiring (Claude + OpenCode)
- feat(reactor): phase 2 — `uap react` CLI (JSON in -> JSON out)
- feat(models): add opus-4.8 (xhigh effort) preset; executor=qwen, others=opus-4.8
- feat(reactor): phase 1 — UAP auto-apply resolver core


## v1.41.0 (2026-06-14)

- feat(delivery): `uap init`/`uap setup` enable delivery-enforcement (block by default) + wire the MCP `deliver` tool into Claude/OpenCode by default
- fix(policies): materialize `_common.py` alongside enforcers so the gate no longer fails open with ModuleNotFoundError in fresh projects
- chore(pkg): bundle policy schemas + enforcers so policy install works in installed projects

## v1.40.1 (2026-06-14)

- docs: complete documentation overhaul — rewrite the developer-facing doc set from v1.40.0 ground truth, correct all counts, remove stale/superseded/corrupted docs and non-project files

## v1.40.0 (2026-06-14)

- feat(delivery): make loop-until-delivered the default for all UAP coding agents


## v1.39.0 (2026-06-14)

- feat(delivery): deliver-enforcement policy + persist-until-delivered loop autonomy


## v1.38.0 (2026-06-14)

- feat(mcp-router): add `deliver` meta-tool to auto-route tasks into uap deliver


## v1.37.0 (2026-06-13)

- feat(delivery): mission-autonomy stance + operator-guidance channel for uap deliver


## v1.36.1 (2026-06-13)

- fix(policies): GIT_DIR poisoning broke git-diff enforcers and pre-push gates under hooks


## v1.36.0 (2026-06-13)

- feat(policies): merge-deploy-monitor-verify policy (recovered 078 work)
- feat(proxy): thinking-grammar toggle for the anthropic proxy tool-call path


## v1.35.0 (2026-06-12)

- feat(delivery): resolve tsconfig path aliases in the spec import walk


## v1.34.0 (2026-06-12)

- feat(delivery): protect spec transitive imports + runtime gate-integrity guard


## v1.33.0 (2026-06-12)

- feat(delivery): protect pre-existing test files and gate configs from model writes


## v1.32.0 (2026-06-12)

- feat(delivery): dynamic auto-optimization — classify every task, enable matching aids by default


## v1.31.0 (2026-06-12)

- feat(delivery): integrate HALO, ideation, coordination, and deploy batching into uap deliver


## v1.30.1 (2026-06-12)

- docs(readme): document the delivery harness (uap deliver)


## v1.30.0 (2026-06-12)

- feat(delivery): semantic recall for practice cards via embedding store


## v1.29.0 (2026-06-12)

- feat(delivery): best-practice injection + escalation controller (Phases 4-5)


## v1.28.0 (2026-06-12)

- feat(delivery): best-of-N explorer + judge + structured critic (Phases 2-3)


## v1.27.0 (2026-06-12)

- feat(delivery): Fable-parity convergence loop — uap deliver (Phase 1)
- chore(agents): pin Qdrant to v1.18.1 + persist snapshots (#207)
- chore: bump version to 1.23.1
- fix(chat-template): tolerate mid-conversation system messages


## v1.26.6 (2026-06-01)

- fix(chat-template): tolerate mid-conversation system messages


## v1.26.5 (2026-05-31)

- fix(memory): real semantic embeddings for long-term store + recall


## v1.26.4 (2026-05-31)

- fix(policies): git-diff enforcers run against the working tree


## v1.26.3 (2026-05-31)

- fix(hooks): policy gate resolves DB + enforcers against the main checkout


## v1.26.2 (2026-05-31)

- fix(hooks): worktree guard fails closed when repo root is unresolvable


## v1.26.1 (2026-05-31)

- ci: move GitHub Actions to Node 24 runtime


## v1.26.0 (2026-05-31)

- feat(patterns): index .factory/patterns so P12/P35 are retrievable


## v1.25.1 (2026-05-31)

- fix(coordination): allow uap agent register --id for stable agent IDs


## v1.25.0 (2026-05-31)

- test+docs: gating-parity tests + PLATFORM_GATING.md + README
- feat(hooks): add `uap hooks doctor` validator + install hooks in `uap setup`
- feat(hooks): add Hermes Agent (NousResearch) as a gated platform
- feat(hooks): wire policy gate into factory, omp, opencode, codex
- fix(hooks): copy uap-policy-gate.sh on install + reconcile platform list
- fix: address ultrareview findings on PR #196
- fix(test): sanitize GIT_* env in expert-review-required enforcer test


## v1.24.0 (2026-05-30)

- docs: document expert-stack extensions (HALO, ideation, forward-design, review gate)
- feat(policies): real expert-review hard gate + architecture-review doc
- feat(ideate): open-collider divergent-ideation wrapper
- feat(halo): trace exporter + harness-optimizer droid + uap harness CLI
- feat(experts): forward-design droids + activate experts-MCP surface


## v1.23.0 (2026-05-26)

- feat(droids): add 17-droid expert stack + adaptive orchestrator


## v1.22.1 (2026-05-25)

- fix(hooks): worktree-guard scope check — allow paths outside repo root (#193)
- proxy: attractor breaker phase 2 — stronger escape signal (#192)
- proxy: attractor-aware contamination breaker (#191)


## v1.22.0 (2026-05-22)

- feat(policies): add task-required enforcer + fix tasks.db due_date crash (#189)


## v1.20.51 (2026-05-19)

- proxy: B1 restores the write tool that narrowing drops


## v1.20.50 (2026-05-18)

- proxy: B1 recon-convergence — track write-tool absence, not read-tool presence


## v1.20.49 (2026-05-18)

- proxy: context pruner rework — cache-stable boundary + finding breadcrumbs


## v1.20.48 (2026-05-18)

- proxy: recon-convergence guardrail — nudge stuck explorers to the deliverable


## v1.20.47 (2026-05-17)

- proxy: log CONTEXT CRITICAL at WARNING, not ERROR


## v1.20.46 (2026-05-17)

- proxy: make slot save/restore HTTP timeouts configurable + raise defaults


## v1.20.45 (2026-05-17)

- proxy: strip JSON-schema "format" keyword from tool schemas (GBNF fix)


## v1.20.44 (2026-05-17)

- proxy: update /v1/models local model ID to qwen36-35b-a3b-iq4xs


## v1.20.43 (2026-05-15)

- scripts: make slot save/restore the default for both continuity services


## v1.20.42 (2026-05-15)

- proxy: cross-session slot save/restore to eliminate KV-cache thrash


## v1.20.41 (2026-05-15)

- proxy: update /v1/models local model ID to qwen36-27b-iq4xs


## v1.20.40 (2026-05-14)

- proxy: strip unclosed <think> tags from response body (Anthropic-spec compliance)


## v1.20.39 (2026-05-14)

- proxy: refresh /v1/models with Shannon canonical Claude IDs


## v1.20.38 (2026-05-14)

- ci: remove dead publish.yml (redundant + always-failing)


## v1.20.37 (2026-05-14)

- compliance: restore substantive CLAUDE.md sections + tighten workflow gates


## v1.20.36 (2026-05-14)

- docs(proxy): codify Anthropic-default + OpenAI-optional canonical surface


## v1.20.35 (2026-05-14)

- config: add qwen3.5-enhanced chat template
- scripts: add DFlash inference backend bootstrap + run scripts
- policy(cluster_routing): scope to Bash + strip heredocs to prevent false-positives
- proxy: Gemma 4 + Fix K cycle-repeat tuning + small-preflight floor carveout
- feat(llama): default to MTP (draft-mtp) on Qwen3.6-35B-A3B
- proxy: queue concurrent client requests to serialized llama.cpp upstream
- proxy: persist malformed-streak across retry-success for dampener
- proxy: strip orphan tool-XML closers before malformed-payload check
- proxy: strip balanced <think> blocks before malformed-payload heuristic
- proxy: no-task ack guard to stop <think>-leak retry storm
- proxy: fix Shannon's tool-required retry storm on Qwen thinking-leak
- proxy: Anthropic-spec compatibility for Qwen 3.6 (thinking blocks, toolu_ IDs)
- proxy: catch Gemma 4 PEG parse failures and retry with relaxed tool_choice
- proxy: tool narrowing walks back past tool_result turns to find query text
- proxy: Gemma 4 perf round 2 — schema-match, cold-start gate, thinking control
- proxy: add Gemma 4 tool-call parser to _extract_tool_calls_from_text
- refactor(llama): env-driven repeat-penalty and cache-reuse (#168)
- feat: wire uap policy gate into claude pre-tool hooks
- chore: remove worktrees for clean bump
- chore: update project files


## v1.20.34 (2026-04-17)

- test: update stale PreToolUse matcher test to accept MultiEdit
- refactor: parameterize llama-server repeat-penalty and add cache-reuse env var


## v1.20.33 (2026-04-16)

- feat: wire uap policy gate into claude pre-tool hooks
- config: planarquant server defaults + fix kanban tests (#164)


## v1.20.32 (2026-04-03)

- chore: bump version to 1.20.31
- chore: bump version to 1.20.30
- fix: upstream 503 Loading model resilience with health-check wait and state preservation
- fix: session-level tool banning and log noise reduction (#159) (#159)
- fix: break malformed payload death loop (#157) (#157)
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.31 (2026-04-03)

- chore: bump version to 1.20.30
- fix: upstream 503 Loading model resilience with health-check wait and state preservation
- fix: session-level tool banning and log noise reduction (#159) (#159)
- fix: break malformed payload death loop (#157) (#157)
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.30 (2026-04-03)

- fix: upstream 503 Loading model resilience with health-check wait and state preservation
- fix: session-level tool banning and log noise reduction (#159) (#159)
- fix: break malformed payload death loop (#157) (#157)
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.29 (2026-04-02)

- chore: bump version to 1.20.28
- fix: session-level tool banning, reduced log noise, and cycle polish
- fix: break malformed payload death loop (#157) (#157)
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.28 (2026-04-02)

- fix: session-level tool banning, reduced log noise, and cycle polish
- fix: break malformed payload death loop (#157) (#157)
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.27 (2026-04-02)

- fix: break malformed payload death loop with complex tool exclusion, temp reduction, and contamination finalize
- fix: persistent cycle exclusion and escalating hints (#156) (#156)
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.26 (2026-04-02)

- fix: persistent cycle exclusion, escalating hints, and act-phase narrowing
- fix: read-only tool class exclusion and duplicate target cycle detection (#155)


## v1.20.25 (2026-04-02)

- fix: add read-only tool class exclusion and duplicate target detection to break cycling loops


## v1.20.24 (2026-04-01)

- fix: reset to bootstrap after exhausted retries in review phase


## v1.20.23 (2026-04-01)

- fix: break review↔finalize ping-pong infinite loop in tool state machine


## v1.20.22 (2026-04-01)

- perf: reduce draft-max from 16 to 4 for improved tool call accuracy
- fix: add spec mode and system-reminder leak markers (#151)
- fix: improve retry resilience for garbled tool args (#150)
- fix: strip residual <tool_call> XML on finalize turns (#149)
- fix: cap max_tokens for tool turns to prevent 32K waste (#148)
- fix: garbled tool args retry + env sync (#147)


## v1.20.21 (2026-04-01)

- fix: add spec mode and system-reminder leak markers
- fix: improve retry resilience for garbled tool args (#150)
- fix: strip residual <tool_call> XML on finalize turns (#149)
- fix: cap max_tokens for tool turns to prevent 32K waste (#148)
- fix: garbled tool args retry + env sync (#147)


## v1.20.20 (2026-04-01)

- fix: improve retry resilience for garbled tool args
- fix: strip residual <tool_call> XML on finalize turns (#149)
- fix: cap max_tokens for tool turns to prevent 32K waste (#148)
- fix: garbled tool args retry + env sync (#147)


## v1.20.19 (2026-04-01)

- fix: strip residual <tool_call> XML leaking through on finalize turns
- fix: cap max_tokens for tool turns to prevent 32K waste (#148)
- fix: garbled tool args retry + env sync (#147)


## v1.20.18 (2026-04-01)

- fix: cap max_tokens for tool turns to prevent 32K generation waste
- fix: garbled tool args retry + env sync (#147)


## v1.20.17 (2026-04-01)

- fix: add garbled tool args detection to retry pipeline


## v1.20.16 (2026-04-01)

- fix: add generation timeout and slot hang detection for llama-server hangs


## v1.20.15 (2026-04-01)

- fix: skip max_tokens floor for non-tool requests and detect degenerate repetition


## v1.20.14 (2026-04-01)

- fix: harden malformed tool retry with higher budget and message sanitization


## v1.20.13 (2026-04-01)

- fix: reduce tool call cycling waste with 4 layered defenses


## v1.20.12 (2026-04-01)

- fix: prevent pruning death spiral with upstream tokens, circuit breaker, aggressive mode


## v1.20.11 (2026-04-01)

- fix: reduce cycle detection window, keep required in review phase, increase ctx-size


## v1.20.10 (2026-04-01)

- fix: revert parallel=1 and remove context-aware relaxation


## v1.20.9 (2026-04-01)

- fix: resolve context pressure, tool starvation, and pruning death spiral
- fix: expand system prompt leak markers to cover client-side prompt phrases


## v1.20.8 (2026-04-01)

- fix: detect and repair system prompt leaking into tool call arguments


## v1.20.7 (2026-04-01)

- fix: align server config with profile, detect garbled tool args, force tool-turn temperature


## v1.20.6 (2026-04-01)

- chore: bump version to 1.20.5
- fix: resolve UnboundLocalError for model in proxy messages handler
- chore: bump version to 1.20.4
- chore: bump version to 1.20.3
- fix: extract tool calls from <tool_call> XML in text content
- fix: satisfy verifier loop compliance wording
- fix: restore compliance-required CLAUDE sections
- fix: prevent premature proxy plan completion
- chore: bump version to 1.20.4
- feat: add benchmark automation tooling
- fix: align local qwen runtime defaults
- fix: restore stable qwen coding runtime defaults
- chore: bump version to 1.20.3
- fix: stabilize release validation flow
- fix: build before tests in version bump pipeline
- fix: remove duplicate agents docker compose file
- fix: restore unexpected end-turn retries for active qwen loops
- fix: keep proxy guardrail fallbacks non-terminal in active loops
- fix: add PreCompact hook registration to settings.local.json
- feat: add knowledge graph, prepopulation settings, and optimization tweaks
- chore: bump version to 1.20.2
- feat: enable per-request model profiles
- fix: make tool-call server configurable + proxy passthrough
- chore: bump version to 1.18.1
- fix: expand proxy model list
- chore: bump version to 1.20.0
- chore: bump version to 1.19.0
- chore: bump version to 1.19.0
- feat: add CLI parity commands and aliases
- chore: bump version to 1.18.1
- perf: optimize adaptive cache and capability routing
- Revert "Merge pull request #123 from DammianMiller/feature/008-optimization-suite"
- perf: optimize adaptive cache and capability routing
- feat: update supported Droid models to latest versions


## v1.20.5 (2026-04-01)

- fix: resolve UnboundLocalError for model in proxy messages handler
- chore: bump version to 1.20.4
- chore: bump version to 1.20.3
- fix: extract tool calls from <tool_call> XML in text content
- fix: satisfy verifier loop compliance wording
- fix: restore compliance-required CLAUDE sections
- fix: prevent premature proxy plan completion
- chore: bump version to 1.20.4
- feat: add benchmark automation tooling
- fix: align local qwen runtime defaults
- fix: restore stable qwen coding runtime defaults
- chore: bump version to 1.20.3
- fix: stabilize release validation flow
- fix: build before tests in version bump pipeline
- fix: remove duplicate agents docker compose file
- fix: restore unexpected end-turn retries for active qwen loops
- fix: keep proxy guardrail fallbacks non-terminal in active loops
- fix: add PreCompact hook registration to settings.local.json
- feat: add knowledge graph, prepopulation settings, and optimization tweaks
- chore: bump version to 1.20.2
- feat: enable per-request model profiles
- fix: make tool-call server configurable + proxy passthrough
- chore: bump version to 1.18.1
- fix: expand proxy model list
- chore: bump version to 1.20.0
- chore: bump version to 1.19.0
- chore: bump version to 1.19.0
- feat: add CLI parity commands and aliases
- chore: bump version to 1.18.1
- perf: optimize adaptive cache and capability routing
- Revert "Merge pull request #123 from DammianMiller/feature/008-optimization-suite"
- perf: optimize adaptive cache and capability routing
- feat: update supported Droid models to latest versions


## v1.20.4 (2026-04-01)

- chore: bump version to 1.20.3
- fix: extract tool calls from <tool_call> XML in text content
- chore: bump version to 1.20.2
- feat: enable per-request model profiles
- fix: make tool-call server configurable + proxy passthrough
- chore: bump version to 1.18.1
- fix: expand proxy model list
- chore: bump version to 1.20.0
- chore: bump version to 1.19.0
- chore: bump version to 1.19.0
- feat: add CLI parity commands and aliases
- chore: bump version to 1.18.1
- perf: optimize adaptive cache and capability routing
- Revert "Merge pull request #123 from DammianMiller/feature/008-optimization-suite"
- perf: optimize adaptive cache and capability routing
- feat: update supported Droid models to latest versions


## v1.20.3 (2026-04-01)

- fix: extract tool calls from <tool_call> XML in text content
- chore: bump version to 1.20.2
- feat: enable per-request model profiles
- fix: make tool-call server configurable + proxy passthrough
- chore: bump version to 1.18.1
- fix: expand proxy model list
- chore: bump version to 1.20.0
- chore: bump version to 1.19.0
- chore: bump version to 1.19.0
- feat: add CLI parity commands and aliases
- chore: bump version to 1.18.1
- perf: optimize adaptive cache and capability routing
- Revert "Merge pull request #123 from DammianMiller/feature/008-optimization-suite"
- perf: optimize adaptive cache and capability routing
- feat: update supported Droid models to latest versions


## v1.20.4 (2026-03-29)

- feat: add benchmark automation tooling
- fix: align local qwen runtime defaults


## v1.20.3 (2026-03-29)

- chore: bump version to 1.20.3
- fix: stabilize release validation flow
- fix: build before tests in version bump pipeline


## v1.18.0 (2026-03-27)

- feat: implement full optimization suite - adaptive cache O(1) eviction, SQLite WAL mode, query caching, pattern router LRU cache, async hook execution
- feat: add baseline performance metrics and comparison tools
- perf: 60% memory reduction via query history pruning
- perf: 2-3x faster queries via WAL mode and caching
- perf: 80% reduction in pattern matching overhead via LRU caching
- test: add comprehensive benchmarks for all optimized components

## v1.17.2 (2026-03-26)

- fix: update documentation parity - skills (24→33), dashboard views (13→11)


## v1.17.1 (2026-03-26)

- fix: streamline CLAUDE.md and hooks to prevent session deadlocks


## v1.17.0 (2026-03-26)

- refactor: consolidate hooks/skills/policies, remove stale dirs, fix broken README links
- feat: add mission artifacts for spec decoding fix + infra + reorg


## v1.16.0 (2026-03-25)

- feat: add 16 test files improving coverage across utils, tasks, coordination, memory, models, and mcp-router
- fix: clear stale dampener state on fresh loop resets
- fix: allow act-phase auto release to terminate loops
- fix: tighten proxy loop exits and tool-turn token budgets
- fix: harden anthropic proxy loop state transitions


## v1.15.13 (2026-03-25)

- fix: preserve property name 'pattern' in tool schema sanitizer


## v1.15.12 (2026-03-25)

- fix: restore required CLAUDE compliance sections
- fix: sanitize regex tool schema fields for llama grammar


## v1.15.11 (2026-03-25)

- fix: guard required stream tool turns


## v1.15.10 (2026-03-25)

- fix: block repeated policy-echo responses on tool turns


## v1.15.9 (2026-03-25)

- fix: fallback when grammar is rejected with tools


## v1.15.8 (2026-03-25)

- fix: fail closed required tool arg autofill


## v1.15.7 (2026-03-25)

- fix: enforce tool-call grammar on required tool turns


## v1.15.6 (2026-03-25)

- fix: harden proxy retry flow and bash safety
- docs: add speculative blog and PR templates


## v1.15.5 (2026-03-25)

- fix: harden proxy against leaked closing function tags


## v1.15.4 (2026-03-24)

- test: guard SessionStart and PreCompact hook array shape


## v1.15.3 (2026-03-24)

- fix: harden proxy tool-call recovery under forced turns


## v1.15.2 (2026-03-24)

- fix: sanitize malformed tool-call apology responses


## v1.15.1 (2026-03-24)

- fix: harden malformed tool-call fallback retries
- chore: bump version to 1.15.0


## v1.15.0 (2026-03-24)

- fix: route analysis-only prompts away from tool loops
- chore: bump version to 1.14.1
- fix: avoid gh delete-branch failures in worktree finish flow


## v1.14.1 (2026-03-24)

- fix: avoid gh delete-branch failures in worktree finish flow


## v1.14.0 (2026-03-24)

- feat: add worktree finish flow with sync and safe cleanup


## v1.13.18 (2026-03-24)

- chore: bump version to 1.13.15
- fix: auto-register agents to prevent announce FK failures


## v1.13.17 (2026-03-24)

- fix: make reinforcement db validation tests deterministic
- chore: bump version to 1.13.16
- chore: bump version to 1.13.15
- fix: normalize legacy hook schema during hooks install


## v1.13.16 (2026-03-24)

- fix: normalize legacy hook schema during hooks install


## v1.13.15 (2026-03-24)

- fix: reject malformed tool-call args before accepting retries
- fix: route qwen through local guardrail proxy
- fix: harden qwen tool-call guardrails and document decoding journey


## v1.13.14 (2026-03-23)

- fix: suppress malformed reasoning fallback in streaming responses
- docs: expand llama proxy bootstrap and tuning runbook
- feat: add speculative autotune and repeatable llama/proxy benchmarking stack
- feat: add optional systemd setup for llama and proxy
- fix: isolate proxy loop protection by session


## v1.13.13 (2026-03-22)

- feat: add token loop protection mechanism to prevent runaway hook/proxy loops


## v1.13.12 (2026-03-21)

- fix: remove synthetic analytics re-seeding from routing decisions, derive router enabled from real data
- refactor: replace synthetic data seeder with real-data-only dashboard, clean all fake data, add worktree enforcement gate


## v1.13.11 (2026-03-21)

- fix(dashboard): live data for all panels, per-agent model/token breakdown, correct model routing


## v1.13.10 (2026-03-21)

- fix: add performance data rendering to dashboard (hotPaths, metrics)


## v1.13.9 (2026-03-21)

- fix: rebuild memories table CHECK constraint to allow lesson and decision types


## v1.13.8 (2026-03-21)

- fix: add worktree enforcement gate, policy categories, dashboard improvements


## v1.13.7 (2026-03-21)

- feat: add GLM 4.7 model preset, Qwen3.5 optimizations, dashboard enhancements
- fix: add missing CLAUDE.md compliance sections, fix release permissions
- feat: local UAP injection for harbor tbench benchmarks
- fix: revert external router.ts regression, add Qwen3.5 benchmark configs
- fix: add glm-4.7 model preset, fix default model list and test expectations
- feat: fix Qwen3.5 + Claude Code integration — thinking mode, tool calls, agentic loop
- feat: add Anthropic-to-OpenAI proxy for Claude Code with local LLMs (#72)
- chore: update session hooks, restore worktree gate, bump v1.13.5 (#71)
- fix: correct publishConfig registry to npmjs.org (#70)
- fix: prevent Qwen3.5 35B A3B premature generation stopping (#69)
- fix: correct npm registry URL format


## v1.13.4 (2026-03-20)

- fix: prevent Qwen3.5 35B A3B premature generation stopping
  - Increase --n-predict from 4096 to 16384 (server-side hard cap)
  - Add _profile field to qwen35.json for profile-loader validation
  - Increase timeout_ms from 120s to 300s for local model generation
  - Double executor token budgets (4K/8K/16K/32K)
  - Increase modelContextBudget from 32K to 131K (match --ctx-size)
  - Add explicit <|im_end|> stop sequence
  - Set repeat-penalty to 1.0 (code naturally repeats patterns)

## v1.13.1 (2026-03-20)

- fix: correct Claude Code hooks schema to use matcher+hooks array format (#62)
- feat: live dashboard with dynamic data, policy audit trail, and layout fixes


## v1.13.0 (2026-03-20)

- feat: hard policy enforcement hooks for all agent platforms (#61)
- chore: bump version to 1.12.0
- chore: gitignore dist symlink in worktree
- chore: gitignore root-owned backup artifacts
- feat: deploy batching integration, policy DB seeding, cross-platform hook parity
- fix: wire session telemetry into web dashboard and add time-series graphs
- chore: bump version to 1.11.0
- fix: skip flaky browser tests in CI and handle missing settings.local.json
- feat: add kanban board view for tasks in web dashboard and CLI
- fix: resolve ((score++)) set -e bug in CI compliance workflow
- fix: restore 4 missing compliance blocks in CLAUDE.md and fix SQL column bug
- chore: simplify opencode session hooks plugin


## v1.12.0 (2026-03-20)

- chore: gitignore dist symlink in worktree
- chore: gitignore root-owned backup artifacts
- feat: deploy batching integration, policy DB seeding, cross-platform hook parity
- fix: wire session telemetry into web dashboard and add time-series graphs
- chore: fix npm publish errors


## v1.9.1 (2026-03-19)

- fix: dashboard display rendering — remove duplicate tool, fix box alignment, add visual width support


## v1.9.0 (2026-03-19)

- feat: add Codex CLI integration with AGENTS.md, MCP server, skills, and hooks


## v1.8.1 (2026-03-19)

- fix: add missing dashboard type exports and restore optimization sweep changes lost in merge


## v1.8.0 (2026-03-19)

- feat: 4-phase optimization sweep — wire unwired code, add persistence, implement HTTP/SSE transport


## v1.7.1 (2026-03-19)

- fix: restore execa and cloakbrowser to dependencies (runtime imports in setup-wizard and web-browser)


## v1.7.0 (2026-03-19)

- fix: align validation-fixes test with actual CLAUDE.md sections
- fix: align tests with actual CLAUDE.md content on master
- fix: adjust factory hooks test to match existing settings.local.json structure
- fix: make reinforcement.db test self-initializing (was relying on pre-existing schema)
- feat: 4-pass optimization sweep — wire dead code, close feedback loops, remove 3400 lines


## v1.6.2 (2026-03-19)

- fix: implement validated optimization plan - correctness, performance, and resource leak fixes


## v1.6.1 (2026-03-19)

- fix: resolve all validation issues - CLAUDE.md compliance, SKILL.md refs, reinforcement DB


## v1.6.0 (2026-03-19)

- feat: implement 4-layer worktree enforcement for 100% compliance
- chore: version bump to 1.5.6
- chore: fix npm publish errors


## v1.5.6 (2026-03-18)

- feat: complete UAP optimization tasks P1a-P2b
- feat: validate worktrees, model router, and adaptive knowledge seeding
- test: improve test coverage with embeddings and unified-router tests


## v1.5.5 (2026-03-18)

- feat: validate worktrees, model router, and adaptive knowledge seeding
- test: improve test coverage with embeddings and unified-router tests


## v1.5.4 (2026-03-18)

- fix: embeddings tests mock all fetch calls for isAvailable (health + test embed)
- fix: version-bump script restores clean tree after test run
- test: improve embeddings test variable naming and add batch coverage
- fix: add missing WORKTREE WORKFLOW section and enforcement policy


## v1.5.3 (2026-03-18)

- fix: resolve inquirer.prompt TypeError in model select command


## v1.5.2 (2026-03-18)

- fix: worktree enforcement + null safety in session hooks
- feat: add completion gate policy + model routing + policy gate improvements
- fix: Qwen3.5 tool call optimization for 100% success rate
- chore: bump version to 1.4.4
- fix: v1.4.3 - fix tool-choice-proxy writeHead race condition and temperature cap
- fix: v1.4.2 - null safety, MCP compliance, FTS5 segfault prevention, performance optimizations
- fix: v1.4.1 - revert callTool content unwrapping that broke Qwen3.5 tool call reliability
- feat: v1.4.0 - MCP compliance, policy enforcement, and performance optimizations
- fix: v1.3.5 - eliminate null display across all UAP operations, fix OpenCode/OMP deep integration
- fix: v1.3.4 - restore tool_choice=required, fix chat_template tool call regression


## v5.0.0 (2026-03-13)

### Security & Performance

- **Async exec in DeployBatcher** — Replaced all `execSync` calls with async `execFile` using argument arrays. Eliminates shell injection risk (especially on commit messages and deploy commands) and stops blocking the event loop during git/gh operations.

### Features

- **Routing strategy differentiation** — `routingStrategy` config now actually changes behavior: `performance-first` always uses planner model, `cost-optimized` picks cheapest capable model, `balanced`/`adaptive` use priority-rule matching. Added `getRequiredCapability()` helper.
- **Task due dates** — Added `due_date` column to tasks schema with automatic migration for existing databases. `overdue` stats now query tasks past their due date. Create/update/list/JSONL all support `dueDate` field.
- **`uap sync` command** — Full implementation replacing the stub. Syncs droids/agents, skills, and commands between claude/factory/opencode/vscode platforms. Supports `--dry-run` mode.
- **`uap model --execute`** — Executes plans via MockModelClient with progress output and execution summary. Prints clear note that real execution requires API keys.

### Tests

- **66 new tests** — Added test suites for CoordinationService (agent lifecycle, work claims, announcements, messaging, status), TaskService (CRUD, queries, dependencies, statistics, overdue, history, JSONL, hierarchy), and DeployBatcher (batch windows, queue, batch creation, execution, retrieval). Total: 215 tests across 20 files.

## v4.8.2 (2026-03-13)

- Version bump only

## v4.8.1 (2026-03-13)

### Performance Optimizations

- **WAL mode for coordination DB** — Enable WAL journal mode, NORMAL synchronous, and 10s busy timeout on `CoordinationDatabase` and `TaskDatabase` for concurrent multi-agent read/write performance
- **LRU cache for embeddings** — Changed embedding cache from FIFO to LRU eviction, ensuring frequently-accessed embeddings stay cached
- **Connection pool round-robin** — Fixed `Date.now() % poolSize` to use a deterministic counter for even distribution across SQLite connection pool
- **Exponential backoff on executor retries** — Retry delays now double each attempt (1s, 2s, 4s) instead of fixed 1s

### Bug Fixes

- **GitHub backend date parsing** — Fixed `rawTimestamp.replace(/-/g, ':')` which corrupted date portions (YYYY-MM-DD became YYYY:MM:DD), causing `Invalid Date` and broken pruning
- **SQL injection in memory consolidator** — Replaced string-interpolated `ids.join(',')` with parameterized placeholders in DELETE query
- **Executor retry context** — `previousAttempts` in `ExecutionContext` is now populated between retries, enabling the retry-context prompt section to provide failure info to subsequent attempts
- **Exit handler leak in AutoAgentCoordinator** — Track and remove SIGINT/SIGTERM/exit handlers on cleanup to prevent listener accumulation across start/cleanup cycles
- **Plan validation timeout** — `validationTimeoutMs` is now enforced via `Promise.race()` (was previously stored but never used)

### Features

- **PatternRouter restored** — Replaced no-op stub with full implementation: loads patterns from `.factory/patterns/index.json`, keyword-based matching, enforcement checklist with always-included critical patterns (P12, P35), singleton with lazy init
- **Mandatory plan validation** — Validator now always runs on every plan at every complexity level (removed `skipIfTrivial: true` and conditional `enableAutoValidation` gate)

### Documentation

- **docs/FEATURES.md** — Complete rewrite with accurate implementation status, verified file:line references, and honest performance claims
- **PUBLISH_STATUS.md** — Updated to v4.8.1 with current pipeline status
- **# Changelog.md** — Replaced empty changelog with full history

## v4.8.0 (2026-03-13)

### Features

- Mandatory plan validation on every plan regardless of complexity level

## v4.7.0 (2026-03-13)

### Features

- **Multi-agent coordination system** — CoordinationService, AutoAgentCoordinator, TaskCoordinator with automatic registration, heartbeat, and graceful exit cleanup
- **PlanValidator** — Validates subtasks, dependencies, model assignments, constraints, cost estimates
- **Auto-validation in TaskPlanner** — `createPlan()` now async, always validates generated plans
- **CLI `uap agent auto` command** — Automatic agent registration from CLI

### Bug Fixes

- Converted `require()` to ES6 imports across codebase
- Fixed unused variables and stale `@ts-expect-error` directives
- Fixed async `createPlan()` callers in tests and CLI

## v4.6.0 (2026-03-13)

### Features

- Auto-validation for generated plans (PlanValidator class)
- Comprehensive validation: subtasks, dependencies, model assignments, constraints, cost estimates

## v4.3.1 and earlier

- Initial release through iterative development
- Memory system (4-layer: working, session, semantic, knowledge graph)
- Pattern Router (58 Terminal-Bench patterns)
- MCP Router with output compression
- Worktree system for isolated development
- Hooks system (session-start, pre-compact)
- Droid system with JSON schema validation
- Multi-model architecture (router, planner, executor)
- Deploy batching system
- Task management with DAG dependencies
