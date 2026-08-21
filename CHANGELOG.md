# Changelog

## v1.220.0 (2026-08-21)

- feat(deliver): trivial-mission guard — refuse one-line missions under the escalate posture
- chore(hooks): sync mirrored gate/stop hook copies + ship escalation_tracker.py beside each stop.sh


## v1.219.0 (2026-08-21)

- feat(delivery): escalate mode — deliver as an escalation point; proxy-safe tool names for llama.cpp


## v1.218.0 (2026-08-20)

- feat(llama): make DFlash2 speculative decoding the default 27B profile
- chore: bump version to 1.217.0
- feat(qwen): run every Qwen launch path on the vendored Qwen-Sharp template
- docs(design): preserve the product-naming analysis (salvaged from #378)


## v1.217.0 (2026-08-20)

- feat(qwen): run every Qwen launch path on the vendored Qwen-Sharp template
- docs(design): preserve the product-naming analysis (salvaged from #378)


## v1.216.0 (2026-08-20)

- feat(bench): keep per-turn attribution instead of dropping it at the runner


## v1.215.2 (2026-08-20)

- fix(policies): sed and find are only destructive when a flag makes them write


## v1.215.1 (2026-08-20)

- fix(deliver): make the planner assign every file exactly one owner


## v1.215.0 (2026-08-20)

- feat(deliver): yield a flat epic attempt to a fresh one


## v1.214.1 (2026-08-20)

- fix(deliver): keep the anti-kill advice on the stage that recurs, and make the prune real
- fix(deliver): move the follow journal out of the tree the generator can write


## v1.214.0 (2026-08-20)

- feat(deliver): stop the follow-poll death spiral; scale the run budget to the plan
- fix(proxy): identify the upstream by CAPABILITY, not by llama.cpp's shape
- feat(deliver): capability regression gate — catch a build that runs but does less


## v1.213.0 (2026-08-19)

- feat(models): resolve the local model automatically instead of pinning its name
- fix(deps): better-sqlite3 ^12 for Node 24 — unblocks 294 tests and the version gate
- feat(models): retarget UAP at qwen3.8-27b on ninfer, and stop 404ing local requests


## v1.212.6 (2026-08-19)

- fix(deliver): the WebGL rung was inert — a probe string playwright never called


## v1.212.5 (2026-08-18)

- fix(deliver): put the browser's own error text in the gate verdict


## v1.212.4 (2026-08-18)

- fix(deliver): vm-dom must not judge a WebGL page it cannot run


## v1.212.3 (2026-08-18)

- fix(deliver): make a stripped tool actually unavailable, and probe WebGL before trusting the browser
- fix(test): skip the WebGL assertions when no browser binary is installed


## v1.212.2 (2026-08-18)

- fix(deliver): give the execution gate a real WebGL2 browser


## v1.212.1 (2026-08-18)

- fix(deliver): stop the respawn loop, the whole-file re-emit, and the garbled write path


## v1.212.0 (2026-08-18)

- feat(policy): rtk-wrap becomes opt-in, and stops corrupting parsed output


## v1.211.2 (2026-08-18)

- test: fix two flaky tests, and the vacuity that hid one of them


## v1.211.1 (2026-08-17)

- fix(policy-gate): a schema-diff enforcer that cannot run must not read as consent
- fix(test): run the new enforcer suite in CI


## v1.211.0 (2026-08-17)

- feat(schema-diff): run the checker inline instead of trusting a stored marker


## v1.210.8 (2026-08-17)

- fix(schema-diff): make the gate's evidence mean something


## v1.210.7 (2026-08-17)

- fix(schema-diff): record passes + exempt merge-verbatim files (gate deadlock)


## v1.210.6 (2026-08-17)

- fix(proxy): stop loop-breaking an agent that is waiting on a long job


## v1.210.5 (2026-08-17)

- fix(proxy): make the thinking switches reach the template that reads them


## v1.210.4 (2026-08-17)

- fix(proxy): advertise the context window the proxy actually enforces


## v1.210.3 (2026-08-16)

- fix(proxy): resolve the llama upstream instead of trusting a stale pin


## v1.210.2 (2026-08-16)

- fix(bench): stop leaking cell workdirs into RAM-backed /tmp


## v1.210.1 (2026-08-16)

- fix(deliver): heartbeat during PLANNING-phase model calls too


## v1.210.0 (2026-08-16)

- feat(deliver): heartbeat during model generation — long turns are observably alive


## v1.209.0 (2026-08-15)

- feat(deliver): runs complete by default — orphan continuation, stale-STOP sweep, progress stamping, transient-upstream retry


## v1.208.0 (2026-08-15)

- feat(deliver): surface cooperative stops as 'interrupted', not 'failed'


## v1.207.1 (2026-08-14)

- chore(bench): real-gate-hard agentTimeoutSec -> 1200 for completed-mission measurement


## v1.207.0 (2026-08-14)

- feat(user-paths): derived journeys must anchor to the mission


## v1.206.3 (2026-08-14)

- fix(lease): heartbeat renewal so long decodes keep their model slot


## v1.206.2 (2026-08-14)

- fix(worktree): anchor every subcommand at the MAIN checkout, not the shell cwd


## v1.206.1 (2026-08-14)

- fix(right-sizing): miner skip keys on mission size, not the --auto flag


## v1.206.0 (2026-08-14)

- feat(right-sizing): scope-capped complexity so rails scale with mission size


## v1.205.1 (2026-08-13)

- fix(bench): run deliver missions foreground; refuse detach handoffs as verdicts
- chore: bump version to 1.205.0
- feat(integrity): oracle-consistency recheck behind the additive test-edit carve-out


## v1.205.0 (2026-08-13)

- feat(integrity): oracle-consistency recheck behind the additive test-edit carve-out
## v1.204.2 (2026-08-13)

- fix(bench): materialize workdirs as git repos; attribute preflight refusals


## v1.204.1 (2026-08-13)

- fix(bench): deliver adapter must resolve its CLI against the invoking cwd


## v1.204.0 (2026-08-13)

- feat(protect-tests): sanction append-only test additions to protected test files


## v1.203.5 (2026-08-13)

- fix(user-validation): anchored journey patterns must match real CLI output


## v1.203.4 (2026-08-13)

- fix(models): retry truncated completions and stop corrupting degenerate output


## v1.203.3 (2026-08-13)

- fix(visual-gate): bound the browser launch so an unavailable one skips


## v1.203.2 (2026-08-13)

- fix(snapshot): stop a no-regress revert deleting the run's own state


## v1.203.1 (2026-08-13)

- fix(deliver): stop a run converging on a judge that IS the generator


## v1.203.0 (2026-08-13)

- feat(self-gate): make an authored gate RUN the code, not grade its spelling


## v1.202.0 (2026-08-13)

- feat(delivery): bound a run in wall-clock time, at a calibrated default


## v1.201.1 (2026-08-12)

- fix(delivery): guard the applier against gutting, on calibrated thresholds


## v1.201.0 (2026-08-12)

- feat(gates): fail a crate whose code hides behind a feature it never declares


## v1.200.3 (2026-08-12)

- fix(delivery): stop a path that repeats the project root creating a phantom tree


## v1.200.2 (2026-08-12)

- fix(delivery): make a cooperative stop stop the RUN, not one epic


## v1.200.1 (2026-08-12)

- fix(delivery): tell a model when its edit was ALREADY APPLIED


## v1.200.0 (2026-08-12)

- feat(delivery): refuse writes that switch off the compile gate


## v1.199.1 (2026-08-12)

- fix(delivery): see content edits to untracked files in the tree fingerprint


## v1.199.0 (2026-08-12)

- feat(gates): check feature-gated Rust inside a container, on request


## v1.198.6 (2026-08-12)

- fix(delivery): the TypeScript guard was inert in production


## v1.198.5 (2026-08-12)

- fix(delivery): judge TypeScript writes with the real parser


## v1.198.4 (2026-08-12)

- fix(delivery): refuse a write that leaves the file unparseable


## v1.198.3 (2026-08-12)

- fix(gates): name the feature-gated code the cargo gate cannot see


## v1.198.2 (2026-08-12)

- fix(delivery): a cooperative stop could not stop an epic mission


## v1.198.1 (2026-08-11)

- fix(delivery): look BELOW the root before saying nothing is in flight


## v1.198.0 (2026-08-11)

- feat(delivery): put advancement in the follow ticker, not just a clock
- chore: bump version to 1.196.1
- fix(policies): protect a RUNNING deliver run from being killed


## v1.197.0 (2026-08-11)

- feat(delivery): size the edit fast-path in .uap.json, not env-only
## v1.196.1 (2026-08-11)

- fix(policies): protect a RUNNING deliver run from being killed


## v1.196.0 (2026-08-11)

- feat(delivery): refuse a write that re-adds a definition the file already has


## v1.195.3 (2026-08-11)

- fix(delivery): list_dir cut names in half, run_bash threw away the verdict


## v1.195.2 (2026-08-11)

- fix(proxy): non-streaming turns logged a request and no answer


## v1.195.1 (2026-08-11)

- fix(delivery): read_file hid 97% of a file and never said so


## v1.195.0 (2026-08-11)

- feat(delivery): reuse a recent plan for the same instruction


## v1.194.2 (2026-08-11)

- fix(delivery): a relaunched short mission was "complete" before it started


## v1.194.1 (2026-08-11)

- perf(delivery): stop planning phases for missions too small to have any


## v1.194.0 (2026-08-11)

- feat(delivery): a run before turn 1 is PLANNING, and now says so


## v1.193.2 (2026-08-10)

- fix(cli): unbreak the master publish my own test broke


## v1.193.1 (2026-08-10)

- fix(delivery): a launch stops WATCHING at the caller's budget, not the mission


## v1.193.0 (2026-08-10)

- fix(delivery): size the follow wait to the caller, and add a tool off-switch


## v1.192.0 (2026-08-10)

- feat(delivery): say up front that a deletion mission cannot succeed here


## v1.191.0 (2026-08-10)

- feat(policies): verify tells a superseded enforcer from a tampered one


## v1.190.2 (2026-08-10)

- fix(policies): a stop request must be withdrawable


## v1.190.1 (2026-08-10)

- fix(cli): explain the working directory when add-tool fails
- test(policies): run the new enforcer test in CI


## v1.190.0 (2026-08-10)

- feat(policies): judge a Write on nature AND complexity


## v1.189.3 (2026-08-10)

- fix(delivery): stop advertising a door the gate keeps shut
- fix(policies): drop the pending queue from the protected list


## v1.189.2 (2026-08-10)

- fix(policies): close the heartbeat route to the same lock bypass


## v1.189.1 (2026-08-10)

- fix(policies): the deliver lock and checkpoints are not scratch state


## v1.189.0 (2026-08-10)

- feat(delivery): offer a stop the caller can actually reach


## v1.188.0 (2026-08-09)

- feat(delivery): say up front when a task names files out of scope


## v1.187.8 (2026-08-09)

- fix(delivery): tell the follower how many turns the mission has completed


## v1.187.7 (2026-08-09)

- test(dashboard): measure cadence from the first snapshot, not from connect


## v1.187.6 (2026-08-09)

- test(hooks): scan this tree's hook copies, not other checkouts


## v1.187.5 (2026-08-09)

- fix(delivery): a run stopped by the orphan guard now says so


## v1.187.4 (2026-08-09)

- fix(policies): rtk-wrap judges each statement, closing a bypass


## v1.187.3 (2026-08-09)

- fix(hooks): reading a version is not editing it
- chore(hooks): commit the installed post-tool-use-read hook so worktrees start clean


## v1.187.2 (2026-08-09)

- fix(policies): a deliver run is not the inference stack


## v1.187.1 (2026-08-09)

- fix(reactor): tell the truth about when deliver is required


## v1.187.0 (2026-08-09)

- feat(deliver): a demoted gate blocks again on tests it was passing before


## v1.186.8 (2026-08-09)

- fix(policies): close the self-grant hole on the gateless-root override


## v1.186.7 (2026-08-09)

- fix(deliver): refuse a project root that cannot verify its own work


## v1.186.6 (2026-08-09)

- fix(deliver): stop a run when the model endpoint is unreachable


## v1.186.5 (2026-08-09)

- fix(deliver): warn on a gateless root, and stop no-op edits banking success


## v1.186.4 (2026-08-08)

- fix(deliver): close two loop-causing feedback bugs from a live 2h churn
- fix(proxy): break a loop that keeps SUCCEEDING (#659)
- fix(memory): recall was broken by a client rename, and hidden by a bare catch (#658)
- fix(policies): close the five naive forms the re-review found, with tests (#657)
- feat(policies): make the enforcement surface repair itself (#656)
- fix(policies): close two verified bypasses of the enforcement surface (#655)


## v1.186.3 (2026-08-07)

- fix(proxy): break a loop that keeps SUCCEEDING

## v1.186.2 (2026-08-07)

- fix(memory): recall was broken by a client rename, and hidden by a bare catch
- fix(policies): close the five naive forms the re-review found, with tests (#657)
- feat(policies): make the enforcement surface repair itself (#656)
- fix(policies): close two verified bypasses of the enforcement surface (#655)


## v1.186.1 (2026-08-06)

- fix(policies): close the five naive forms the re-review found, with tests
- feat(policies): make the enforcement surface repair itself (#656)
- fix(policies): close two verified bypasses of the enforcement surface (#655)


## v1.186.0 (2026-08-06)

- feat(policies): make the enforcement surface repair itself
- fix(policies): close two verified bypasses of the enforcement surface (#655)


## v1.185.1 (2026-08-04)

- fix(policies): the fail-closed net never covered Bash — SEC_SENSITIVE scanned
  only file_path, so a broken enforcer fell through to fail-OPEN for every shell
  operation. Verified live: deleting .policy-tools/_common.py disabled all 29
  enforcers at import and the next write to .uap/evidence/ was allowed.
- fix(policies): the gate now restores .policy-tools/_common.py before enforcing,
  and fails closed when it cannot — one missing helper took down the whole surface.
- fix(policies): argument indirection is no longer an escape. self-protect now
  asks "will a protected path be an ARGUMENT to something destructive" instead of
  "is one mentioned anywhere", resolving the argument set from `< file`,
  `--arg-file`, `$(cat f)`, shell wrappers (`bash -c`, `eval`, `env`) and literal
  pipe producers. Where the producer is unknowable (`grep … | xargs sed`) the
  command is ALLOWED rather than guessed at — guessing blocked ordinary refactors.
- fix(policies): PROTECTED_EXEMPT is judged per token, not over the whole text —
  one `policies/waivers` line in a deletion list used to hide every other line.


## v1.185.0 (2026-08-04)

- feat(memory): make stored memories actually durable
- fix(memory): anchor gate evidence to the main checkout so the memory-before-plan
  gate sees it from inside a worktree instead of falling back to the weaker db-row
  route (surfaced only once #653 and this branch were merged together)


## v1.184.6 (2026-08-04)

- fix(policies): put gate evidence where the agent cannot write it


## v1.184.5 (2026-08-04)

- fix(policies): attach enforcers by slug OR title, and close three ship-detection gaps
- chore: stop tracking the per-platform hook copies (#650)
- fix(policies): a ship verb in prose is not a ship action (#649)
- docs(policies): an enforcer edit reaches the gate only via the running package (#648)


## v1.184.4 (2026-08-04)

- chore: stop tracking the per-platform hook copies
- fix(policies): a ship verb in prose is not a ship action (#649)
- docs(policies): an enforcer edit reaches the gate only via the running package (#648)


## v1.184.3 (2026-08-04)

- fix(policies): a ship verb in prose is not a ship action
- docs(policies): an enforcer edit reaches the gate only via the running package (#648)


## v1.184.2 (2026-08-04)

- docs(policies): an enforcer edit reaches the gate only via the running package


## v1.184.1 (2026-08-04)

- fix(policies): scope the plan-time gates correctly, and close three containment bypasses


## v1.184.0 (2026-08-03)

- feat(principles): apply engineering principles to agent and generated code


## v1.183.3 (2026-08-03)

- fix(policies): give the plan-time gates the writers they check for


## v1.183.2 (2026-08-03)

- fix(proxy): tool narrowing stranded any client that isn't Claude Code


## v1.183.1 (2026-08-03)

- fix(bench): held-out difficulty must use the schema enum (metadata only)


## v1.183.0 (2026-08-03)

- feat(bench): pre-registered held-out task set, with the registration enforced in code


## v1.182.1 (2026-08-03)

- fix(bench): a CI that clears zero while p does not is BORDERLINE, not a win


## v1.182.0 (2026-08-02)

- feat(bench): replace the ten ceiling tasks with genuinely hard ones


## v1.181.1 (2026-08-02)

- fix(bench): disclose completion_budget in bench cards, not just `uap harness`


## v1.181.0 (2026-08-02)

- feat(bench): power suite that can resolve a real effect, and fix the budget starving it


## v1.180.0 (2026-08-02)

- fix(bench): refuse to report a delta from a run that measured nothing


## v1.179.12 (2026-08-02)

- fix(deliver): refuse a finish from a turn that changed nothing


## v1.179.11 (2026-08-02)

- feat(deliver): never-regress ON by default


## v1.179.10 (2026-08-02)

- fix(execution-gate): start the page, so "nothing started" is visible


## v1.179.9 (2026-08-01)

- fix(proxy): don't retry a truncated write with less room than already failed


## v1.179.8 (2026-08-01)

- fix(deliver): ground the forced-write round instead of blinding it


## v1.179.7 (2026-08-01)

- fix(proxy): scope .uap/proxy.env discovery, and fail closed on an open bind


## v1.179.6 (2026-08-01)

- test(ci): run the Python proxy + delivery suites in CI (483 -> 771 tests)


## v1.179.5 (2026-08-01)

- fix(proxy): retry 503 "Loading model" on the streaming path too
- fix: ship as 1.179.4 — 1.179.3 is already published
- chore: bump version to 1.179.3
- fix(policy): close laundered and bare-PID kills of the stack and deliver


## v1.179.4 (2026-07-31)

- fix(deliver): answer "is it still running" with evidence, not an assertion


## v1.179.3 (2026-07-31)

- fix(policy): close laundered and bare-PID kills of the stack and deliver


## v1.179.2 (2026-07-31)

- fix(proxy): ERROR-LOOP must read the is_error flag, not sniff file contents


## v1.179.1 (2026-07-31)

- fix(policy): stop the plan gate tracking files it can never validate
- chore: bump version to 1.178.1
- fix(policy): make disable actually disable, and say so only when it did


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
## v1.179.0 (2026-07-31)

- fix(plan): recover a plan gate wedged on an entry validation refuses
- fix(memory): hot-path defects in the agent wiring found by review


## v1.178.1 (2026-07-31)

- fix(policy): make disable actually disable, and say so only when it did
- fix(memory): hot-path defects in the agent wiring found by review


## v1.178.0 (2026-07-31)

- feat(memory): wire active reconstruction into the AGENT context path
- fix(merge): restore test_validate_plan_gate to test:enforcers
- chore: bump version to 1.177.0
- feat(memory): connect active reconstruction — ingestion bridge, callers, honest coverage
- chore: bump version to 1.176.0
- feat(harness): edit-tool ladder, evidence corpus, manifests, tool search space, memory substrate


## v1.177.0 (2026-07-31)

- feat(memory): connect active reconstruction — ingestion bridge, callers, honest coverage


## v1.176.0 (2026-07-31)

- feat(harness): edit-tool ladder, evidence corpus, manifests, tool search space, memory substrate


## v1.175.13 (2026-07-31)

- fix(plan): stamp the file the operator named, not only the reviewed one


## v1.175.12 (2026-07-31)

- fix(policy): validate the plan BEFORE the build, not on the plan write
## v1.175.11 (2026-07-31)

- fix(deliver): reclaim an abandoned lock, don't wait on a recycled PID


## v1.175.10 (2026-07-31)

- test(enforcers): make the escape-hatch suite hermetic, not ambient


## v1.175.9 (2026-07-31)

- fix(proxy): a successful tool result is not a failure, whatever its prose


## v1.175.8 (2026-07-31)

- test: point the last two enforcer fixtures at source, and guard the rule
- test(hooks): read enforcers from source, not from generated .policy-tools


## v1.175.7 (2026-07-31)

- chore(policies): stop tracking .policy-tools/, it is generated


## v1.175.6 (2026-07-31)

- fix(policies): match policies by slug so enforcers actually attach


## v1.175.5 (2026-07-31)

- fix(policy): single-flight cannot be switched off from the agent's own command line


## v1.175.4 (2026-07-31)

- fix(proxy): the harness's own correctives are not tool failures


## v1.175.3 (2026-07-31)

- fix(mcp): a healthy follow poll is not a failed tool call


## v1.175.2 (2026-07-30)

- fix(mcp): restore mangled deliver CLI flags, and stop follow re-sending the brief


## v1.175.1 (2026-07-30)

- fix(deliver): size the follow budget to the CLIENT, not to the server


## v1.175.0 (2026-07-30)

- feat(deliver): follow an in-flight run instead of relaunching it


## v1.174.1 (2026-07-30)

- fix(deliver): honour the --json contract on early exits


## v1.174.0 (2026-07-30)

- feat(delivery): close the run_bash hole in the stub guard with a turn-end sweep


## v1.173.0 (2026-07-30)

- feat(delivery): refuse stub writes, and stop "it loads" from being sufficient


## v1.172.15 (2026-07-30)

- fix(policy): make both operator overrides environment-only, not self-grantable


## v1.172.14 (2026-07-30)

- fix(proxy): capture the disconnect in a pure-ASGI watcher, outside BaseHTTPMiddleware


## v1.172.13 (2026-07-29)

- fix(proxy): make the disconnect check a choke point instead of a per-call claim


## v1.172.12 (2026-07-29)

- fix(proxy): cancel the upstream generation when the caller hangs up mid-turn


## v1.172.11 (2026-07-29)

- fix(proxy,deliver): abandon work when the session that ordered it is gone


## v1.172.10 (2026-07-29)

- perf(inference): size the prompt cache to the measured working set (16 -> 32 GiB)


## v1.172.9 (2026-07-29)

- fix(vision): bound the vision-model calls so verify cannot hang on a busy model
- Revert "fix(test): budget the visual-gate test above the gates it actually runs"
- fix(test): budget the visual-gate test above the gates it actually runs
- fix(delivery,self-tuning): authenticate the proxy side-endpoint probes


## v1.172.8 (2026-07-29)

- fix(models,test): find the proxy token from any project; stop vitest killing the execution gate


## v1.172.7 (2026-07-29)

- fix(policy): infra-protect also scans the body of scripts a command invokes


## v1.172.6 (2026-07-29)

- fix(proxy,worktree): stale mandate flag on tool-less turns; base worktrees on the ahead ref


## v1.172.5 (2026-07-29)

- fix(test): bind the dashboard tests to an OS-assigned port instead of a fixed one


## v1.172.4 (2026-07-29)

- fix(proxy): the deliver mandate now outranks recon convergence


## v1.172.3 (2026-07-29)

- fix(test): resolve tsx by walking up, so the suite (and version bumps) work in worktrees
- fix(models): recover PROXY_AUTH_TOKEN from .uap/proxy.env so MCP-spawned UAP can authenticate
- perf(inference): Gemma ctx 262144 as 2 x 131072 slots
- perf(inference): partition ctx into 130k slots on both profiles; port Qwen to upstream binary
- perf(inference): move Gemma 26B to upstream llama.cpp, drop MTP, take full 262144 ctx
- fix(inference): correct Gemma 26B profile to the flags and VRAM this box actually has
- feat(inference): Gemma 4 26B-A4B MoE profile with MTP speculative decoding


## v1.172.2 (2026-07-29)

- fix(proxy): pin the mandated tool with 'required' + narrowing, not the OpenAI object form


## v1.172.1 (2026-07-26)

- fix(interaction): deliver the six follow-ups, plus what review found in them


## v1.172.0 (2026-07-26)

- fix(vision): corroborate findings, and demote the aesthetic judge to advisory
- fix(interaction): isolate probes, add aimAt, and stop three false verdicts


## v1.171.0 (2026-07-26)

- feat(verify): interaction gate — prove promised behaviour under real input
- docs(proxy): sync PROXY_AUTH_TOKEN comment with X-Api-Key acceptance
- chore: bump version to 1.170.1
- fix(proxy): accept x-api-key as a shared-secret token source
- fix(policies): gates must match commands, not prose that mentions them (#597)


## v1.170.1 (2026-07-24)

- fix(proxy): accept x-api-key as a shared-secret token source


## v1.170.0 (2026-07-24)

- fix(deliver): surface the real gate, bound the ladder cost, cap the contract


## v1.169.0 (2026-07-24)

- chore: bump version to 1.168.0
- fix(worktree): prune could delete every worktree, including on --dry-run
- chore: bump version to 1.167.0
- fix(worktree): never mistake a LIVE worktree for abandoned work
- feat(execution-gate): catch a canvas app whose render loop never runs or FREEZES on start
- chore: bump version to 1.166.0
- feat(policy): install branch-freshness gate + rewrite coord-overlap
- chore: bump version to 1.165.1
- fix(coordination): address parallel expert review — drift check was inert
- chore: bump version to 1.165.0
- feat(coordination): keep parallel agents fresh and collision-free


## v1.168.0 (2026-07-24)

- fix(worktree): prune could delete every worktree, including on --dry-run


## v1.167.0 (2026-07-24)

- fix(worktree): never mistake a LIVE worktree for abandoned work


## v1.166.0 (2026-07-24)

- feat(policy): install branch-freshness gate + rewrite coord-overlap
- chore: bump version to 1.165.1
- fix(coordination): address parallel expert review — drift check was inert
- chore: bump version to 1.165.0
- feat(coordination): keep parallel agents fresh and collision-free
- fix(policies): iac gate must look the PR up in the repo being merged (#592)
- feat(skills): record-walkthroughs — automated product walkthrough videos (#591)
- chore: bump version to 1.164.0
- feat(proxy): run the operational dashboard as part of the uap proxy
## v1.165.1 (2026-07-24)

- fix(coordination): address parallel expert review — drift check was inert
- chore: bump version to 1.165.0
- feat(coordination): keep parallel agents fresh and collision-free
- fix(policies): iac gate must look the PR up in the repo being merged (#592)
- feat(skills): record-walkthroughs — automated product walkthrough videos (#591)
- chore: bump version to 1.164.0
- feat(proxy): run the operational dashboard as part of the uap proxy
- docs: rewrite documentation to pure current-state (no change-over-time)
- fix(deliver): address deep-rewire review findings (tier-guard + tuner wiring)
- feat(models): Q4-full route selectModel through the canonical per-phase source
- feat(deliver): 3a wire MIPRO fragments into defaultPromptBuilder (no-op default)
- feat(models): Q4 canonical per-phase selector + 3a frozen-fragment binding
- feat(models): Q2 route router.classifyTask through the unified classifier
- feat(deliver): Q3 judge derives from the preset review chain
- fix(deliver): address integration-batch review findings
- feat(self-tuning): tuner prompt-dimension adapter (S8 -> optimizer)
- feat(deliver): S7 write-conflict edges wired at the DeliveryPhase layer
- feat(deliver): reflectProvider seam — the async GEPA reflect turn
- feat(deliver): per-phase escalation controller (S5 -> loop, execute phase)
- feat(deliver): wire GEPA reflect (mutateInstruction) into the convergence loop
- fix(deliver): address S4-S8 review findings (frozen-fragment trap, scope dedupe)
- feat(self-tuning): S8 MIPRO tunable prompts (with frozen safety fragments)
- feat(deliver): S7 graph-engineering safety (false-independence, silent-node, fan-in)
- feat(deliver): S6 GEPA reflect phase (Pareto archive + approach rewrite)
- feat(deliver): S5 per-phase escalation (hybrid policy)
- feat(coordination): S4 effort-dial orchestration profiles
- fix(deliver): address S1-S3 parallel-review findings
- feat(models): S3 per-phase x per-tier routing matrix
- feat(models): S2 unified complexity classifier (preserves critical)
- feat(deliver): S1 verification hardening — distinct judge, provenance banner


## v1.165.0 (2026-07-24)

- feat(coordination): keep parallel agents fresh and collision-free
- fix(policies): iac gate must look the PR up in the repo being merged (#592)
- feat(skills): record-walkthroughs — automated product walkthrough videos (#591)
- chore: bump version to 1.164.0
- feat(proxy): run the operational dashboard as part of the uap proxy
## v1.164.0 (2026-07-24)

- feat(proxy): run the operational dashboard as part of the uap proxy


## v1.163.13 (2026-07-23)

- fix(visual-gate): dismiss intro overlays so the judge grades the app, not the veil


## v1.163.12 (2026-07-23)

- fix(test): D10 accepts the canonical agents/docker-compose.yml (qdrant + TEI)
- feat(embeddings): migrate :8081 embedding server from llama.cpp to TEI


## v1.163.11 (2026-07-23)

- fix(deliver): --keep-best keeps the BEST turn; thickening honors ACCEPTANCE=0


## v1.163.10 (2026-07-22)

- fix(self-gate): reject a BROKEN gate, not just a vacuous one


## v1.163.9 (2026-07-22)

- fix(deliver): let the agent READ .uap/user-paths.json — it is a spec, not internal state


## v1.163.8 (2026-07-22)

- fix(verify): build/run gates first — visual + aesthetic only after they pass


## v1.163.7 (2026-07-22)

- fix(visual-gate): click real DOM start controls, not just the canvas


## v1.163.6 (2026-07-22)

- refactor(delivery): deliver the deferred follow-ups from #570/#571


## v1.163.5 (2026-07-21)

- fix(policy): stop the browser matcher false-blocking ordinary read-only work


## v1.163.4 (2026-07-21)

- fix(deliver+visual-gate): deliver the documented review follow-ups


## v1.163.3 (2026-07-21)

- test: fix the two flakes that intermittently failed the full-suite bump gate
- fix(visual-gate): drive a start interaction so games are judged on gameplay, not their menu


## v1.163.2 (2026-07-21)

- fix(deliver): force a write when the agentic read-loop ignores the soft nudge


## v1.163.1 (2026-07-20)

- fix(delivery): reap leaked browsers, blame the right file, break stuck loops


## v1.163.0 (2026-07-19)

- feat(deliver): wire the P1 contract-lint gate to production (structural divergence catcher)


## v1.162.1 (2026-07-19)

- fix(deliver): #2 wedge handling done safely — per-tool-call heartbeat + cooperative watchdog


## v1.162.0 (2026-07-19)

- chore: bump version to 1.161.0
- chore(test): raise timeout on the src/index.js barrel-import test
- fix(deliver): P3 anti-gutting guard — refuse write_file that guts a real file
- feat(deliver): P1 contract-first — carry the shared contract VERBATIM into every epic
- fix(deliver): P0 reliability — autoroute single-flight + lock wedge-reclaim


## v1.161.24 (2026-07-19)

- fix(delivery): recover cap-truncated plans by re-parsing the planner's own output


## v1.161.23 (2026-07-19)

- fix(delivery): converge against the fidelity-max vision bar in-loop


## v1.161.22 (2026-07-19)

- fix(delivery): criterion-aware evidence slices for the acceptance judge


## v1.161.21 (2026-07-18)

- fix(delivery): per-script vm units + duplicate-declaration detection


## v1.161.20 (2026-07-18)

- fix(hooks): deliver_autoroute dedups per change (file#sha1(edit)), not per file
- fix(delivery): --pending replay is replay-once — consume applied intents, guard insertion re-application


## v1.161.19 (2026-07-18)

- fix(delivery): defer missing-script smoke failures on non-final epics


## v1.161.18 (2026-07-18)

- fix(delivery): name the files behind anonymous 404s in user-path feedback


## v1.161.17 (2026-07-18)

- fix(delivery): reject self-gates that anchor paths to their own directory


## v1.161.16 (2026-07-18)

- fix(delivery): failed epics tell the split planner WHY — plus a visual-floor directive


## v1.161.15 (2026-07-17)

- fix(delivery): mission-file floor — the split can no longer omit named deliverables


## v1.161.14 (2026-07-17)

- fix(delivery): the split planner now sees the accumulated code shape


## v1.161.13 (2026-07-17)

- fix(delivery): visual richness floors defer to the final epic


## v1.161.12 (2026-07-17)

- fix(delivery): separator-insensitive spec-symbol matching for evidence priority


## v1.161.11 (2026-07-17)

- fix(delivery): read-only-streak write nudge — the sweep epic read forever


## v1.161.10 (2026-07-17)

- fix(delivery): evidence-truncation honesty — the judge failed implemented code as missing


## v1.161.9 (2026-07-17)

- fix(delivery): truncated-emit guard — refuse the cut-off write, steer to edit_file


## v1.161.8 (2026-07-17)

- fix(delivery): deterministic fallback journey — the terminal gate must never silently vanish


## v1.161.7 (2026-07-17)

- fix(delivery): unborn-HEAD repos broke change detection — the underlying no-op-trap root cause


## v1.161.6 (2026-07-17)

- fix(delivery): retry the journey miner once — one flake removed the terminal gate


## v1.161.5 (2026-07-17)

- fix(delivery): manifest-server spawn crash — unhandled error killed the whole run


## v1.161.4 (2026-07-16)

- fix(delivery): count prior-ATTEMPT writes for the anti-no-op rail


## v1.161.3 (2026-07-16)

- fix(delivery): phase-cap truncation — the root cause of every truncated plan


## v1.161.2 (2026-07-16)

- fix(delivery): self-gate path anchoring + planner retry — two live retest findings


## v1.161.1 (2026-07-16)

- fix(delivery): deterministic canvas-text sanitizer for mined user paths


## v1.161.0 (2026-07-16)

- feat(delivery): resolve all six PR #536 follow-ups — finality seeding, env safety, fail-closed judge, plan gap-closure, config escalation, manifest compat


## v1.160.1 (2026-07-16)

- test: 60s timeout on first src/index.js barrel-import test (load flake)
- fix(delivery): unblock 100% epic delivery — prior-changes inheritance, web-entry docroot, canvas-aware journeys


## v1.160.0 (2026-07-16)

- chore: bump version to 1.159.0
- chore: bump version to 1.159.0
- feat(policy): "never go full" commitment-restraint family — reserve gate, doubling-down breaker, saturation lint
- fix(delivery): don't fail a trailing epic as a no-op when prior epics changed the tree
- fix(delivery): scope whole-mission user-validation to the final epic
- feat(delivery): opt-in coherent-mission routing (one epic run, not per-file)
- fix(delivery): make bash heredoc writes (`cat > FILE << EOF`) replayable
- fix(delivery): apply blocked replayable edits via deterministic --pending replay
- fix(policies): infra-protect blocks broad `pkill -f uap` self-kill


## v1.159.0 (2026-07-16)

- fix(delivery): coherent multi-file builds — the whole fix stack that takes a mission from "files land but don't integrate" to a clean `DELIVERED`:
  - deterministic `--pending` replay applies gate-blocked Write-tool and `cat > FILE << EOF` heredoc writes to disk (#529, #530)
  - opt-in coherent-mission routing (`UAP_DELIVER_COHERENT_MISSION`): route a blocked source write's whole mission to one `uap deliver --epics` run instead of the per-file side-channel (#531)
  - scope whole-mission `user-validation` to the final epic so early epics aren't gated on the finished app (fixes phaseIndex frozen at 0) (#532)
  - don't fail a trailing epic as a no-op when prior epics already changed the tree — defer to the acceptance judge (fixes the "already delivered" re-split churn) (#533)


## v1.158.0 (2026-07-16)

- feat(delivery): round 7 — orchestrated resume fidelity (completes the resume matrix)


## v1.157.0 (2026-07-16)

- feat(delivery): round 6 — registry simplification + budget-decode echo hardening


## v1.156.0 (2026-07-16)

- refactor(delivery): round 5 — mission-acceptance extraction (the spec registry's consumer twin)


## v1.155.0 (2026-07-16)

- feat(delivery): round 4 — spec-registry module, budget wire-protocol codec, deterministic epic resume


## v1.154.0 (2026-07-15)

- feat(delivery): round 3 — phased-mission extraction, runnerKind resume safety, sanitizer hardening, changed-files module, marker deprecation executed


## v1.153.0 (2026-07-15)

- feat(delivery): PR #519 follow-ups — resume routing, structured budget signal, live criteria, watch-ci extraction, single-source redetect-merge


## v1.152.0 (2026-07-15)

- refactor(delivery): extract runEpicMission behind seams — the default path is now unit-tested


## v1.151.0 (2026-07-15)

- refactor(delivery): extract runOrchestratedMission behind seams; epic-path parallel dispatch; P5 NEW_TASKS deps fix
- fix(worktree): a worktree with no hooks bypasses every gate (v1.149.6) (#517)
- chore: bump version to 1.150.1
- chore: bump version to 1.150.0
- feat(delivery): worktree-isolated parallel dispatch — the safe production consumer for ATG concurrency


## v1.150.2 (2026-07-14)

- fix(worktree): **a worktree had NO hooks — a hole straight through every gate.** `git worktree add` materializes only TRACKED files, and the hook scripts are untracked, so a fresh worktree came up with no `.opencode/hooks`: **no gate ran at all**, and an agent working there wrote source **completely ungated** — no routing to deliver, no self-protect, no infra-protect. Observed live: the opencode client was working inside `.worktrees/001-dev-environment-setup` with zero enforcement present, and **nothing was being routed** (no `pending-deliver.jsonl`, no `autoroute.log`) because no hook existed to route it. Every "all work goes through deliver" guarantee was void inside that directory. `uap worktree` now installs the hooks into each new worktree. Only the hook FILES need to travel — the gate already anchors the policy DB and the enforcers to `MAIN_ROOT`, so a worktree inherits the parent's 34 policies automatically once a hook is there to run. `uap worktree` also wires the **deliver tool** (MCP router) into the worktree — hooks alone are INERT for opencode, whose gate runs from the `.opencode` plugin, so installing the scripts without the plugin and MCP wiring leaves files sitting there doing nothing, which *looks* fixed and is not. If any of this fails, worktree creation still succeeds but warns **loudly** that work there will be UNGATED.

## v1.150.1 (2026-07-14)

- chore: bump version to 1.150.0
- feat(delivery): worktree-isolated parallel dispatch — the safe production consumer for ATG concurrency


## v1.150.0 (2026-07-14)

- feat(delivery): worktree-isolated parallel dispatch — the safe production consumer for ATG concurrency


## v1.149.5 (2026-07-14)

- fix(agentic-executor): **the dedup guard withheld file content and deadlocked the agent — my own regression from v1.148.21.** That guard answered a repeated read of an unchanged file with *"UNCHANGED — act on what you already have"* **instead of the content**. But the model re-reads a file for a REASON: its context was pruned, or the agent session is fresh and it never had the content at all. Denying it the content leaves it unable to proceed — so it asks again. Live result: **76 re-reads of one file, 64 nudges fired, and ZERO writes in 36 minutes.** The guard caught the loop and then guaranteed it. The content is now **always served**, with the nudge prepended — so repetition costs a line, not the mission. Exactly the same failure as the phantom `run_bash`, the unreadable acceptance gate, the "stop writing" order and the raw `EISDIR`: the harness punishing a reasonable move. This one was self-inflicted.

## v1.149.4 (2026-07-14)

- fix(deliver): **the zero-test gate was enforced in `uap verify` but NOT in deliver — so a mission could still report "✓ Delivered, all required gates pass" on a crate with no tests at all.** v1.148.25 taught the ladder that a test rung exiting 0 having run ZERO tests is not a pass, and wired it into `uap verify` at max fidelity. But deliver's own convergence loop never passed `requireTestsRan`, and **deliver's ladder is the gate that decides DONE** — so the real door stayed open, and a live mission delivered an untested Rust crate through it. Deliver now resolves the project fidelity and enforces the same rule. Below max fidelity the behaviour is unchanged (reported, not blocking).

## v1.149.3 (2026-07-14)

- fix(agentic-executor): **`read_file` on a directory threw a raw `EISDIR` the model could not act on — so it retried, and the ERROR-LOOP guard fired.** Its intent was never in doubt: it wanted to see what was in there. It now gets the **listing**, plus a note naming `list_dir` for next time. Same principle as removing the phantom `run_bash` from the tool menu and letting the agent read its own acceptance gate: stop punishing the model for a reasonable move the harness handled badly. A wasted turn becomes a useful one. Reading a real file, and a genuinely missing path, are unchanged.

## v1.149.2 (2026-07-14)

- fix(test/preflight): deliver no longer poisons its own test gate; config churn ended
- docs: add ATTRIBUTION.md crediting research + OSS inspirations (ATG paper, vLLM-SR, loop-engineering, DESIGN.md)
- chore: bump version to 1.149.1
- chore: bump version to 1.149.0
- feat(delivery): ATG uplifts — pre-execution plan validation, minimal node repair, dependency-aware parallel dispatch


## v1.149.1 (2026-07-14)

- chore: bump version to 1.149.0
- feat(delivery): ATG uplifts — pre-execution plan validation, minimal node repair, dependency-aware parallel dispatch


## v1.149.0 (2026-07-14)

- feat(delivery): ATG uplifts — pre-execution plan validation, minimal node repair, dependency-aware parallel dispatch

## v1.148.25 (2026-07-14)

- fix(verifier-ladder): **Rust tests did not block — a Rust project could deliver with FAILING tests.** `cargo-test` carried a lone, uncommented `required: false`, while every other language's test rung (npm `test`, `pytest`, `ctest`, `go-test`, `dotnet-test`) blocks. Rust is now consistent with the rest. A pre-existing red suite is not punished: baseline-delta gating already demotes rungs that were failing at preflight, so only NEW breakage blocks.
- fix(verifier-ladder): **"there were no tests" must never read as "the tests passed".** The ladder decides on EXIT CODE alone, so a suite with ZERO tests is indistinguishable from one that passed — `cargo test` on a crate with no tests exits 0. A live mission delivered a Rust crate whose entire test result was `0 passed; 0 failed`: compiled, gated, "delivered", and **never tested at all**. New `testsActuallyRan()` reads the runner's own output (cargo, pytest, go, vitest/jest, dotnet, ctest); a test rung that passed having run zero tests is flagged, reported plainly, and at **max fidelity it BLOCKS**. It returns null for a runner it cannot read — we never block on a guess.

## v1.148.24 (2026-07-14)

- fix(agentic-executor): **never order the agent to do something only more writing can fix.** After every Rust write, the per-write `cargo check` answered ANY failure with *"fix these BEFORE writing anything else"*. But a multi-file crate **cannot compile until its module tree is whole**: write `main.rs` with `use mycrate::types::*` and cargo rightly reports an unresolved import until `types/mod.rs` lands. Those errors are not defects — they are the scaffold being incomplete, and they resolve themselves as the agent keeps writing. Ordering it to STOP writing was a deadlock: the only possible fix was the very thing it had just been forbidden. On a live mission the agent obeyed, retried, and the identical repeated message drove the proxy's ERROR-LOOP guard to fire **18 times**. Unresolved-module errors (E0432/E0433/E0583/E0463 and friends) are now reported as EXPECTED with an explicit *"KEEP WRITING the missing modules"*; a genuinely broken build (a type error, a syntax error) still says fix it first. A mixed set counts as real — a type error is never excused by a missing module.

## v1.148.23 (2026-07-14)

- fix(agentic-executor): **the agent could not read the acceptance gate it was judged against.** `.uap-deliver/verify.sh` is the self-authored acceptance script — it IS the specification the agent must satisfy — but it sat inside `.uap-deliver/`, which the agent-internal path guard blanket-blocked as "internal state". So the agent could not see its own criteria, and it looped trying: **6 refused reads in one live mission, with the proxy's ERROR-LOOP firing 5 times**, while the spec it needed was one refusal away. The gate is now **readable**, and **still unwritable** — reading it means targeting the real criteria; rewriting it would be the agent rigging its own gate, which is not passing it. Every other internal path (`.uap/`, `.git/`, run state) stays blocked exactly as before.

## v1.148.22 (2026-07-14)

- feat(init/preflight): **every enforcement surface is now ON by default — a scaffolded project was only enforcing a fraction of what it appeared to.** Three defaults were silently absent from a fresh (or freshly RESET) project, each downgrading the pipeline while it still *looked* configured: (1) **`fidelity: max` was unset**, so the visual, vision and acceptance gates ran ADVISORY rather than blocking — a deliverable could read as verified while nothing actually gated it; (2) **`delivery: {enforcement: block, localMode: deliver, runtimeVerify: true}` was unset**, so work was not reliably routed through `uap deliver`; (3) **`uap init` seeded only 2 of 34 policies** (delivery-enforcement + self-protect) — the other 32 were merely *available*, including **`enforcement-infra-protect`**, the policy that stops a model killing llama-server and stealing its port (which one has actually done). All three now come up on their own: init installs + enables **every** built-in policy with its enforcer attached, and the preflight self-heal seeds the full config posture — so existing projects heal on their next `deliver`, not just new ones. An EXPLICIT operator value is never overridden: this sets the default, it does not take the choice away (`uap policy disable <name>` still works).


## v1.148.21 (2026-07-14)

- fix(agentic-executor): **stop advertising a tool we refuse to run — it was burning three quarters of the turn budget.** `run_bash` was offered in the tool schema unconditionally and then REFUSED at execution time whenever the run was not sandboxed. The model does what the menu says: on a live mission it spent **58 of its 79 tool calls on `run_bash` — every one bounced** — and managed only 21 writes. And it was not probing the sandbox: every attempt was read-only (`cat` ×44, `wc`, `find`, `ls`, `head`); it simply reached for the shell it had been shown. The tool list is now built from what will actually execute, so a disabled `run_bash` never appears. The execution-time containment check stays as the backstop.

- fix(agentic-executor): **stop re-serving reads the agent already has — a 63-minute mission was stuck on phase 0 of 6 re-exploring the same ground.** It made 171 `list_dir` calls, of which 46 were the SAME `src/types`, 45 the same `.`, 37 the same `src`, plus 23 re-reads of one file: roughly 60% of its tool calls were re-derivations of what it already knew, so it never got far enough to finish a phase. The proxy's RECON CONVERGENCE guardrail cannot catch this — it fires on a NO-WRITE streak, and this agent *does* write (39 times), so the streak keeps resetting while it re-lists the same directory for the 46th time. Deliver's own loop now detects an identical read of an **unchanged** path (by mtime) and returns a short steer instead of the payload. A re-read AFTER the agent writes the file always goes through: handing it a stale view of its own edit would be far worse than a wasted call.

- fix(deliver): **a mission now outlives the tool call that started it — the reason nothing was ever landing.** A coding agent runs shell commands in a bounded tool call: opencode puts each `bash -c …` in its own session and **kills that process group** when the call ends or times out. A model invoking `uap deliver` from its bash tool was therefore spawning a long mission inside a short-lived container, and the mission died wherever it happened to be. Live lifetimes were 531s, 258s, 34s, 0s, 291s — not timeouts, just *whenever the tool call happened to end* — and across an hour of client activity **not one change was ever committed**. (The autoroute hook already spawned with `start_new_session=True` and was immune; only the direct, model-invoked path was exposed.) `uap deliver` now re-launches itself into its **own session** — beyond the reach of a process-group kill — and the foreground wrapper mirrors the mission's output. When the client tears the tool call down, the wrapper dies and **the mission keeps running to completion**, resumable and recorded. An interactive run (stdout is a TTY) is untouched, so a human still gets live output and a working Ctrl-C; `UAP_DELIVER_NO_DETACH=1` forces the old behaviour. The child streams to a **file**, never a pipe held by the wrapper — a pipe whose reader is killed would hand the mission EPIPE and take it down anyway, defeating the whole point.


## v1.148.20 (2026-07-14)

## v1.148.19 (2026-07-14)

- feat(deliver): **a run can now say how it DIED.** Client-spawned deliver runs were vanishing within seconds while the identical binary run from a shell worked fine — and every corpse looked the same (`status: 'running'`, a dead pid, nothing else), so a killed mission was indistinguishable from a working one and there was no way to learn who killed it. Deliver now installs signal handlers and records its own death to `.uap/deliver-exits.log` and onto the run state: **SIGHUP** (the parent tore down our process group), **SIGTERM** (something deliberately killed us), **SIGINT**, or a normal exit code — plus the **ppid**, which names the killer. No record at all against a dead pid means SIGKILL (no handler can run for that). `status` is deliberately left as `running` because that is what `--resume` looks for; the death is recorded *alongside* it, not instead of it. Recording is best-effort and can never take a run down with it.

## v1.148.18 (2026-07-14)

- fix(self-gate): **a BROKEN gate script was installed as if it were a STRICT one, and then failed every turn forever.** Two defects compounded. (1) `extractScript` required a *closing* ``` fence, so when the model's gate-authoring response was **truncated** mid-script there was no match and the entire raw response — opening ````bash` line included — was written into `.uap-deliver/verify.sh`; bash died on line 2 with `unexpected EOF while looking for matching \``. (2) Worse, a syntax error is **not** a spawnError: bash spawns fine and exits non-zero, and the authoring loop read "non-zero on the unsolved repo" as *proof of a strict gate* — so it accepted and installed the broken script. Every subsequent turn then failed on a shell syntax error the model could neither see nor fix (a phantom failure, same class as the WebGL blank-canvas bug). Now: the closing fence is optional (a truncated response is unwrapped correctly), and every candidate script must **parse** (`bash -n`) before it is installed — a script that cannot run is not a gate. A parse failure is fed back to the model ("no fences, and make sure it is complete") and the gate is regenerated. A valid script that *fails at runtime* is still accepted: failing on the unsolved repo is the gate doing its job.


## v1.148.17 (2026-07-14)

- fix(init/deliver): **a fresh scaffold could not deliver, and never said so.** `uap init` did not `git init` the project — and deliver runs every candidate in a **git worktree**, so deliver, epics, orchestration and tasks were ALL dead in a newly-scaffolded repo. The mission simply made no progress; nothing reported why. `uap init` now initialises a repo (+ baseline commit) when the project is not one, and `uap deliver` **preflights** the project and refuses to start with the exact fix command rather than burning a whole turn budget on a mission that cannot land. A `--dry-run` only plans (no worktree), so the requirement correctly does not apply to it.
- fix(deliver): **the always-on orchestrate/epics posture silently vanished on a scaffold reset.** `deliver.orchestrate` / `deliver.epics` were not seeded by `uap init`, so a fresh `.uap.json` left them unset and nothing forced decomposition. Both `init` and deliver's preflight now **self-heal** an absent key to `"on"` (the intended posture) through one shared implementation, so the two can never drift. An explicit `false`/`"off"` is an operator decision and is never overridden.


## v1.148.16 (2026-07-14)

- fix(verify): **`uap verify` could pass VACUOUSLY — the single worst failure mode in the stack.** The `rungs.length === 0` branch returned exit 0 *before* the visual, vision and behavioral gates ran. A single-file web app has no build/test rungs, so a deliverable with no `package.json` was validated by **nothing at all** — and because the completion gate calls `uap verify` unstrict, it saw exit 0 and let the model claim DONE. On the live deliverable this printed `SKIP: no verifiable gates detected` and exited 0, at `fidelity: max`. Now: if entry pages exist, the render gates **still run**; if there is genuinely nothing to look at *and* nothing to run, it is an honest SKIP — but it fails **CLOSED** under `--strict` or max fidelity, because "we could not check anything" must never be reported as "verified".
- fix(execution-gate): **the execution gate and the visual gate disagreed about what a deliverable IS.** `findWebEntryDir` recognized only `index.html`, while `discoverEntryPages` already accepted any `.html`. The live deliverable was `rubiks-cube.html` — so it got **no execution rung**, which is precisely what left the ladder empty and triggered the vacuous pass above. Any entry `.html` now counts (`index.html` still preferred), and the chosen entry page is threaded through the static server, the browser path and the vm-DOM harness, all of which previously hard-coded `index.html`.
- fix(execution-gate): a **CDN `<script src>` is not a missing file.** The vm-DOM harness resolved every script against the filesystem, so `https://cdnjs.cloudflare.com/.../three.min.js` read as "does not exist" and hard-failed a page that renders perfectly (the vision judge scored the same page 9/10). Remote scripts now skip-pass to the real browser + visual gate, which can actually fetch them; a genuinely missing **local** script still fails.
- fix(policy): the GUI-browser gate was **bypassable by path**. The regex required the browser name immediately after a command separator, so `nohup /home/u/.cloakbrowser/chromium-146/chrome file:///x.html &` — the invocation a model actually reaches for — walked straight through. Browsers are now matched by basename anywhere a command word can start (incl. `setsid`, `exec`, `env`, subshells), without swallowing `openssl` / `opencode`.

## v1.148.15 (2026-07-14)

- fix(visual-gate): **the gate was structurally blind to every WebGL app — it now measures the screenshots it already captures.** The pixel probe called `canvas.getContext('2d')`, but a canvas can own only ONE context type: on a WebGL canvas (Three.js, Babylon, PixiJS-WebGL, raw WebGL) that returns `null`, so the probe read nothing and reported `0 distinct colors / 100% dominant / 0% motion`. **Every WebGL deliverable falsely failed as a blank render** — a phantom bug the model could never fix, so it rewrote a working renderer over and over. Meanwhile the vision reviewer, reading the *very same screenshots*, described the app's lighting and stickers and scored it 6/10. Screenshot analysis (new `sampleScreenshot`, via `pngjs`) is now the **source of truth** — it measures what the compositor actually painted, so it works for WebGL, 2D canvas, CSS 3D, SVG and DOM alike, and motion becomes a real frame-to-frame diff. The in-page canvas probe is retained as a cheap fast-path/fallback. On the live Rubik's-cube deliverable this flipped `NOT VERIFIED ✗ (0 colors, 0.0% motion)` → `VERIFIED ✓ (22 colors, 17.9% motion)`; the app had been passing every threshold all along.

## v1.148.14 (2026-07-14)

- fix(visual-gate): **report external resources that FAILED to load — the gate was throwing away the one signal that explains a blank render.** The browser has always captured `requestfailed`, but the gate filtered `getErrors()` down to `pageerror` only and discarded the rest. So when a model built an app that loads its framework from a CDN, the headless validation browser (no network) couldn't fetch it, the page rendered blank, and the gate reported *"canvas renders below the visual floor (0 distinct colors < 3 required)"* — sending the model off to rewrite a **renderer that was never the problem**. It rebuilt the same CDN-dependent app three times in one session, because nothing ever told it the dependency simply had not loaded. Failed requests are now reported **first** (the blank canvas is a *consequence*, not the cause), naming the failed URLs and stating the fix: the validation browser has NO NETWORK — **vendor the dependency locally**, do not rewrite the rendering logic.

## v1.148.13 (2026-07-13)

- fix(agentic-executor): **the deliver agent can no longer read, list, or write its own machinery.** Observed live: a routed deliver run spent **5 of its 10 tool calls** recursing into `.uap/deliver-runs/<its own run>/state.json`, `.uap/autoroute.log` and the lock files — half of a tight budget gone, so it could never converge on the actual deliverable (one call even errored, `read_file .uap/deliver-runs` → EISDIR, burning another turn). `read_file`/`list_dir`/`write_file` now refuse `.uap/`, `.uap-deliver/`, `.git/` and `node_modules/`, and those dirs are **hidden from listings entirely** so the agent is never tempted. This is the protected-path guard `agentic-executor.ts`'s own scope note asked for.
- fix(autoroute): **raise the routed-deliver budget** from `--max-turns 5 --ceiling 10` to `12`/`25`. The old budget was too tight for a routed deliver to BUILD a change and then get it through the gate ladder — especially on a slow local model, where one build+verify cycle eats several turns. Override with `UAP_AUTOROUTE_MAX_TURNS` / `UAP_AUTOROUTE_CEILING`.

## v1.148.12 (2026-07-13)

- fix(autoroute): **deliver never auto-spawned for opencode — autoroute was inert.** `deliver_autoroute.py` read only snake-case file-path keys (`file_path`/`path`/`target`), so for opencode (which sends **`filePath`**) it always resolved to `""`, and the spawn condition `spawn = ... and file_path and ...` was therefore always `False`. The gate blocked the edit, logged the intent, told the model to call deliver — and deliver **never ran**. Observed live: 3 routed intents, 0 deliver runs, 0 files changed — work blocked but never delivered. The enforcer was fixed for this key long ago; autoroute never was, and its tests only ever passed snake-case, which is why it went unnoticed. Now accepts every agent spelling (`file_path`/`filePath`/`path`/`target`/`filename`/`file`).
- fix(autoroute): **BASH-routed intents can now spawn.** A bash source-write (`cat > app.js <<EOF`) carries a `command`, not a path — so requiring `file_path` made that entire class unspawnable (blocked, then silently dropped). Spawn now keys on the `deliverHint` (what deliver actually runs), deduping on the file when present and on the hint otherwise.

## v1.148.11 (2026-07-13)

- fix(delivery-enforcement): **tighten `EXEMPT_PREFIXES` — `scripts/` and `docs/` are no longer exempt.** Shell/Python/TS under `scripts/` *executes* — it is code, so it must route through deliver and be tested like any other source. Exempting it left an entire language silently ungated: a model could put its whole implementation in `scripts/` and never be validated. What remains exempt is deliberate and documented: agent/enforcement infrastructure (`.uap/`, `.opencode/`, `.claude/`, `.policy-tools/`, …) because routing the hooks that *run* the gate is a bootstrap deadlock (they are guarded by `enforcement-self-protect` instead); the policy definitions themselves (`src/policies/`, `policies/`) for the same self-reference; and `test/`/`tests/` as the deliberate fast feedback loop (deliver still verifies them via the gate ladder).

## v1.148.10 (2026-07-13)

**Every code type is now gated AND tested.** The rule: if it is interpreted, transpiled, or compiled, it is code — it routes through deliver, and it gets a rung that proves it builds and its tests pass.

- fix(delivery-enforcement): `SOURCE_EXTS` expanded from 22 to **108 extensions**, covering C/C++/CUDA/ObjC, Rust, Go, Zig, Nim, .NET (C#/F#/VB/Razor), JVM (Java/Kotlin/Scala/Groovy/Clojure), Python, Ruby, PHP, Perl, Lua, Elixir/Erlang, Haskell, OCaml, Swift, Dart, R, Julia, shell/PowerShell, assembly, Solidity, SQL, protobuf/GraphQL, Terraform/HCL, plus web (HTML/CSS/Vue/Svelte/templates). Pure data/config (`.json`/`.yaml`/`.xml`/`.md`) is deliberately **not** gated — it has no executable "correct function".
- fix(verifier-ladder): **`detectPolyglotRungs` — build+test rungs for every ecosystem, detected UNCONDITIONALLY.** Go, .NET, C/C++ (CMake+ctest), Maven, Gradle, sbt, Swift, Ruby, PHP, Elixir, Dart, Haskell, Zig, and Python. Previously these sat behind a `rungs.length === 0` fallback, so a Go/C++/.NET/Python component in a repo that *also* had a `package.json` was **never compiled or tested** — it passed **vacuously**, judged only by `npm run build`. (This is the same bug already fixed for Rust, where an 8-phase Rust mission stagnated because every turn was judged by npm alone; it is now generalized to every language.) A rung whose toolchain is absent surfaces as a visible INFRA `spawn-error` (fails open) rather than silently vanishing, so "we could not test your Go code" is never mistaken for a pass.

## v1.148.9 (2026-07-13)

- fix(delivery-enforcement): **web deliverables are source code.** `SOURCE_EXTS` omitted `.html`/`.css`, so an entire class of deliverable (single-file web apps, static sites, templates) returned `"not source code"` and was allowed — zero routing, zero deliver, zero validation (observed live: a 34KB `rubiks-cube.html` app built completely ungated). Added `.html .htm .css .scss .sass .less .vue .svelte .astro`. This also aligns the enforcer with the completion gate, whose code-change detector already counted html/css/vue/svelte as code — the two halves of the system disagreed about what "source" means.
- fix(delivery-enforcement): **gate Bash.** Previously only Edit/Write/MultiEdit were gated, so `cat > app.js <<EOF` bypassed delivery enforcement entirely. Bash commands that write source (`>`/`>>` redirect, heredoc, `tee`, `sed -i`) now block and route through deliver. Escape hatches (`UAP_DELIVER_ACTIVE`, `UAP_DELIVER_BYPASS`) honored; benign shell work is unaffected.
- feat(delivery-enforcement): **redirect GUI browser launches to `uap verify`.** A model with no validation tooling in reach tries to "check its work" by opening a browser (observed: 11 `xdg-open`/`firefox`/`chromium` attempts in 40 min, spawning windows on the operator's desktop) — which proves nothing and cannot gate a DONE claim. These are now blocked with a directive to run `uap verify`, which renders headlessly and runs the real visual + behavioral gates. Capability probes (`which firefox`) are not blocked.

## v1.148.8 (2026-07-13)

- change(policies): **all policies are now REQUIRED by default instead of RECOMMENDED.** REQUIRED-level policies are protected (always-on, cannot be disabled by the agent). The 9 policies previously tiered RECOMMENDED (`adr-guard`, `coord-overlap`, `delivery-enforcement`, `local-build-before-push`, `mcp-router-first`, `parallel-reads`, `pay2u-architecture-rules`, `pay2u-enforcement-hooks`, `pay2u-quick-reference`) are now REQUIRED; `enforcement-self-protect` is explicitly REQUIRED; and the parse/merge/selection defaults changed `OPTIONAL → REQUIRED`, so a policy without an explicit `**Level**` is required, not optional. RECOMMENDED remains a valid explicit level for operators who deliberately want an advisory policy — it is simply no longer a default.

## v1.148.7 (2026-07-13)

- fix(user-validation): the browser user-path runner now navigates to `path.entry` before running steps. `entry` is a documented manifest field ("the entry file or route") but was silently ignored — a path relying on it sat at about:blank and every assertion failed confusingly (had to repeat a `goto`). Now honored; an explicit leading `goto` still wins (no double-load).
- fix(vision): stabilize the aesthetic score that gates a DONE claim. The vision call ran at the model's default (non-zero) temperature, so the same render could score 3→8 across runs and false-block a good deliverable. It now defaults to the MEDIAN of `UAP_VISION_SAMPLES` (default **3**) independent scores — robust to a single bad judgment. Set `UAP_VISION_SAMPLES=1` for a deterministic single call (`temperature: 0`); higher values trade latency for more stability.

## v1.148.6 (2026-07-13)

- feat(verify): `--acceptance-auto` — judge requirements-completeness at the DONE gate against an auto-discovered spec, so "all requirements met" is enforced on **every** DONE claim, not just `deliver` runs. Discovery priority: `.uap/acceptance.md` → `.uap/requirements.md` → `ACCEPTANCE.md`/`REQUIREMENTS.md`/`SPEC.md` → the completion ledger / TodoWrite plan (the agent's own plan of record). Wired into the opencode completion gate (full verify on all-todos-complete) and `stop.sh` (all other agents). Fails OPEN when no spec or no model is configured (never wedges a DONE claim on missing config); blocks under `fidelity: max` / `--strict` like the other acceptance-gate paths. Deliberately NOT added to the per-edit periodic path (an LLM judge every N edits would be far too heavy).

## v1.148.5 (2026-07-13)

- feat(gate): CUMULATIVE trivial-edit fast-path (`fastpath_gate.py`). The fast-path kept iteration quick but was an unbounded escape hatch — a weak model could assemble a whole broken feature out of sub-threshold edits that never routed to deliver or got validated. Now per-file trivial-edit chars/count are tallied in `.uap/fastpath-accum.json`; once a file crosses `UAP_DELIVER_CUMULATIVE_CHARS` (800) or `UAP_DELIVER_CUMULATIVE_EDITS` (6) since it last routed, the next edit routes through deliver and the tally resets — bounding un-validated drift per file. The gate signals `UAP_FASTPATH_ROUTED=1` so `delivery_enforcement.py` skips its own trivial allowance (which otherwise re-approved the edit and defeated the budget).
- feat(opencode): PERIODIC validation independent of a clean `todowrite`-complete. The completion gate only fired when the agent marked ALL todos completed; a weak model that stops mid-plan or never calls todowrite escaped validation. The plugin now runs `uap verify --runtime-only` every `UAP_VERIFY_EVERY_N_EDITS` (12) code edits and hard-injects `[UAP not done]` on a real runtime failure, catching a broken build even with no done signal. `UAP_VERIFY_EVERY_N_EDITS=0` opts out.

## v1.148.4 (2026-07-13)

- fix(gate): delivery enforcement now honors `.uap.json` `delivery.localMode` (routes local-model sessions THROUGH deliver instead of the enforcer's default advisory downgrade) and the installer deploys the `deliver_autoroute.py` helper the gate depends on (#484). Carries the config-authoritative gate fix to a published release.
- test: fix `policy-gate-mainroot` fixture (missing `priority` column the gate's policy query ORDER BYs) — this was the sole failing test in CI, blocking every npm publish since v1.148.2; deflake the concurrency exponential-backoff test under full-suite load.

## v1.148.3 (2026-07-13)

- fix(policy): resolve expert-review-required deadlock — its escape hatches were all unreachable (self-protect locked the review-artifact/waiver paths, the named skill never wrote the artifact, inline UAP_NO_REVIEW never reached the hook-run enforcer, and the advertised `uam worktree pr` was a non-existent binary)

## v1.148.2 (2026-07-12)

- fix(deliver): .uap.json deliver.orchestrate:"on" now forces orchestration always


## v1.148.1 (2026-07-12)

- fix(policy): self-protect anchors "/policies/" to a path segment, not any substring
- chore: bump version to 1.148.0
- feat(dashboard): record policy-gate executions so compliance shows real data
- chore: bump version to 1.148.0
- chore: bump version to 1.148.0
- feat(setup): install ALL policies (with their levels) by default in every uap setup


## v1.148.0 (2026-07-12)

- chore: bump version to 1.148.0
- chore: bump version to 1.148.0
- feat(setup): install ALL policies (with their levels) by default in every uap setup


## v1.147.4 (2026-07-12)

- fix(policy-gate): resolve the worktree the op TARGETS, not just the hook's cwd


## v1.147.3 (2026-07-12)

- fix(dashboard): resilient policy read — one bad row no longer 500s /api/policies


## v1.147.2 (2026-07-12)

- chore(policy): remove dead validate-plan-before-build + fix local-build worktree resolution


## v1.147.1 (2026-07-12)

- fix(policy): expert-review resolves the WORKTREE branch, not the main checkout
- fix(delivery): protect .uap/user-paths.json from mid-run weakening (gate-gaming vector)


## v1.147.0 (2026-07-12)

- feat(policy): validate-plan-on-change — ALWAYS validate a plan after creating/modifying it


## v1.146.1 (2026-07-12)

- test: playwright-core is a runtime dependency — invert the placement assertion (companion to #460)
- fix(user-validation): favicon.ico console noise must not fail expect_no_console_errors
- fix(deps): playwright-core is a RUNTIME dependency — cloakbrowser requires it
- feat(proxy): vision passthrough — autodetect upstream mmproj and forward images to the model


## v1.146.0 (2026-07-12)

- feat(dashboard): full policy-management panel — view/prompt, duplicate, import/export, drag + AI ordering
- chore: bump version to 1.145.1 (publish embed MAX_CHARS fix) (#457)
- fix(memory): cap embed input to the model's trained context (512-token safe) (#453)


## v1.145.0 (2026-07-12)

- chore: bump version to 1.143.0
- fix(policy): prevent duplicate policies + `uap policy dedupe` to clean up existing


## v1.144.0 (2026-07-12)

- feat(delivery): P3 — user-path validation enforced on interactive done-claims (stop hook + opencode idle)


## v1.143.0 (2026-07-12)

- feat(hooks): infra-protect rules in the bash dangerous-command guard
- feat(delivery): user-path validation gate — the artifact must work for a REAL user before DELIVERED


## v1.142.0 (2026-07-12)

- feat(policy): selectable policies — `uap policy select` + setup picker


## v1.141.0 (2026-07-12)

- feat(policy): register enforcement-infra-protect — stop the model killing its own inference stack
- feat(memory): add `uap memory sync-files` to embed memory topic files into Qdrant


## v1.140.0 (2026-07-12)

- feat(fidelity): default interactive setup to max + DESIGN.md-aware vision + structural baseline


## v1.139.0 (2026-07-12)

- feat(fidelity): maximum-fidelity mode + always-on visual/vision verification


## v1.138.1 (2026-07-12)

- fix(memory): bridge mirror surfaces insight memories, not lifecycle noise


## v1.138.0 (2026-07-12)

- feat(memory): memory bridge — `uap memory bridge` hijacks each coding agent's native memory/instruction file (Claude Code memory index, AGENTS.md for opencode/codex/factory, GEMINI, Cursor rules, Copilot instructions) to point at UAP's unified cross-agent memory. Idempotent, non-destructive marked block that declares UAP canonical, gives recall/store commands, and mirrors recent memories inline. Auto-runs on `uap init`.
- feat(setup): `uap setup` now completes the full integration automatically — memory PREPOPULATE (docs + git history) plus a memory-bridge refresh across all detected agents, on top of init + services + patterns + MCP + enforcement + hooks.

## v1.137.3 (2026-07-12)

- docs: add Inference Proxy guide + refresh DELIVER.md for v1.13x sub-features


## v1.137.2 (2026-07-12)

- docs: document LLM self-tuning + backfill 13 undocumented CLI commands


## v1.137.1 (2026-07-12)

- feat(self-tuning): real-time adaptation auto-on with opt-out toggle


## v1.137.0 (2026-07-12)

- feat(self-tuning): LLM-guided self-tuning system (5-phase) to raise small models toward Opus
- docs: LLM self-tuning analysis — design plan for raising small models toward Opus 4.8
- fix(proxy): 529 backpressure without pool-swap — pure graceful degradation under saturation
- fix(proxy): make the CLOSE-WAIT reaper opt-in (default off) — pool-swap churn harms a saturated upstream
- fix(proxy): per-client in-flight counter so the reaper's retire actually reaps
- fix(proxy): CLOSE-WAIT reaper + accurate in-flight drain — bound abandoned upstream connections
- fix(proxy): detach upstream stream-close so client disconnects can't leak connections
- fix(proxy): self-heal no longer kills in-flight streams (the ReadError-burst cascade) + unify retry set
- fix(proxy): retry transient upstream ReadError/WriteError instead of 500ing
- fix(proxy): close upstream connection on client-cancelled requests — the real leak
- fix(proxy): eliminate the CLOSE-WAIT leak at its source — no upstream keepalive
- fix(proxy): pool-timeout 500 storm — 529 overloaded + connection-pool self-healing
- feat(deliver): migration validation gate + scaffold-then-fill phases — P2 backlog complete
- feat(deliver): repair escalation — narrow 'make it compile' pass breaks the compile-error death spiral
- chore(proxy): floor-budget warning once per session — it fires per request on tool-heavy clients
- fix(proxy): tool-heavy sessions could never be pruned — floor the message budget instead of giving up
- fix(proxy): truncated streaming tool calls now close validly; tool retries get a survivable budget
- feat(deliver): contracts-first epics — shared APIs planned first, then locked read-only
- chore: drop ambient local files swept in by conflicted-autostash staging
- feat(deliver): baseline-delta gating — pre-existing failures report, only NEW failures block
- chore(bench): lazy terminal-bench UAP arm — one-shot, escalate to deliver on failure
- fix(bench): install sqlite3 in the terminal-bench UAP arm — the gate needs it (v1.136.2)


## v1.136.2 (2026-07-11)

- chore(bench): terminal-bench UAP arm is now LAZY (matches UAP's --lazy philosophy) — opencode one-shots the task directly with full UAP context (reactor + AGENTS.md gate discipline + the deliver tool available) and escalates to `deliver`'s verified-convergence loop ONLY when its build/tests fail after a couple of attempts. Forcing deliver on every edit timed out all tasks on a weak local model; lazy escalation one-shots the easy tasks and rescues the hard ones. Pair with `tb run --global-agent-timeout-sec 1200` for small models (per-task default 360s is too short for deliver on qwen).

## v1.136.1 (2026-07-11)

- fix(policy): delivery-enforcement now recognizes opencode's `filePath` tool-arg key (plus `filename`/`file`) in addition to Claude's `file_path` — previously opencode Write/Edit calls slipped through the gate ungated because the enforcer only looked for `file_path`/`path`/`target`, so "route through deliver" never fired for opencode. Validated: opencode-format edits to source now hard-block (exit 2, route:deliver) in block mode; test files still exempt. 3 new tests.
- chore(bench): terminal-bench full-UAP arm setup hardened — git-init the run cwd so the policy gate's repo_root anchors correctly, install `.opencode` plugin runtime deps so project plugins load, force UAP_DELIVER_LOCAL_MODE=block via the agent `_env`. (Note: opencode headless `run` still does not invoke the project-plugin tool.execute.before gate in-container — the remaining faithful-benchmark blocker, opencode-side.)

## v1.136.0 (2026-07-11)

- feat(proxy): MANDATE-DELIVER — when delivery-enforcement blocks a direct source edit, the proxy now FORCES the next turn to call the `deliver` tool for ANY model (pins tool_choice to the deliver tool). The enforcer's `route:deliver` signal was previously only honored by harnesses that understood it, so weak local models saw the "route through deliver" text and deadlocked (RECON loop). Now the routing is binding regardless of model/harness. Marker is enforcer-block-specific (the reactor's standing guidance does not false-trigger). Env: PROXY_MANDATE_DELIVER=off to disable.
- fix(bench): terminal-bench UAP arm now installs the FULL UAP surface — `uap init -p opencode` wires the uap-router MCP `deliver` tool + delivery-enforcement hooks + reactor into the run cwd, sets UAP_INFERENCE_ENDPOINT for in-container deliver, and routes opencode through the UAP proxy (:4100) so MANDATE-DELIVER is in the loop. Previously the "UAP arm" was only an AGENTS.md prompt (no orchestrate/deliver/ideate), which under-represented UAP.

## v1.135.2 (2026-07-11)

- fix(bench): terminal-bench opencode harness was unusable headless — the generated `opencode.json` had no `permission` config, so `opencode run` auto-rejected every tool call (both arms scored 0%, a void A/B). Added `permission {edit,bash,webfetch,external_directory: allow}` and switched the default container→host endpoint to the portable docker bridge (`172.17.0.1:8080`). Verified: qwen3.6-35B-A3B + opencode now runs genuine attempts (33% baseline vs 42% with the UAP AGENTS.md gates protocol on a 12-task TB-1.0 subset).

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
