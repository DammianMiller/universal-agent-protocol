# UAP CLI Reference

> Complete command reference for the Universal Agent Protocol command-line interface (`uap`).
> Version v1.93.1.

> **🏭 Where this fits:** Every station — this is the control panel for the whole
> line. **What it delivers:** one binary that drives each stage of your
> [delivery pipeline](../guides/DELIVERY_PIPELINE.md), from understanding the work
> to shipping it safely, so you operate the factory from a single door.

The `uap` binary is the single entry point for every UAP capability — the
control panel for the whole line. From here you run project initialization, the
tiered memory system (Intake/Feedback), the git worktree workflow (Isolation),
multi-agent coordination (Line coordination), task management, the multi-model
architecture (Prep/Routing), the MCP router, policy enforcement (cross-cutting),
the delivery convergence loop (Build → QC/Verify), and platform hook management.

```bash
uap --help          # top-level command list
uap <command> --help    # subcommands + flags for a command
uap --version           # print version
```

Commands are lazy-loaded — each command module is imported only when its action
runs, keeping `--help` fast.

## Command index

| Command | Purpose |
|---------|---------|
| [`init`](#init) | Initialize agent context in the current project |
| [`setup`](#setup) | Guided setup wizard (arrow-key), or `--profile maximum\|minimal\|custom`; backs up instruction files, extracts custom content |
| [`analyze`](#analyze) | Analyze project structure and emit metadata |
| [`generate`](#generate) | Generate or update CLAUDE.md and related files |
| [`update`](#update) | Update CLAUDE.md, memory system, and related components |
| [`memory`](#memory) | Manage the agent memory system |
| [`patterns`](#patterns) | Manage pattern RAG (on-demand retrieval via Qdrant) |
| [`worktree`](#worktree) | Manage git worktrees |
| [`sync`](#sync) | Sync configuration between platforms |
| [`droids`](#droids) | Manage custom droids/agents |
| [`expert-route`](#expert-route) | Recommend an expert droid chain for a task |
| [`deliver`](#deliver) | Convergence loop: iterate a model against gates until delivery |
| [`harness`](#harness) | HALO harness optimization over execution traces |
| [`bench`](#bench) | Controlled paired (UAP-on vs UAP-off) benchmark with CIs |
| [`self-harness`](#self-harness) | Self-improving harness: mine failures → propose → validate → commit |
| [`tune`](#tune) | LLM self-tuning: raise a small model toward Opus by tuning UAP flags |
| [`verify`](#verify) | Runtime verification gate: prove changed code actually runs |
| [`config`](#config) | Inspect and change every UAP setting (`.uap.json` / `.uap/proxy.env`) |
| [`design`](#design) | DESIGN.md interrogation, lint, and the off-token UI gate |
| [`proxy`](#proxy) | Reference-counted, session-scoped local inference proxy lifecycle |
| [`orchestrator`](#orchestrator) | Toggle the long multi-turn deliver orchestrator |
| [`handsfree`](#handsfree) (`hf`) | Hands-free persistence: loop any model to a 100% ledger |
| [`challenge`](#challenge) | Open multi-agent challenge with a significance-gated leaderboard |
| [`sandbox`](#sandbox) | Run a command with a kernel-enforced writable-dir boundary |
| [`react`](#react) | Resolve dynamic experts/skills/patterns for a lifecycle event (JSON) |
| [`status`](#status) | Show HALO trace collection state |
| [`ideate`](#ideate) | Divergent ideation (open-collider) for hard problems |
| [`coord`](#coord) | Agent coordination and status |
| [`agent`](#agent) | Agent lifecycle, work coordination, and communication |
| [`deploy`](#deploy) | Deployment batching and execution |
| [`task`](#task) | Task management |
| [`compliance`](#compliance) | Protocol compliance checking, auditing, and auto-fix |
| [`coordination`](#coordination) | Coordination overlap checks and resolution |
| [`skill`](#skill) | Skill management and loading |
| [`dashboard`](#dashboard) (`dash`) | Rich dashboards for tasks, agents, memory, progress |
| [`model`](#model) | Multi-model architecture management |
| [`mcp-router`](#mcp-router) | Hierarchical MCP router for 98%+ token reduction |
| [`hooks`](#hooks) | Manage session hooks across platforms |
| [`tool-calls`](#tool-calls) | Manage Qwen3.5 tool call fixes and chat templates |
| [`rtk`](#rtk) | Manage RTK (Rust Token Killer) integration |
| [`mcp-setup`](#mcp-setup) | Configure MCP Router for all AI harnesses |
| [`schema-diff`](#schema-diff) | Detect breaking schema changes between branches |
| [`policy`](#policy) | UAP policy management |
| [`uap-omp`](#uap-omp) | UAP integration commands for oh-my-pi (omp) users |

---

## `init`

Initialize agent context in the current project.

```bash
uap init [options]
```

| Flag | Purpose |
|------|---------|
| `-p, --platform <platforms...>` | Target platforms: `claude`, `factory`, `vscode`, `opencode`, `omp`, `all` (default `all`) |
| `--web` | Generate `AGENT.md` for web platforms (claude.ai, factory.ai) |
| `--no-memory` | Skip memory system setup |
| `--no-worktrees` | Skip worktree workflow setup |
| `--patterns` | Enable pattern RAG setup (auto-detected by default) |
| `--no-patterns` | Skip pattern RAG setup |
| `--pipeline-only` | Enforce pipeline-only infra changes (no direct infra CLIs) |
| `--systemd-services` | Scaffold user systemd services for llama.cpp and the anthropic proxy |
| `-f, --force` | Overwrite existing configuration |

```bash
uap init --platform claude factory
uap init --web --no-worktrees
```

---

## `setup`

Guided one-command setup: a **default arrow-key wizard** (init + start Qdrant +
Python deps + pattern index) that backs up agent instruction files and extracts
custom content into policies/skills. Runs the scripted path on CI / non-TTY or
with `--non-interactive`.

```bash
uap setup [options]
```

| Flag | Purpose |
|------|---------|
| `-p, --platform <platforms...>` | Targets: `claude`, `factory`, `vscode`, `opencode`, `omp`, `cline`, `codex`, `aider`, `continue`, `windsurf`, `zed`, `copilot`, `jetbrains`, `swe-agent`, `all` (default `all`) |
| `--non-interactive` | Run the scripted (non-guided) setup; also automatic on CI / non-TTY |
| `-y, --yes` | Alias for `--non-interactive` (accept defaults, no prompts) |
| `--no-backup` | Do not back up agent instruction files before modifying them |
| `--no-extract` | Do not detect/extract custom instruction content into policies/skills |
| `--extract-auto` | In scripted mode, auto-extract custom content (default: report only) |
| `--no-patterns` | Skip pattern RAG setup |
| `--no-memory` | Skip memory system setup |
| `--no-self-update` | Skip the automatic UAP CLI version check / self-update (also `UAP_NO_SELF_UPDATE=1`) |
| `--systemd-services` | Scaffold user systemd services for llama.cpp + anthropic proxy |
| `-d, --project-dir <path>` | Target project directory (defaults to cwd) |
| `-i, --interactive` | Run the guided wizard (the default) |

The guided wizard (default) prompts for harnesses, memory tiers, coordination,
patterns, policies, model provider/profile, hooks, and browser — with smart
defaults from the environment — and persists the choices to `.uap.json`. Before
any change it backs up agent instruction files to `.uap-backups/<date>/` and
offers to extract custom sections into UAP policies/skills (see
[Installation → Backup & custom-content extraction](../getting-started/INSTALLATION.md#backup--custom-content-extraction)).

Setup also ensures the **globally-installed UAP CLI is at the latest published
npm version** (self-update): non-fatal, global-install-only, downgrade-proof, and
**skipped in CI** (`UAP_SELF_UPDATE=1` forces it). Disable with
`--no-self-update` / `UAP_NO_SELF_UPDATE=1`.

```bash
uap setup                            # guided arrow-key wizard
uap setup --non-interactive          # scripted (CI-safe); also -y
uap setup -p claude -d ~/projects/myapp
uap setup --no-self-update           # configure without touching the global CLI
```

---

## `analyze`

Analyze project structure and generate metadata.

```bash
uap analyze [options]
```

| Flag | Purpose |
|------|---------|
| `-o, --output <format>` | Output format: `json`, `yaml`, `md` (default `json`) |
| `--save` | Save analysis to `.uap.analysis.json` |

---

## `generate`

Generate or update CLAUDE.md and related files.

```bash
uap generate [options]
```

| Flag | Purpose |
|------|---------|
| `-f, --force` | Overwrite existing files without confirmation |
| `-d, --dry-run` | Show what would be generated without writing |
| `-p, --platform <platform>` | Generate for a specific platform only |
| `--template <template>` | Template to use (`default` or custom) |
| `--sections <sections>` | Comma-separated sections to include |
| `--web` | Generate `AGENT.md` for web platforms |
| `--pipeline-only` | Enforce pipeline-only infra changes |

---

## `update`

Update CLAUDE.md, the memory system, and all related components.

```bash
uap update [options]
```

| Flag | Purpose |
|------|---------|
| `--dry-run` | Show what would be updated without changing anything |
| `--skip-memory` | Skip memory system updates |
| `--skip-qdrant` | Skip Qdrant collection updates |
| `--pipeline-only` | Enforce pipeline-only infra changes |
| `-v, --verbose` | Show detailed update information |

---

## `memory`

Manage the agent memory system.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `status` | — | Show memory system status |
| `start` | — | Start memory services (Qdrant container) |
| `stop` | — | Stop memory services |
| `query <search>` | `-n, --limit` (10), `-k, --top-k`, `-t, --threshold` (0.35) | Query long-term memory |
| `store <content>` | `-t, --tags`, `-i, --importance` (5), `-f, --force` | Store a memory (applies write gate unless `--force`) |
| `prepopulate` | `--docs`, `--git`, `-n, --limit` (500), `--since <date>`, `-v` | Seed memory from docs and git history |
| `promote` | — | Review and promote daily log entries to working/semantic memory |
| `correct <search>` | `-c, --correction`, `-r, --reason` | Correct a memory; propagates across tiers, marks old superseded |
| `maintain` | `-v, --verbose` | Run decay, prune stale, archive old, remove duplicates |

```bash
uap memory query "worktree workflow" --limit 5 --threshold 0.4
uap memory store "Qdrant runs on :6333 in a container" -t infra,memory -i 8
uap memory correct "old endpoint" -c "endpoint is now :4000" -r "migrated proxy"
```

---

## `patterns`

Manage pattern RAG (on-demand pattern retrieval via Qdrant).

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `status` | — | Show pattern RAG status and collection info |
| `index` | `-v, --verbose` | Index patterns from CLAUDE.md into Qdrant |
| `query <search>` | `-n, --top` (2), `--min-score` (0.35), `--format` (text/json/context) | Query patterns by task description |
| `generate` | `-f, --force` | Generate Python index/query scripts from config |

```bash
uap patterns query "fix a flaky test" --top 3 --format context
```

---

## `worktree`

Manage git worktrees. All file edits in the UAP workflow happen inside a
worktree under `.worktrees/NNN-<slug>/`.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `create <slug>` | `-f, --from <branch>`, `-d, --description` | Create a new worktree for a feature |
| `list` | — | List all worktrees |
| `pr <id>` | `--draft` | Create a PR from a worktree |
| `finish <id>` | — | Sync, merge PR, and auto-cleanup the worktree |
| `cleanup <id>` | — | Remove a worktree and delete its branch |
| `ensure` | `--strict` (exit 1 if not in a worktree) | Check if working inside a worktree (use as a gate) |
| `prune` | `-o, --older-than` (30), `-f, --force`, `-n, --dry-run` | Prune stale worktrees older than N days |

```bash
uap worktree ensure --strict
uap worktree create add-user-auth
uap worktree finish 042
uap worktree prune --older-than 14 --dry-run
```

---

## `sync`

Sync configuration between platforms.

```bash
uap sync [options]
```

| Flag | Purpose |
|------|---------|
| `--from <platform>` | Source platform: `claude`, `factory`, `vscode`, `opencode` |
| `--to <platform>` | Target platform(s) |
| `--dry-run` | Preview changes without writing files |

---

## `droids`

Manage custom droids/agents.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `list` | — | List all droids |
| `add <name>` | `-t, --template` | Add a new droid |
| `import <path>` | — | Import droids from another platform |
| `validate` | `-q, --quiet` | Validate droid files against capability-router expectations |

---

## `expert-route`

Recommend an expert droid chain for a task description.

```bash
uap expert-route <description...> [options]
```

| Flag | Purpose |
|------|---------|
| `-f, --files <files...>` | Affected file paths to refine routing |
| `--json` | Emit JSON instead of a human-readable report |

```bash
uap expert-route "harden the payment webhook against replay attacks" -f src/payments/webhook.ts
```

---

## `deliver`

Convergence loop: iterate a model against real completion gates until delivery.
Loop-until-delivered is ON by default — the loop extends past `--max-turns` to a
ceiling and stops on stagnation. Dynamic optimization is also on by default: the
task is classified and matching aids enable automatically.

```bash
uap deliver <instruction...> [options]
```

| Flag | Purpose |
|------|---------|
| `--max-turns <n>` | Max execute->verify iterations (default 5) |
| `-m, --model <preset>` | Model preset id (default `$UAP_DELIVER_MODEL` or `qwen35-a3b`) |
| `--project-root <path>` | Project whose gates define delivery (default cwd) |
| `--endpoint <url>` | Override the model endpoint (OpenAI-compatible `/v1`) |
| `--temperature <t>` | Sampling temperature (default: execution-profile value) |
| `--gates <ids>` | Comma-separated gate subset: `build,typecheck,test,lint` |
| `--tiers <list>` | Local tiers to run: `fast,integration,deploy-dev` (overrides auto-detection) |
| `--integration` / `--no-integration` | Run the integration tier (on by default when `test:integration`/`test:e2e`/pytest marker is detected) |
| `--deploy-dev` / `--no-deploy-dev` | Run a local dev deploy + smoke tier (compose up -> smoke -> teardown) |
| `--watch-ci` | After local-green, commit + push the worktree branch and watch CI; re-converge on CI/deploy failure (never pushes master/main) |
| `--until-deployed` | Imply `--watch-ci` and require CI + staging/prod deploy jobs green before exiting 0 |
| `--ci-passes <n>` | Max CI re-converge passes on failure (1-10, default 2) |
| `--ci-timeout <minutes>` | CI watch budget in minutes (1-120, default 20) |
| `--candidates <n>` | Best-of-N exploration: candidates per turn (2-8) |
| `--critic` | Structured critique of failed turns (extra model call per failure) |
| `--practices` | Inject learned best-practice cards; record new ones on success |
| `--no-semantic` | Use keyword (not embedding) retrieval for practice cards |
| `--escalate` | Escalation ladder on stagnation (widen exploration -> critic -> stronger model) |
| `--escalate-model <preset>` | Stronger model preset for escalation (default `$UAP_ESCALATE_MODEL`) |
| `--ideate` | Divergent ideation: generate task-specific strategy seeds |
| `--ideate-project <name>` | Seed exploration from a curated open-collider project (`projects/<name>`) |
| `--halo` | Emit HALO spans for this run (analyze with `uap harness analyze`) |
| `--coordinate` | Register the run with the coordination layer (announce, heartbeat, overlap) |
| `--deploy` | On success, queue a commit of applied files into the deploy batcher |
| `--optimize` | Enable every convergence aid: exploration, critic, practices, escalation, ideation, HALO, coordination |
| `--no-auto` | Disable dynamic optimization (auto-classification + matching aids) |
| `--no-protect-tests` | Allow the model to modify pre-existing test files (protected by default) |
| `--guidance-file <path>` | Poll this file each turn for operator guidance; steer a running mission |
| `--no-until-delivered` | Disable loop-until-delivered (stop at `--max-turns`) |
| `--ceiling <n>` | Hard turn ceiling for until-delivered (1-50, default 30) |
| `--dry-run` | Show detected gates and plan without calling the model |
| `--json` | Emit JSON result |

```bash
uap deliver "add a /healthz endpoint with a test" --gates build,test
uap deliver "refactor the auth module" --optimize --ceiling 20
uap deliver "add the orders endpoint" --deploy-dev          # incl. local dev deploy+smoke
uap deliver "add the orders endpoint" --until-deployed      # push, watch CI, verify staging/prod
uap deliver "fix the failing CI" --dry-run
```

See the [deliver guide](../guides/DELIVER.md#tiered-validation-gates-cheap-first)
for the tiered gate model and the CI/deploy feedback loop.

---

## `harness`

HALO harness optimization: analyze execution traces for systemic failures.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `analyze` | `-t, --traces <file>`, `-p, --prompt`, `--json` | Run the HALO engine over collected traces |
| `status` | `--json` | Show HALO trace collection state (enabled, path, span count) |

```bash
uap harness status
uap harness analyze --prompt "why do test gates keep failing?"
```

The trace file defaults to `$UAP_HALO_TRACE_PATH` or `.uap/halo/traces.jsonl`.

---

## `bench`

Controlled paired benchmark — hold the base model + agent constant and toggle
UAP on/off over the same real-gate suite and seeds, then report paired deltas
with confidence intervals, a McNemar gate-value 2×2, and a cost–accuracy Pareto.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `paired` | `--suite`, `--adapter <mock\|opencode\|claude\|mini\|raw\|deliver>`, `--model`, `--epochs`, `--concurrency`, `--ablation`, `--lazy`, `--seed`, `--iterations`, `--rope-margin`, `--out`, `--json` | Run the UAP-on vs UAP-off A/B; writes `records.jsonl` + Markdown/JSON reports |

```bash
uap bench paired --adapter opencode --model qwen36-a3b --epochs 5
uap bench paired --ablation            # leave-one-out per UAP component
```

See [Paired Harness](../benchmarks/PAIRED_HARNESS.md) for the methodology.

---

## `self-harness`

Self-improving harness: mine model-specific failures from traces, propose a
bounded, reversible modification (the "Mod" DSL), validate it with a real paired
bench, and — with `--apply` — commit it and snapshot a versioned profile.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `analyze` | `--records`, `--env`, `--transfer`, `--json` | Mine weaknesses + propose candidate Mods (read-only) |
| `run` | `--records`, `--suite`, `--heldout`, `--adapter`, `--model`, `--epochs`, `--max-candidates`, `--apply`, `--json` | The full loop; `--apply` commits + snapshots |
| `transfer` | `--transfer`, `--json` | List the cross-model transfer store |
| `mine-prod` | `--traces`, `--unit`, `--since`, `--pending`, `--json` | Mine production traces → enqueue proposals (never applies) |
| `pending` / `prune` | `--pending`, `--transfer`, `--json` | Inspect / ablation-prune the queue + store |
| `tune` | (alias of `uap tune`) | The LLM/GP flag self-tuning loop |

```bash
uap self-harness run --suite benchmarks/suites/real-gate --adapter opencode
```

See [Self-Harness (design)](../design/SELF_HARNESS.md).

---

## `tune`

LLM self-tuning — raise a small model (e.g. qwen3.6) toward Opus-level output by
tuning UAP's own flag surface (recipes, hands-free, memory, concurrency, proxy
guardrails) with a benchmark-validated closed loop. An LLM proposes small flag
changes when a judge model is configured; otherwise a Gaussian-process Bayesian
optimizer picks the next config. `uap self-harness tune` is an alias.

| Flag | Purpose |
|------|---------|
| `--model <id>` | Executor model family to tune (default `qwen36-a3b`) |
| `--adapter <name>` | `mock \| opencode \| claude \| mini \| raw \| deliver` |
| `--judge <id>` | Judge/tuner model; else `recipes.judge.model`, else GP-only |
| `--phase <name>` | Force one search phase: `coarse \| medium \| fine \| combinatorial` |
| `--max-iterations <n>` | Tuning-loop budget (default 6) |
| `--epochs`, `--concurrency`, `--iterations`, `--seed` | Paired-bench + stats controls |
| `--apply` | Commit accepted configs + save the profile (default: dry-run) |
| `--json` | Machine-readable result |

```bash
uap tune --model qwen36-a3b --adapter opencode --judge opus-4.8 --apply
uap tune --adapter mock --max-iterations 3 --json     # offline smoke test
```

See [LLM Self-Tuning](../guides/SELF_TUNING.md).

---

## `verify`

Run the project's completion gates — including the **runtime execution gate**
that actually runs the changed code — against the current files and report
pass/fail. This is what the Stop hook calls to block "done" on code that never
ran.

| Flag | Purpose |
|------|---------|
| `-d, --dir <path>` | Project directory (default: cwd) |
| `--strict` | Treat "no verifiable gates" as a failure (fail-closed) |
| `--runtime-only` | Run only the cheap runtime execution gate |
| `--full` | Also run the expensive integration / deploy-dev tiers |
| `--gates <ids>` | Comma-separated rung subset (e.g. `build,test,execution`) |
| `--acceptance <specfile>` | LLM acceptance gate: judge behavioral completeness vs a spec |
| `--no-visual` | Skip the headless visual gate |
| `-m, --model`, `--endpoint` | Model + endpoint for the acceptance gate |
| `--timeout <ms>`, `--json` | Per-rung timeout; JSON output |

```bash
uap verify --runtime-only          # prove the artifact runs
uap verify --acceptance spec.md --strict
```

---

## `config`

Inspect and change every UAP setting from one place — the single source of truth
is `src/config/settings-registry.ts`, which also generates the
[Configuration Reference](CONFIGURATION_REFERENCE.md).

| Subcommand | Purpose |
|------------|---------|
| `list` | All settings + current values |
| `get <key>` / `explain <key>` | Read / learn one setting |
| `set <key> <value>` | Change it (writes `.uap.json`, `.uap/proxy.env`, or prints a shell export) |
| `doctor` | Flag risky / sub-optimal settings |
| `wizard` | Interactive expert configurator (also `uap setup --profile custom`) |
| `docs` | Regenerate `docs/reference/CONFIGURATION_REFERENCE.md` from the registry |

```bash
uap config set recipes.enabled true
uap config set realtimeAdapt.enabled false   # opt out of real-time adaptation
uap config doctor
```

---

## `design`

DESIGN.md integration: interrogate an existing UI into a design brief, lint UI
work against it, and gate off-token colors / off-scale spacing.

| Flag | Purpose |
|------|---------|
| `-d, --project-dir <path>` | Project directory (default: cwd) |
| `-o, --out <path>` | Output path for `interrogate` (default `DESIGN.md`) |
| `--force` | Overwrite an existing DESIGN.md |
| `-f, --file <path>` | Target file (lint/check) or `"old,new"` (diff) |
| `--json` | Machine-readable output |

---

## `proxy`

Reference-counted, session-scoped lifecycle for the local inference proxy (the
Anthropic-compatible gateway in front of a local llama.cpp/Qwen). Hooks
`ensure`/`release` it per session so it starts on demand and stops when the last
session leaves — but it never kills a proxy that systemd manages or that other
sessions still use.

`uap proxy [ensure | release | status | start | stop | restart | enable | disable | dashboard [on|off]]`

The **operational dashboard rides along**: `ensure`/`start` also start-or-adopt
`uap dashboard serve` (default <http://localhost:3847>), so monitoring never needs
a second command. `release` stops it when the last client leaves; `stop` shuts it
down immediately (ownership only — it does not consult the client count). A
dashboard you started yourself, or one serving a different project, is never
touched. Opt out per project with `uap proxy dashboard off`, per `ensure`/`start`
with `--no-dashboard`, or globally with `UAP_PROXY_DASHBOARD=0`.
Ports/hosts: `UAP_DASH_PORT` (3847), `UAP_DASH_HOST` (localhost),
`UAP_DASH_HEALTH_WAIT_MS` (10000) — these govern the ride-along, not
`uap dash serve`.

| Flag | Purpose |
|------|---------|
| `--client <id>` | Client/session id (defaults to the session env or parent pid) |
| `--client-pid <n>` | Long-lived agent pid for liveness (hooks pass `$PPID`) |
| `--port <n>` | Proxy port (default 4000 / `$PROXY_PORT`) |
| `--if-enabled` | No-op unless `.uap.json` `proxy.autostart` is true (hook-safe) |
| `--no-dashboard` | Don't start the ride-along dashboard on this `ensure`/`start` |
| `--quiet` / `--json` | Suppress output (hooks) / machine-readable status |

```bash
uap proxy status --json    # includes a `dashboard` block (port, url, healthy, owner)
uap proxy restart          # e.g. after changing PROXY_* in .uap/proxy.env
uap proxy dashboard off    # opt out of the ride-along dashboard
```

The proxy binds `127.0.0.1` by default; see the proxy `PROXY_*` settings in the
[Configuration Reference](CONFIGURATION_REFERENCE.md) and [Local Models](../guides/LOCAL_MODELS.md).

---

## `orchestrator`

Toggle the long multi-turn deliver orchestrator (blackboard decomposition +
epic controller for big autonomous builds). Persists to `.uap.json`
(`deliver.orchestrate`).

`uap orchestrator [on | off | auto | status]` — `auto` (default) engages it only
for large multi-epic work. See [Orchestrator & Hands-Free](../guides/ORCHESTRATOR.md).

---

## `handsfree`

Hands-free persistence (alias `hf`): drive any model to keep working until the
multi-epic build **completion ledger** is 100% done instead of stopping early.
Auto-on.

`uap handsfree [status | on | off | init | complete <id> | fail <id> | remaining | stop-check]`

| Flag | Purpose |
|------|---------|
| `--mission <text>` | Mission text for `init` |
| `--items <json>` | JSON array of ledger items for `init` |

See [Orchestrator & Hands-Free](../guides/ORCHESTRATOR.md).

---

## `challenge`

Open multi-agent challenge: a shared goal, verified submissions, and a
significance-gated leaderboard (scores within a ROPE margin of the leader are
ties, not wins).

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `open` | `--metric <name>`, `--rope-margin <x>`, `--lower-is-better` | Open a challenge with a shared goal + scoring metric |
| `submit` / `leaderboard` / `status` | — | Submit a verified result / view the ranked board / show state |

```bash
uap challenge open --metric tps --rope-margin 4
```

---

## `sandbox`

Run a command with a kernel-enforced workdir boundary (bubblewrap): only the
current dir + scratch are writable, so writes outside fail at the kernel — the
boundary `--dangerously-skip-permissions` cannot bypass.

```bash
uap sandbox -- <command> [args...]
```

See [Sandbox](../guides/SANDBOX.md).

---

## `react`

Resolve the dynamic UAP capabilities (experts / skills / patterns) for a
lifecycle event and emit JSON — the engine behind the per-prompt Reactor. Hook
adapters pipe a JSON `ReactorContext` on stdin; the flags below are for manual
invocation.

| Flag | Purpose |
|------|---------|
| `--event <event>` | `user-prompt \| session-start \| pre-tool \| post-tool \| stop \| session-end` |
| `--prompt <text>` | Prompt text (when not piping a JSON payload) |
| `-f, --files <files...>` | Changed files (routing signal) |
| `--inject-threshold <n>` | Min confidence to inject (default 0.30) |
| `--auto-spawn-threshold <n>` | Min confidence to auto-spawn an expert (default 0.80) |
| `--max-inject-chars <n>` | Inject character budget (default 1200) |

See [Reactor (auto-apply)](../design/UAP_REACTOR.md).

---

## `status`

Show HALO trace collection state (enabled, path, span count). `--json` for
machine-readable output. (Equivalent to `uap harness status`.)

---

## `ideate`

Divergent ideation (open-collider): generate non-trivial ideas for hard
problems.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `setup <name>` | `--force`, `--json` | Scaffold an ideation project under `projects/<name>/` |
| `run <name>` | — | Drive the brainstorm flow for a project (Skill mode is free) |
| `ideas <name>` | `--json` | Print the curated ideas produced for a project |

```bash
uap ideate setup cache-strategy
uap ideate run cache-strategy
uap ideate ideas cache-strategy --json
```

---

## `coord`

Agent coordination and status.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `status` | `-v, --verbose` | Show coordination status (agents, claims, deploys) |
| `flush` | — | Force execute all pending deploys |
| `cleanup` | — | Clean up stale agents and expired data |

---

## `agent`

Agent lifecycle, work coordination, and communication. Each agent works in an
isolated worktree.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `register` | `-n, --name`, `-i, --id`, `-c, --capabilities`, `-w, --worktree` | Register a new agent |
| `heartbeat` | `-i, --id` | Send a heartbeat for an agent |
| `status` | `-i, --id` | Show agent status (all if id omitted) |
| `announce` | `-i, --id`, `-r, --resource`, `--intent`, `-d`, `-f, --files`, `--minutes` | Announce intent to work on a resource (enables overlap detection) |
| `complete` | `-i, --id`, `-r, --resource` | Mark work complete on a resource |
| `overlaps` | `-r, --resource` | Check for overlapping work (merge-conflict risk) |
| `broadcast` | `-i, --id`, `-c, --channel`, `-m, --message`, `-p, --priority` (5) | Broadcast a message to all agents |
| `send` | `-i, --id`, `-t, --to`, `-m, --message`, `-p, --priority` (5) | Send a direct message to another agent |
| `receive` | `-i, --id`, `-c, --channel`, `--no-mark-read` | Receive pending messages |
| `deregister` | `-i, --id` | Deregister an agent |

`--intent` accepts `editing`, `reviewing`, `refactoring`, `testing`,
`documenting`. `--channel` accepts `broadcast`, `deploy`, `review`,
`coordination`.

```bash
uap agent register -n builder-1 -c "typescript,testing" -w feature/082-docs
uap agent announce -i builder-1 -r src/api --intent editing --minutes 30
uap agent overlaps -r src/api
```

---

## `deploy`

Deployment batching and execution.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `queue` | `-a, --agent-id`, `-t, --action-type`, `--target`, `-m, --message`, `-f, --files`, `-r, --remote` (origin), `--force`, `--ref`, `--inputs`, `-p, --priority` (5) | Queue a deploy action for batching |
| `batch` | `-v, --verbose` | Create a batch from pending deploy actions |
| `execute` | `-b, --batch-id`, `--dry-run` | Execute a deploy batch |
| `status` | `-v, --verbose` | Show deploy queue status |
| `flush` | `-v, --verbose`, `--dry-run` | Flush all pending deploys (batch + execute) |
| `config` | — | Show deploy batch configuration (window settings) |
| `set-config` | `--message <json>` | Set deploy batch window settings, e.g. `{"commit":60000}` |
| `urgent` | `--on`, `--off` | Enable/disable urgent mode (fast batch windows) |

`--action-type` accepts `commit`, `push`, `merge`, `deploy`, `workflow`.

```bash
uap deploy queue -a builder-1 -t commit -m "feat: add endpoint" -f src/api.ts
uap deploy flush --dry-run
```

---

## `task`

Task management.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `create` | `-t, --title`, `-d, --description`, `--type`, `-p, --priority` (2), `-l, --labels`, `--parent`, `-n, --notes`, `--json` | Create a new task |
| `list` | `-s, --filter-status`/`--status`, `--filter-type`, `--filter-priority`, `-a, --filter-assignee`, `-l, --filter-labels`, `--search`, `--show-blocked`, `--show-ready`, `-v`, `--json` | List tasks |
| `show <id>` | `-v, --verbose`, `--json` | Show task details |
| `update <id>` | `-t`, `-d`, `--type`, `-s, --status`, `-p`, `-a, --assignee`, `-w, --worktree`, `-l`, `-n` | Update a task |
| `close <id>` | `-r, --reason` | Close a task (mark done) |
| `delete <id>` | — | Delete a task |
| `ready` | `--json` | List tasks ready to work on (no blockers) |
| `blocked` | `--json` | List blocked tasks |
| `dep` | `-f, --from`, `-t, --to`, `--dep-type` (blocks) | Add a dependency between tasks |
| `undep` | `-f, --from`, `-t, --to` | Remove a dependency |
| `claim <id>` | `-b, --branch` | Claim a task (assign + announce + create worktree) |
| `release <id>` | `-r, --reason` | Release a task (mark complete + announce) |
| `stats` | `--json` | Show task statistics |
| `board` | — | Show tasks as a kanban board |
| `sync` | — | Sync tasks with JSONL file (for git versioning) |
| `compact` | `--days` (90) | Compact old closed tasks into summaries |

`--type`: `task`, `bug`, `feature`, `epic`, `chore`, `story`. `--priority`: 0-4
(P0=critical ... P4=backlog). `--status`: `open`, `in_progress`, `blocked`,
`done`, `wont_do`. `--dep-type`: `blocks`, `related`, `discovered_from`.

```bash
uap task create -t "Add health endpoint" --type feature -p 1 -l api,infra
uap task ready
uap task claim TASK-42 -b feature/health-endpoint
uap task board
```

---

## `compliance`

UAP protocol compliance checking, auditing, and auto-fix.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `check` | `-v, --verbose` | Run compliance check (schema, memory, Qdrant, worktrees, secrets) |
| `report` | `-o, --output`, `-f, --format` (text/markdown/json), `-v` | Generate a detailed compliance report |
| `audit` | `-v, --verbose` | Deep compliance audit with verbose output |
| `fix` | `-v, --verbose` | Auto-fix issues (schema migrations, Qdrant collections, worktree cleanup) |

```bash
uap compliance check -v
uap compliance report -f markdown -o compliance.md
```

---

## `coordination`

Coordination overlap checks and resolution.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `check` | `--agents`, `-r, --resource`, `-v, --verbose`, `--json` | Check for overlapping work between agents |
| `resolve <overlapId>` | `--action` (assign/merge/delegate), `--json` | Resolve identified overlaps |

```bash
uap coordination check -r src/api --json
uap coordination resolve src/api --action delegate
```

---

## `skill`

Skill management and loading.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `list` | `-c, --category`, `--json` | List available skills |
| `load <skill>` | `-c, --category` | Load a specific skill for the current session |

---

## `dashboard`

Rich data visualisation dashboard for tasks, agents, memory, and progress.
Aliased as `dash`.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `overview` | `-v`, `--compact` | Full system overview with charts and progress bars |
| `tasks` | `-v`, `--compact` | Task breakdown with charts, progress bars, hierarchy trees |
| `agents` | `-v` | Agent activity, resource claims, coordination status |
| `memory` | `-v` | Memory system health, capacity, layer architecture |
| `progress` | `-v` | Completion tracking per-priority and per-type |
| `serve` | `-p, --port` (3847), `--host`, `--refresh <seconds>` (2) | Start the web-based dashboard server with live updates; `--refresh` sets the snapshot push/poll cadence (min 0.25s, env `UAP_DASH_REFRESH_MS`) |
| `stats` | `-v` | Session context consumption stats with per-tool breakdown |
| `session` | `-v`, `--compact` | Live UAP session state: infra, patterns, skills, git, policies |
| `benchmark` | `-v` | Benchmark results and performance comparison |
| `policies` | `-v` | Policy enforcement status and compliance |
| `models` | `-v` | Multi-model architecture status and routing analytics |
| `export` | `-o, --output` | Export dashboard data as JSON |
| `history` | `-v` | Session history and trend analysis |

```bash
uap dashboard overview
uap dash serve --port 4000
uap dashboard session --compact
```

---

## `model`

Multi-model architecture management.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `status` | — | Show configured models and role assignments |
| `route <task>` | `-v, --verbose` | Analyze how a task would be routed |
| `plan <task>` | `-v, --verbose`, `-e, --execute` | Create (and optionally run) an execution plan |
| `compare` | — | Compare cost/performance of different configurations |
| `presets` | — | List all available model presets |
| `select` | `--save` | Interactively select models for each role |
| `export` | `-f, --format` (json/yaml) | Export the current configuration |
| `health` | — | Check model health and configuration validity |

```bash
uap model status
uap model route "implement OAuth2 with JWT" -v
uap model plan "add a caching layer" --execute
uap model select --save
```

---

## `mcp-router`

MCP Router — hierarchical router for 98%+ token reduction. Exposes two meta-tools
(discover + execute) instead of every server's full tool list.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `start` | `-c, --config`, `-v, --verbose` | Start the MCP router as a stdio server |
| `stats` | `-c, --config`, `-v`, `--json` | Show router statistics (servers, tools, token savings) |
| `discover` | `-q, --query`, `-s, --server`, `-l, --limit` (10), `-c`, `-v`, `--json` | Discover tools matching a query |
| `list` | `-c, --config`, `--json` | List configured MCP servers |

```bash
uap mcp-router start --config ./mcp.json
uap mcp-router discover -q "send a slack message" --limit 5
uap mcp-router stats --json
```

---

## `hooks`

Manage session hooks for Claude Code, Factory.AI, Cursor, VSCode, OpenCode,
Codex, ForgeCode, Oh-My-Pi, and Hermes.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `install` | `-t, --target` / `-p, --platform` | Install UAP session hooks |
| `status` | `-t, --target` / `-p, --platform` | Show hooks installation status |
| `doctor` | `-t, --target` / `-p, --platform` | Audit policy-gate coverage across platforms (non-zero exit on gaps) |

Targets: `claude`, `factory`, `cursor`, `vscode`, `opencode`, `codex`,
`forgecode`, `omp`, `hermes` (default: all).

```bash
uap hooks install -t claude
uap hooks doctor
```

---

## `tool-calls`

Manage Qwen3.5 tool call fixes and chat templates.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `setup` | — | Install chat templates and Python scripts |
| `test` | `--verbose` | Run the reliability test suite |
| `status` | — | Check current configuration |
| `fix` | — | Apply template fixes to existing templates |

---

## `rtk`

Manage RTK (Rust Token Killer) integration for token optimization.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `install` | `--force`, `--method` (npm/cargo/binary) | Install the RTK CLI proxy for 60-90% token savings |
| `status` | — | Check RTK installation and token savings |
| `help` | — | Show RTK usage information |

---

## `mcp-setup`

Configure MCP Router for all AI harnesses (Claude, Factory, VSCode, Cursor).

```bash
uap mcp-setup [options]
```

| Flag | Purpose |
|------|---------|
| `--force` | Force replace existing MCP configurations |
| `--verbose` | Enable verbose output |

---

## `schema-diff`

Detect breaking schema changes between branches. Diffs Zod schemas, TypeScript
interfaces, SQLite table definitions, and JSON schema/config files. Exits
non-zero when breaking changes are detected.

```bash
uap schema-diff [options]
```

| Flag | Purpose |
|------|---------|
| `-b, --base <branch>` | Base branch/commit to compare against (default `HEAD~1`) |

```bash
uap schema-diff --base origin/master
```

---

## `policy`

UAP policy management.

| Subcommand | Key flags | Purpose |
|------------|-----------|---------|
| `list` | — | List all policies and their status |
| `install <name>` | — | Install a built-in policy |
| `enable <id>` | — | Enable a policy by ID |
| `disable <id>` | — | Disable a policy by ID |
| `status` | — | Show detailed policy enforcement status |
| `add` | `-f, --file` (required), `-c, --category` (custom), `-l, --level` (RECOMMENDED), `-t, --tags` | Add a new policy from a markdown file |
| `convert` | `-i, --input` (required), `-o, --output` | Convert a raw policy to CLAUDE.md format |
| `get-relevant` | `-t, --task` (required), `--top` (3) | Get policies relevant to a task context |
| `add-tool` | `-p, --policy` (req), `-t, --tool` (req), `-c, --code` (req) | Attach Python tool code to a policy |
| `check` | `-o, --operation` (req), `-a, --args` (`{}`) | Check if an operation would be allowed |
| `audit` | `-p, --policy`, `-n, --limit` (20) | Show the policy enforcement audit trail |
| `toggle <id>` | `--on`, `--off` | Toggle a policy on or off |
| `stage <id>` | `-s, --stage` (req) | Change a policy's enforcement stage |
| `level <id>` | `-l, --level` (req) | Change a policy's enforcement level |

Levels: `REQUIRED`, `RECOMMENDED`, `OPTIONAL`. Stages: `pre-exec`,
`post-exec`, `review`, `always`.

```bash
uap policy list
uap policy install mandatory-testing-deployment
uap policy check -o "git push" -a '{"branch":"master"}'
uap policy stage POL-1 -s pre-exec
```

---

## `uap-omp`

UAP integration commands for oh-my-pi (omp) users. Thin wrappers over the
installed omp scripts and SQLite memory store.

| Subcommand | Purpose |
|------------|---------|
| `dashboard` | Show the UAP dashboard (tasks, agents, memory, worktrees) |
| `memory status` | Show omp memory status |
| `memory query <search>` (`-n, --limit` 5) | Query omp memory for relevant context |
| `worktree list` | List active worktrees |
| `worktree create <slug>` | Create a new worktree (delegates to `uap worktree create`) |
| `hooks install` | Install UAP hooks for oh-my-pi |
| `hooks status` | Show hook installation status |

---

## Environment variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `UAP_DELIVER_MODEL` | `deliver` | Default model preset for the convergence loop |
| `UAP_ESCALATE_MODEL` | `deliver` | Stronger model preset for escalation |
| `UAP_HALO_TRACE_PATH` | `harness` | Default HALO trace JSONL path |
| `UAP_EMBEDDING_ENDPOINT` | memory/embeddings | Embedding service endpoint |
