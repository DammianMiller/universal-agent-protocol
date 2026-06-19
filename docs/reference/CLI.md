# UAP CLI Reference

> Complete command reference for the Universal Agent Protocol command-line interface (`uap`).
> Version v1.50.0.

The `uap` binary is the single entry point for every UAP capability: project
initialization, the tiered memory system, git worktree workflow, multi-agent
coordination, task management, the multi-model architecture, the MCP router,
policy enforcement, the delivery convergence loop, and platform hook
management.

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
| [`setup`](#setup) | One-command setup: init + Qdrant + Python deps + index patterns |
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
| `-i, --interactive` | Run the guided wizard (now the default; kept for back-compat) |

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
| `serve` | `-p, --port` (3847) | Start the web-based dashboard server with live updates |
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
