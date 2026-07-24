#!/usr/bin/env node

import { Command, Option } from 'commander';
import { registerConfigCommands } from '../cli/config-command.js';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// Lazy import helpers - commands are loaded on-demand to reduce startup time (~10x faster --help)
// Each command module is only imported when its action handler is invoked.
const lazy = {
  init: () => import('../cli/init.js').then((m) => m.initCommand),
  analyze: () => import('../cli/analyze.js').then((m) => m.analyzeCommand),
  generate: () => import('../cli/generate.js').then((m) => m.generateCommand),
  memory: () => import('../cli/memory.js').then((m) => m.memoryCommand),
  worktree: () => import('../cli/worktree.js').then((m) => m.worktreeCommand),
  mergeQueue: () => import('../cli/merge-queue.js').then((m) => m.mergeQueueCommand),
  sync: () => import('../cli/sync.js').then((m) => m.syncCommand),
  droids: () => import('../cli/droids.js').then((m) => m.droidsCommand),
  coord: () => import('../cli/coord.js').then((m) => m.coordCommand),
  agent: () => import('../cli/agent.js').then((m) => m.agentCommand),
  deploy: () => import('../cli/deploy.js').then((m) => m.deployCommand),
  task: () => import('../cli/task.js').then((m) => m.taskCommand),
  model: () => import('../cli/model.js').then((m) => m.registerModelCommands),
  mcpRouter: () => import('../cli/mcp-router.js').then((m) => m.mcpRouterCommand),
  dashboard: () => import('../cli/dashboard.js').then((m) => m.dashboardCommand),
  hooks: () => import('../cli/hooks.js'),
  patterns: () => import('../cli/patterns.js').then((m) => m.patternsCommand),
  skill: () => import('../cli/skill.js').then((m) => m.skillCommand),
  setup: () => import('../cli/setup.js').then((m) => m.setupCommand),
  setupMcpRouter: () => import('../cli/setup-mcp-router.js').then((m) => m.setupMcpRouter),
  compliance: () => import('../cli/compliance.js').then((m) => m.complianceCommand),
  schemaDiff: () => import('../cli/schema-diff.js').then((m) => m.registerSchemaDiffCommand),
  rtk: () => import('../cli/rtk.js'),
  toolCalls: () => import('../cli/tool-calls.js').then((m) => m.toolCallsCommand),
  policy: () => import('../cli/policy.js').then((m) => m.registerPolicyCommands),
  expertRoute: () => import('../cli/expert-route.js').then((m) => m.expertRouteCommand),
  react: () => import('../cli/react.js').then((m) => m.reactCommand),
  harness: () => import('../cli/harness.js').then((m) => m.harnessCommand),
  selfHarness: () => import('../cli/self-harness.js').then((m) => m.selfHarnessCommand),
  ideate: () => import('../cli/ideate.js').then((m) => m.ideateCommand),
  deliver: () => import('../cli/deliver.js').then((m) => m.deliverCommand),
  verify: () => import('../cli/verify.js').then((m) => m.verifyCommand),
  orchestratorToggle: () => import('../cli/orchestrator-toggle.js').then((m) => m.orchestratorToggleCommand),
  handsfree: () => import('../cli/handsfree.js').then((m) => m.handsfreeCommand),
  proxy: () => import('../cli/proxy.js').then((m) => m.proxyCommand),
  benchPaired: () => import('../cli/bench.js').then((m) => m.benchPairedCommand),
  tune: () => import('../cli/self-tuning.js').then((m) => m.tuneCommand),
  sandbox: () => import('../cli/sandbox.js').then((m) => m.sandboxCommand),
  design: () => import('../cli/design.js').then((m) => m.designCommand),
  challenge: () => import('../cli/challenge.js').then((m) => m.challengeCommand),
  fidelity: () => import('../cli/fidelity.js').then((m) => m.fidelityCommand),
  plan: () => import('../cli/plan.js').then((m) => m.planCommand),
};

// Type alias for hooks target (used in action handlers). Mirrors ALL_TARGETS
// in src/cli/hooks.ts — keep in sync.
type HooksTarget =
  | 'claude'
  | 'factory'
  | 'cursor'
  | 'vscode'
  | 'opencode'
  | 'codex'
  | 'forgecode'
  | 'omp'
  | 'hermes';

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const program = new Command();

program
  .name('uap')
  .description('Universal AI agent memory system for Claude Code, Factory.AI, VSCode, and OpenCode')
  .version(packageJson.version);

program
  .command('init')
  .description('Initialize agent context in the current project')
  .option(
    '-p, --platform <platforms...>',
    'Target platforms (claude, factory, vscode, opencode, omp, all)',
    ['all']
  )
  .option('--web', 'Generate AGENT.md for web platforms (claude.ai, factory.ai)')
  .option('--no-memory', 'Skip memory system setup')
  .option('--no-worktrees', 'Skip worktree workflow setup')
  .option('--patterns', 'Enable pattern RAG setup (auto-detected by default)')
  .option('--no-patterns', 'Skip pattern RAG setup')
  .option(
    '--pipeline-only',
    'Enforce pipeline-only infrastructure changes (no direct kubectl/terraform)'
  )
  .option(
    '--systemd-services',
    'Optionally scaffold user systemd services for llama.cpp and anthropic proxy'
  )
  .option('-f, --force', 'Overwrite existing configuration')
  .action(async (options) => {
    const cmd = await lazy.init();
    await cmd(options);
  });

program
  .command('setup')
  .description('Guided one-command setup (arrow-key wizard by default): init + services + patterns, with instruction-file backup and custom-content extraction into policies/skills')
  .option(
    '-p, --platform <platforms...>',
    'Target platforms (claude, factory, vscode, opencode, omp, cline, codex, aider, continue, windsurf, zed, copilot, jetbrains, swe-agent, all)',
    ['all']
  )
  .option('--no-patterns', 'Skip pattern RAG setup')
  .option('--no-memory', 'Skip memory system setup')
  .option('--no-self-update', 'Skip the automatic UAP CLI version check / self-update (also UAP_NO_SELF_UPDATE=1)')
  .option('--non-interactive', 'Run the scripted (non-guided) setup; also used automatically on CI / non-TTY')
  .option('-y, --yes', 'Alias for --non-interactive (accept defaults, no prompts)')
  .option('--no-backup', 'Do not back up agent instruction files before modifying them')
  .option('--no-extract', 'Do not detect/extract custom instruction content into policies/skills')
  .option('--extract-auto', 'In non-interactive mode, auto-extract custom content (default: report only)')
  .option(
    '--profile <name>',
    'Setup profile bundle: recommended | maximum | minimal | custom (custom = baseline + the `uap config` expert configurator exposing every setting + policy selection)'
  )
  .option(
    '--systemd-services',
    'Optionally scaffold user systemd services for llama.cpp and anthropic proxy'
  )
  .option(
    '-d, --project-dir <path>',
    'Target project directory (defaults to current working directory)'
  )
  .option('-i, --interactive', 'Run the guided wizard (now the default; kept for back-compat)')
  .action(async (options) => {
    (await lazy.setup())(options);
  });

program
  .command('proxy [subcommand] [value]')
  .description('Reference-counted, session-scoped proxy + dashboard lifecycle: ensure | release | status | start | stop | restart | enable | disable | dashboard [on|off]')
  .option('--client <id>', 'Client/session id (defaults to session env or parent pid)')
  .option('--client-pid <n>', 'Long-lived agent pid for liveness (hooks pass $PPID)')
  .option('--port <n>', 'Proxy port (default 4000 / $PROXY_PORT)')
  .option('--quiet', 'Suppress output (used by hooks)')
  .option('--if-enabled', 'No-op unless .uap.json proxy.autostart is true (hook-safe)')
  .option('--json', 'Machine-readable status output')
  .option('--no-dashboard', 'Do not start the ride-along dashboard for this invocation')
  .action(async (subcommand, value, options) => {
    await (await lazy.proxy())(subcommand, { ...options, value });
  });

program
  .command('analyze')
  .description('Analyze project structure and generate metadata')
  .option('-o, --output <format>', 'Output format (json, yaml, md)', 'json')
  .option('--save', 'Save analysis to .uap.analysis.json')
  .action(async (options) => {
    (await lazy.analyze())(options);
  });

program
  .command('sandbox')
  .description(
    'Run a command with a kernel-enforced workdir boundary (bubblewrap): only the ' +
      'current dir + scratch are writable, so writes outside fail at the kernel — the ' +
      'boundary --dangerously-skip-permissions cannot bypass. Usage: uap sandbox -- <command> [args...]',
  )
  .argument('[command...]', 'Command to run sandboxed (prefix with -- to pass its flags through)')
  .allowUnknownOption(true)
  .action(async (command: string[]) => {
    await (await lazy.sandbox())(command || []);
  });

program
  .command('generate')
  .description('Generate or update CLAUDE.md and related files')
  .option('-f, --force', 'Overwrite existing files without confirmation')
  .option('-d, --dry-run', 'Show what would be generated without writing')
  .option('-p, --platform <platform>', 'Generate for specific platform only')
  .option('--template <template>', 'Template to use (default or custom)')
  .option('--sections <sections>', 'Comma-separated sections to include')
  .option('--web', 'Generate AGENT.md for web platforms (claude.ai, factory.ai)')
  .option(
    '--pipeline-only',
    'Enforce pipeline-only infrastructure changes (no direct kubectl/terraform)'
  )
  .action(async (options) => {
    (await lazy.generate())(options);
  });

program
  .command('memory')
  .description('Manage agent memory system')
  .addCommand(
    new Command('status').description('Show memory system status').action(async () => {
      (await lazy.memory())('status');
    })
  )
  .addCommand(
    new Command('start')
      .description('Start memory services (Qdrant container)')
      .action(async () => {
        (await lazy.memory())('start');
      })
  )
  .addCommand(
    new Command('stop').description('Stop memory services').action(async () => {
      (await lazy.memory())('stop');
    })
  )
  .addCommand(
    new Command('query')
      .description('Query long-term memory')
      .argument('<search>', 'Search term')
      .option('-n, --limit <number>', 'Max results', '10')
      .option('-k, --top-k <number>', 'Alias for --limit', '10')
      .option('-t, --threshold <number>', 'Minimum similarity score (0-1)', '0.35')
      .action(async (search, options) => {
        (await lazy.memory())('query', { search, ...options });
      })
  )
  .addCommand(
    new Command('store')
      .description('Store a memory (applies write gate unless --force)')
      .argument('<content>', 'Memory content')
      .option('-t, --tags <tags>', 'Comma-separated tags')
      .option('-i, --importance <number>', 'Importance score (1-10)', '5')
      .option('-f, --force', 'Bypass write gate (store without quality check)')
      .action(async (content, options) => {
        (await lazy.memory())('store', { content, ...options });
      })
  )
  .addCommand(
    new Command('bridge')
      .description("Hijack each coding agent's native memory file (Claude MEMORY.md, AGENTS.md, GEMINI.md, Cursor, Copilot) to point at UAP's unified memory")
      .option('--all', 'Also write files for agents not currently detected')
      .action(async (options) => {
        (await lazy.memory())('bridge', options);
      })
  )
  .addCommand(
    new Command('sync-files')
      .description(
        'Embed Claude Code memory topic files (~/.claude/projects/<cwd>/memory/*.md) into Qdrant so they are recall-able via query'
      )
      .option('--dir <path>', 'Memory directory (default: the Claude Code project memory dir for cwd)')
      .action(async (options) => {
        (await lazy.memory())('sync-files', options);
      })
  )
  .addCommand(
    new Command('prepopulate')
      .description('Prepopulate memory from documentation and git history')
      .option('--docs', 'Import from documentation only')
      .option('--git', 'Import from git history only')
      .option('-n, --limit <number>', 'Limit git commits to analyze', '500')
      .option('--since <date>', 'Only analyze commits since date (e.g., "2024-01-01")')
      .option('-v, --verbose', 'Show detailed output')
      .action(async (options) => {
        (await lazy.memory())('prepopulate', options);
      })
  )
  .addCommand(
    new Command('promote')
      .description('Review and promote daily log entries to working/semantic memory')
      .action(async (options) => {
        (await lazy.memory())('promote', options);
      })
  )
  .addCommand(
    new Command('correct')
      .description('Correct a memory (propagates across all tiers, marks old as superseded)')
      .argument('<search>', 'Search term to find the memory to correct')
      .option('-c, --correction <text>', 'The corrected content')
      .option('-r, --reason <reason>', 'Reason for correction')
      .action(async (search, options) => {
        (await lazy.memory())('correct', { search, ...options });
      })
  )
  .addCommand(
    new Command('maintain')
      .description('Run maintenance: decay, prune stale, archive old, remove duplicates')
      .option('-v, --verbose', 'Show detailed output')
      .action(async (options) => {
        (await lazy.memory())('maintain', options);
      })
  );

// Pattern RAG Commands
program
  .command('patterns')
  .description('Manage pattern RAG (on-demand pattern retrieval via Qdrant)')
  .addCommand(
    new Command('status')
      .description('Show pattern RAG status and collection info')
      .action(async () => {
        (await lazy.patterns())('status');
      })
  )
  .addCommand(
    new Command('index')
      .description('Index patterns from CLAUDE.md into Qdrant')
      .option('-v, --verbose', 'Show detailed output')
      .action(async (options) => {
        (await lazy.patterns())('index', options);
      })
  )
  .addCommand(
    new Command('query')
      .description('Query patterns by task description')
      .argument('<search>', 'Task description to match')
      .option('-n, --top <number>', 'Number of results', '2')
      .option('--min-score <number>', 'Minimum similarity score', '0.35')
      .option('--format <format>', 'Output format (text, json, context)', 'text')
      .action(async (search, options) => {
        (await lazy.patterns())('query', { search, ...options });
      })
  )
  .addCommand(
    new Command('generate')
      .description('Generate Python index/query scripts from config')
      .option('-f, --force', 'Overwrite existing scripts')
      .action(async (options) => {
        (await lazy.patterns())('generate', options);
      })
  );

program
  .command('worktree')
  .description('Manage git worktrees')
  .addCommand(
    new Command('create')
      .description('Create a new worktree for a feature')
      .argument('<slug>', 'Feature slug (e.g., add-user-auth)')
      .option('-f, --from <branch>', 'Base branch (defaults to the fetched origin/<default>)')
      .option('-d, --description <description>', 'Optional worktree description')
      .option('--no-fetch', 'Skip fetching the base branch (offline)')
      .action(async (slug, options) => {
        // commander maps `--no-fetch` to options.fetch === false
        (await lazy.worktree())('create', { slug, ...options, noFetch: options.fetch === false });
      })
  )
  .addCommand(
    new Command('list').description('List all worktrees').action(async () => {
      (await lazy.worktree())('list');
    })
  )
  .addCommand(
    new Command('pr')
      .description('Create PR from worktree')
      .argument('<id>', 'Worktree ID')
      .option('--draft', 'Create as draft PR')
      .action(async (id, options) => {
        (await lazy.worktree())('pr', { id, ...options });
      })
  )
  .addCommand(
    new Command('finish')
      .description('Sync, merge PR, and auto-cleanup worktree')
      .argument('<id>', 'Worktree ID')
      .action(async (id) => {
        (await lazy.worktree())('finish', { id });
      })
  )
  .addCommand(
    new Command('cleanup')
      .description('Remove worktree and delete branch')
      .argument('<id>', 'Worktree ID')
      .action(async (id) => {
        (await lazy.worktree())('cleanup', { id });
      })
  )
  .addCommand(
    new Command('ensure')
      .description('Check if working inside a worktree')
      .option('--strict', 'Exit with code 1 if not in a worktree (for use as a gate)')
      .action(async (options) => {
        (await lazy.worktree())('ensure', { strict: options.strict });
      })
  )
  .addCommand(
    new Command('sync')
      .description('Merge the latest integration branch into a worktree (mid-flight re-base)')
      .option('-i, --id <id>', 'Worktree ID (defaults to the current directory)')
      .option('-a, --all', 'Sync every worktree')
      .action(async (options) => {
        (await lazy.worktree())('sync', { id: options.id, all: options.all ?? false });
      })
  )
  .addCommand(
    new Command('hygiene')
      .description('Report drift, unmerged work, and stale worktrees')
      .option('-b, --brief', 'One-line advisory (for session banners)')
      .action(async (options) => {
        (await lazy.worktree())('hygiene', { brief: options.brief ?? false });
      })
  )
  .addCommand(
    new Command('prune')
      .description('Prune stale worktrees older than specified days')
      .option('-o, --older-than <days>', 'Only prune worktrees older than N days', '30')
      .option('-f, --force', 'Skip confirmation prompt')
      .option('-n, --dry-run', 'Preview without making changes')
      .action(async (options) => {
        (await lazy.worktree())('prune', {
          olderThan: parseInt(options.olderThan, 10),
          force: options.force ?? false,
          dryRun: options.dryRun ?? false,
        });
      })
  );

program
  .command('merge')
  .description('Serialized landing of concurrent agent PRs')
  .addCommand(
    new Command('queue')
      .description('Land open PRs one at a time, re-syncing impacted PRs after each merge')
      .option('-n, --dry-run', 'Show the landing order without merging')
      .option('-l, --limit <n>', 'Only land the first N PRs')
      .option('--force', 'Land even when checks are not green')
      .action(async (options) => {
        (await lazy.mergeQueue())({
          dryRun: options.dryRun ?? false,
          limit: options.limit ? parseInt(options.limit, 10) : undefined,
          force: options.force ?? false,
        });
      })
  );

program
  .command('sync')
  .description('Sync configuration between platforms')
  .option('--from <platform>', 'Source platform (claude, factory, vscode, opencode)')
  .option('--to <platform>', 'Target platform(s)')
  .option('--dry-run', 'Preview changes without writing files')
  .action(async (options) => {
    (await lazy.sync())(options);
  });

program
  .command('droids')
  .description('Manage custom droids/agents')
  .addCommand(
    new Command('list').description('List all droids').action(async () => {
      (await lazy.droids())('list');
    })
  )
  .addCommand(
    new Command('add')
      .description('Add a new droid')
      .argument('<name>', 'Droid name')
      .option('-t, --template <template>', 'Use built-in template')
      .action(async (name, options) => {
        (await lazy.droids())('add', { name, ...options });
      })
  )
  .addCommand(
    new Command('import')
      .description('Import droids from another platform')
      .argument('<path>', 'Path to import from')
      .action(async (path) => {
        (await lazy.droids())('import', { path });
      })
  )
  .addCommand(
    new Command('validate')
      .description('Validate droid files against capability-router expectations')
      .option('-q, --quiet', 'Suppress report output (exit code only)')
      .action(async (options) => {
        (await lazy.droids())('validate', options);
      })
  );

program
  .command('expert-route')
  .description('Recommend an expert droid chain for a task description')
  .argument('<description...>', 'Task description (quoted or space-separated)')
  .option('-f, --files <files...>', 'Affected file paths to refine routing')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (descriptionParts: string[], options) => {
    const description = descriptionParts.join(' ');
    const cmd = await lazy.expertRoute();
    await cmd(description, options);
  });

// Reactor: dynamic UAP capability resolution for harness adapters
program
  .command('react')
  .description('Resolve dynamic UAP capabilities (experts/skills/patterns) for an event; emits JSON')
  .option('--event <event>', 'Lifecycle event: user-prompt|session-start|pre-tool|post-tool|stop|session-end')
  .option('--prompt <text>', 'Prompt text (when not piping a JSON payload on stdin)')
  .option('-f, --files <files...>', 'Changed files (routing signal)')
  .option('--inject-threshold <n>', 'Min confidence to inject (default 0.30)')
  .option('--auto-spawn-threshold <n>', 'Min confidence to auto-spawn an expert (default 0.80)')
  .option('--auto-spawn-types <types>', 'Comma-separated task-type whitelist for auto-spawn')
  .option('--max-inject-chars <n>', 'Inject character budget (default 1200)')
  .option('--surfaced <keys>', 'Comma-separated keys already injected this session (dedup)')
  .action(async (options) => {
    const cmd = await lazy.react();
    await cmd(options);
  });

// DESIGN.md integration — auto-interrogate existing UI + guide new UI on-token
program
  .command('design')
  .description('DESIGN.md integration: interrogate existing UI, lint, sync the token gate, guide new UI')
  .argument('[subcommand]', 'interrogate | sync | lint | diff | context | check')
  .argument('[target]', 'Positional target file (lint/check) — same as --file')
  .option('-d, --project-dir <path>', 'Project directory (default: cwd)')
  .option('-o, --out <path>', 'Output path for interrogate (default: DESIGN.md)')
  .option('--force', 'Overwrite an existing DESIGN.md')
  .option('--json', 'Emit machine-readable JSON')
  .option('-f, --file <path>', 'Target file (lint/check) or "old,new" (diff)')
  .action(async (subcommand, target, options) => {
    // Allow `uap design lint DESIGN.md` (positional) as well as `--file`.
    if (target && !options.file) options.file = target;
    const cmd = await lazy.design();
    await cmd(subcommand, options);
  });

// Open multi-agent challenge mode (composes board + findings + staged + significance)
program
  .command('challenge')
  .description('Open multi-agent challenge: shared goal, verified submissions, significance-gated leaderboard')
  .addCommand(
    new Command('create')
      .description('Open a challenge with a shared goal')
      .argument('<goal>', 'The shared goal')
      .option('--metric <name>', 'Metric name (e.g. tps, success-rate)')
      .option('--rope-margin <x>', 'Tie margin: scores within ±x of the leader are ties', '0')
      .option('--lower-is-better', 'Lower metric is better (default higher)')
      .action(async (goal, options) => {
        (await lazy.challenge())('create', { ...options, goal });
      })
  )
  .addCommand(
    new Command('submit')
      .description('Submit a result to a challenge')
      .argument('<id>', 'Challenge id')
      .requiredOption('--score <x>', 'Metric score')
      .option('--artifact <ref>', 'Artifact path/ref')
      .option('--note <text>', 'Note')
      .option('--verified', 'Mark verified (only verified entries rank)')
      .option('--agent <id>', 'Submitting agent id')
      .action(async (id, options) => {
        (await lazy.challenge())('submit', { ...options, id });
      })
  )
  .addCommand(
    new Command('verify')
      .description('Mark a submission verified')
      .argument('<submissionId>', 'Submission id')
      .action(async (submissionId, options) => {
        (await lazy.challenge())('verify', { ...options, id: submissionId });
      })
  )
  .addCommand(
    new Command('leaderboard')
      .description('Show the significance-gated leaderboard')
      .argument('<id>', 'Challenge id')
      .option('--json', 'Emit JSON')
      .action(async (id, options) => {
        (await lazy.challenge())('leaderboard', { ...options, id });
      })
  )
  .addCommand(
    new Command('status')
      .description('Challenge overview: leaderboard + board/findings/staged counts')
      .argument('<id>', 'Challenge id')
      .option('--json', 'Emit JSON')
      .action(async (id, options) => {
        (await lazy.challenge())('status', { ...options, id });
      })
  )
  .addCommand(
    new Command('list')
      .description('List challenges')
      .option('--status <status>', 'open | closed')
      .option('--json', 'Emit JSON')
      .action(async (options) => {
        (await lazy.challenge())('list', options);
      })
  )
  .addCommand(
    new Command('close')
      .description('Close a challenge')
      .argument('<id>', 'Challenge id')
      .action(async (id, options) => {
        (await lazy.challenge())('close', { ...options, id });
      })
  )
  .addCommand(
    new Command('run')
      .description('Launch N participant agents against a challenge (bounded concurrency)')
      .argument('<id>', 'Challenge id')
      .requiredOption('--agents <n>', 'Number of participant agents')
      .requiredOption('--cmd <template>', 'Participant command per agent; placeholders {agent} {challenge} {goal} {index}')
      .option('--concurrency <k>', 'Max agents running at once (default: model-slot budget)')
      .option('--timeout <s>', 'Per-agent timeout in seconds', '120')
      .option('--prefix <name>', 'Agent id prefix (default "agent")')
      .option('-y, --yes', 'Skip the launch confirmation prompt')
      .option('--json', 'Emit JSON report')
      .action(async (id, options) => {
        (await lazy.challenge())('run', { ...options, id });
      })
  );



// Fable-parity delivery loop
program
  .command('deliver')
  .description('Convergence loop: iterate a model against real completion gates until delivery')
  .argument('[instruction...]', 'Task instruction for the model (optional with --resume)')
  .option('--max-turns <n>', 'Maximum execute→verify iterations', '5')
  .option('-m, --model <preset>', 'Model preset id (default: $UAP_DELIVER_MODEL or qwen35-a3b)')
  .option('--routing <preset>', 'Complexity-tier routing: pick the executor model by task complexity from a named routing preset (e.g. cost-tiered, speed-tiered). Ignored when --model is set. Env: UAP_DELIVER_ROUTING')
  .option('--project-root <path>', 'Project whose gates define delivery (default: cwd)')
  .option('--endpoint <url>', 'Override the model endpoint (OpenAI-compatible /v1)')
  .option('--temperature <t>', 'Sampling temperature (default: execution-profile value)')
  .option('--gates <ids>', 'Comma-separated gate subset (build,typecheck,test,lint)')
  .option('--no-self-gate', 'Disable the self-authored acceptance gate fallback (on by default when no project gates are detected)')
  .option('--force-self-gate', 'Author a task-specific acceptance gate even when project gates exist')
  .option('--allow-noop', 'Permit delivery without any tree change (disables the anti-no-op acceptance rail for missions that genuinely require none)')
  .option('--pending [file]', 'Deterministically apply the edit intents recorded by the delivery gate (.uap/pending-deliver.jsonl) — exact-anchor replay, no model — then run the required gates once and exit')
  .option('--acceptance', 'After objective gates pass, judge spec behavioral completeness (LLM) and feed unmet requirements back so the loop completes the spec')
  .option('--executor <mode>', 'Per-turn executor: blind (one completion), agentic (tool-using read/list/bash/write loop), or auto (agentic when there is repo context/gates to inspect)', 'auto')
  .option('--allow-bash', "Permit the agentic executor's run_bash tool when NOT running under `uap sandbox`. Off by default: an unsandboxed shell is not contained to the workdir. Auto-enabled under `uap sandbox`.")
  .option('--evaluator-model <preset>', 'Author + judge the acceptance gate with a DIFFERENT model than the implementer (separate generator from evaluator; pairs with the barbell strategy). Default: same as --model')
  .option('--evaluator-endpoint <url>', 'Endpoint override for --evaluator-model')
  .option('--keep-best', 'Never regress: snapshot the project first and roll back if deliver ends with a worse required-gate score than it started (real gates only)')
  .option('--candidates <n>', 'Best-of-N exploration: candidates per turn (2-8)')
  .option('--critic', 'Structured critique of failed turns (extra model call per failure)')
  .option('--practices', 'Inject learned best-practice cards and record new ones on success')
  .option('--no-semantic', 'Use keyword (not embedding) retrieval for practice cards')
  .option('--escalate', 'Escalation ladder on stagnation (widen exploration -> critic -> stronger model)')
  .option('--escalate-model <preset>', 'Stronger model preset for escalation (default: $UAP_ESCALATE_MODEL)')
  .option('--ideate', 'Divergent ideation: generate task-specific strategy seeds for exploration')
  .option('--ideate-project <name>', 'Seed exploration from a curated open-collider project (projects/<name>)')
  .option('--halo', 'Emit HALO spans for this run (analyze with `uap harness analyze`)')
  .option('--coordinate', 'Register the run with the coordination layer (`uap agent`): announce, heartbeat, overlap detection')
  .option('--deploy', 'On success, queue a commit of applied files into the deploy batcher (`uap deploy flush`)')
  .option('--optimize', 'Enable every convergence aid: exploration, critic, practices, escalation, ideation, HALO, coordination')
  .option('--no-auto', 'Disable dynamic optimization (by default the task is classified and matching aids enable automatically)')
  .option('--no-protect-tests', 'Allow the model to modify pre-existing test files (protected by default)')
  .option('--guidance-file <path>', 'Poll this file each turn for operator guidance; steer a running mission (write to the file) without stopping it')
  .option('--no-until-delivered', 'Disable loop-until-delivered (ON by default: extends past --max-turns to a ceiling, stopping on stagnation)')
  .option('--ceiling <n>', 'Hard turn ceiling for until-delivered (1-50, default 30)')
  .option('--resume <id>', "Resume an interrupted durable run: a run id or 'latest' (.uap/deliver-runs)")
  .option('--no-lazy', 'Skip the lazy bare first attempt (by default one bare turn runs before the convergence aids engage)')
  .option('--decompose', 'Decompose the mission into sequential phases, each converged by its own loop (auto for long complex tasks)')
  .option('--no-decompose', 'Never decompose, even for epic-shaped instructions')
  .option('--orchestrate', 'Run decomposed tasks through the blackboard orchestrator with MINIMAL per-task context (each task sees only its goal + direct-dependency outputs) — for small-context models on large builds. Implies --decompose.')
  .option('--no-orchestrate', 'Disable the blackboard orchestrator for this run (decomposed missions fall back to the sequential phase runner)')
  .option('--epics', 'Run a MASSIVE mission as a sequence of epics: each epic is a fresh mission (only prior epics\' summaries injected), looped with fresh sessions until accepted. Auto for very long complex missions.')
  .option('--no-epics', 'Disable the epic controller for this run')
  .option('--no-integration', 'Skip the integration tier (on by default when a test:integration/e2e suite or pytest integration marker is detected)')
  .option('--deploy-dev', 'Run a local dev deploy + smoke tier (bring up compose / start server, smoke-check, tear down) after the fast tier passes')
  .option('--no-deploy-dev', 'Disable the local dev deploy tier even when auto/optimize would enable it')
  .option('--watch-ci', 'After local-green, commit + push the worktree branch and watch the CI run; re-converge on CI/deploy failure (never pushes master/main)')
  .option('--until-deployed', 'Imply --watch-ci and require the CI run plus staging/prod deploy jobs to be green before exiting 0')
  .option('--tiers <list>', 'Explicit comma list of local tiers to run (fast,integration,deploy-dev), overriding auto-detection')
  .option('--ci-passes <n>', 'Max CI re-converge passes on failure (1-10, default 2)')
  .option('--ci-timeout <minutes>', 'CI watch budget in minutes (1-120, default 20)')
  .option('--dry-run', 'Show detected gates and plan without calling the model')
  .option('--json', 'Emit JSON result')
  .action(async (instructionParts: string[] | undefined, options, command) => {
    // Explicit --max-turns is a hard cap downstream; the commander default
    // ('5') is indistinguishable by value, so record the option's source.
    options.maxTurnsExplicit = command.getOptionValueSource?.('maxTurns') === 'cli';
    const cmd = await lazy.deliver();
    await cmd((instructionParts ?? []).join(' '), options);
  });

program
  .command('handsfree [subcommand] [arg]')
  .alias('hf')
  .description('Hands-free persistence: status | on | off | init | complete <id> | fail <id> | remaining | stop-check. Auto-on; drives any model to loop until the multi-epic build ledger is 100% complete.')
  .option('--mission <text>', 'Mission text for `init`')
  .option('--items <json>', 'JSON array of ledger items for `init`')
  .action(async (subcommand, arg, options) => {
    const cmd = await lazy.handsfree();
    await cmd(subcommand, arg, options);
  });

program
  .command('orchestrator [state]')
  .description('Toggle the long multi-turn deliver orchestrator: on | off | auto (default) | status. Persists to .uap.json (deliver.orchestrate).')
  .action(async (state) => {
    const cmd = await lazy.orchestratorToggle();
    await cmd(state);
  });

program
  .command('verify')
  .description('Run the project\'s completion gates (incl. the runtime execution gate) against the current files and report pass/fail')
  .option('-d, --dir <path>', 'Project directory to verify (default: cwd)')
  .option('--strict', 'Treat "no verifiable gates" as a failure (fail-closed); used by the Stop hook')
  .option('--runtime-only', 'Run ONLY the runtime execution gate (cheap; proves the artifact runs)')
  .option('--full', 'Also run the expensive integration / deploy-dev tiers')
  .option('--gates <ids>', 'Comma-separated rung-id subset (e.g. build,test,execution)')
  .option('--timeout <ms>', 'Per-rung timeout override in milliseconds')
  .option('--acceptance <specfile>', 'Judge behavioral completeness against a spec file (LLM acceptance gate; --strict to gate on it)')
  .option('--acceptance-auto', 'DONE-gate mode: judge requirements-completeness against an auto-discovered spec (.uap/acceptance.md → REQUIREMENTS.md → the completion-ledger/TodoWrite plan); fails open if no spec/model, blocks under max/strict fidelity')
  .option('--no-visual', 'Skip the visual gate (renders entry pages headlessly, checks blank/static/errors, saves screenshots to .uap/visual)')
  .option('--approve-visual', 'Approve the current render as the visual regression baseline (.uap/visual/baseline) instead of gating on drift')
  .option('--user-paths', 'Run the user-path validation gate: execute .uap/user-paths.json journeys through the real client (headless browser / HTTP / built CLI)')
  .option('--user-paths-auto', 'Stop-hook mode: run the user-path gate only when delivery.userValidation is on and the last report is missing/stale/failed for the current tree')
  .option('-m, --model <preset>', 'Model preset for the acceptance gate (default: $UAP_DELIVER_MODEL or qwen35-a3b)')
  .option('--endpoint <url>', 'Override the model endpoint for the acceptance gate')
  .option('--json', 'Emit JSON result')
  .action(async (options) => {
    const cmd = await lazy.verify();
    await cmd({
      dir: options.dir,
      strict: Boolean(options.strict),
      runtimeOnly: Boolean(options.runtimeOnly),
      full: Boolean(options.full),
      gates: options.gates,
      json: Boolean(options.json),
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
      acceptanceFile: options.acceptance,
      acceptanceAuto: Boolean(options.acceptanceAuto),
      model: options.model,
      endpoint: options.endpoint,
      visual: options.visual,
      approveVisual: Boolean(options.approveVisual),
      userPaths: Boolean(options.userPaths),
      userPathsAuto: Boolean(options.userPathsAuto),
    });
  });

program
  .command('fidelity')
  .description('Inspect or set the maximum-fidelity verification mode (raised gates + always-on visual/vision review)')
  .argument('[action]', 'max | standard (omit to show status)')
  .option('--json', 'Emit JSON')
  .action(async (action, options) => {
    const cmd = await lazy.fidelity();
    await cmd(action, { json: Boolean(options.json) });
  });

program
  .command('plan')
  .description('Validate + record plan validation (validate-plan-on-change gate): `uap plan validate [file]` reviews the plan, then stamps')
  .argument('[action]', 'validate | status (omit to show status)')
  .argument('[file]', 'plan artifact to review (validate only; default: newest plan-like .md)')
  .option('--json', 'Emit JSON')
  .option('--no-review', 'Skip the model review (stamp only)')
  .option('--force', 'Stamp even when the review verdict is fail (justify in the PR)')
  .action(async (action, file, options) => {
    const cmd = await lazy.plan();
    await cmd(action, { json: Boolean(options.json), file, review: options.review, force: Boolean(options.force) });
  });

// Paired UAP benchmark — controlled UAP-on vs UAP-off A/B
const bench = program
  .command('bench')
  .description('Benchmark UAP impact with a controlled paired (UAP-on vs UAP-off) experiment');
bench
  .command('paired')
  .description('Run the paired A/B over a real-gate suite; reports accuracy + efficiency deltas with CIs')
  .option('--suite <dir>', 'Task suite directory (default: benchmarks/suites/real-gate)')
  .option('--adapter <name>', 'Agent adapter: mock | opencode | claude | mini | raw | deliver', 'mock')
  .option('-m, --model <id>', 'Model id passed to the adapter (default: $UAP_BENCH_MODEL or qwen35-a3b)')
  .option('--epochs <n>', 'Paired seeds per (task, condition) — research recommends >=5', '5')
  .option('--concurrency <n>', 'Max concurrent runs', '4')
  .option('--ablation', 'Run the leave-one-out component ablation matrix instead of baseline-vs-full')
  .option('--lazy', 'Add a uap-lazy condition: bare first attempt, UAP engages only on gate failure')
  .option('--seed <n>', 'RNG seed for bootstrap/permutation (reproducible reports)', '1')
  .option('--iterations <n>', 'Bootstrap/permutation iterations', '10000')
  .option('--rope-margin <x>', 'Practical-equivalence margin: a correctness delta within ±x (success-rate units) is a TIE, not a win', '0')
  .option('--out <dir>', 'Artifact output directory (default: benchmark-results/paired-<ts>)')
  .option('--json', 'Emit JSON to stdout instead of the Markdown report')
  .action(async (options) => {
    const cmd = await lazy.benchPaired();
    await cmd(options);
  });

// HALO harness-optimization commands
const harness = program
  .command('harness')
  .description('HALO harness optimization: analyze execution traces for systemic failures');
harness
  .command('analyze')
  .description('Run the HALO engine over collected traces (wraps the `halo` CLI)')
  .option('-t, --traces <file>', 'Trace JSONL file (default: $UAP_HALO_TRACE_PATH or .uap/halo/traces.jsonl)')
  .option('-p, --prompt <prompt>', 'Question to ask HALO about the traces')
  .option('--json', 'Request JSON output from HALO')
  .action(async (options) => {
    const cmd = await lazy.harness();
    await cmd('analyze', options);
  });
harness
  .command('status')
  .description('Show HALO trace collection state (enabled, path, span count)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.harness();
    await cmd('status', options);
  });

// Self-Harness — self-improving harness (arXiv:2606.09498)
const selfHarness = program
  .command('self-harness')
  .description('Self-improving harness: mine model-specific failures and propose harness modifications');
selfHarness
  .command('analyze')
  .description('Mine weaknesses from a paired-bench records.jsonl and propose candidate Mods (read-only)')
  .option('--records <path>', 'Paired-bench output dir or records.jsonl to mine')
  .option('--env <path>', 'Env file for the current harness profile (default ~/.config/uap/llama-server.env)')
  .option('--transfer <path>', 'Cross-model transfer store to seed proposals from (default ~/.uap/self-harness/transfer.json)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('analyze', options);
  });
selfHarness
  .command('run')
  .description('Autonomous loop: mine -> propose -> validate (real paired bench per Mod) -> decide -> (with --apply) commit + versioned snapshot')
  .option('--records <path>', 'Baseline paired-bench output dir or records.jsonl to mine')
  .option('--suite <dir>', 'Validation task suite (required)')
  .option('--heldout <dir>', 'Held-out regression suite (disjoint tasks)')
  .option('--env <path>', 'Env file for the current harness profile (default ~/.config/uap/llama-server.env)')
  .option('--adapter <name>', 'Agent adapter: mock | opencode | claude | mini | raw | deliver (default mock)')
  .option('--model <id>', 'Model id (default: inferred from records)')
  .option('--epochs <n>', 'Paired seeds per (task, arm) (default 5)')
  .option('--concurrency <n>', 'Max concurrent cells (default 4)')
  .option('--max-candidates <n>', 'Max candidate Mods to validate this iteration (default 3)')
  .option('--seed <n>', 'Paired-statistics seed (default 1)')
  .option('--transfer <path>', 'Cross-model transfer store to seed proposals from')
  .option('--snapshot <path>', 'Versioned profile snapshot path (default ~/.uap/self-harness/profile.json)')
  .option('--history <path>', 'History JSONL path (default ~/.uap/self-harness/history.jsonl)')
  .option('--restart-cmd <cmd>', 'Shell command to restart the inference server after committing env Mods (--apply only)')
  .option('--apply', 'Physically commit accepted env Mods + restart + persist snapshot (default: dry-run)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('run', options);
  });
selfHarness
  .command('transfer')
  .description('List the cross-model transfer store (accepted/rejected Mods keyed by failure signature)')
  .option('--transfer <path>', 'Transfer store path (default ~/.uap/self-harness/transfer.json)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('transfer', options);
  });
selfHarness
  .command('mine-prod')
  .description('Mine weaknesses from production traces (HALO + proxy log) and ENQUEUE proposals for gated validation (never applies)')
  .option('--traces <path>', 'HALO traces.jsonl (default ~/.uap/halo/traces.jsonl)')
  .option('--unit <name>', 'Proxy journal unit to mine, e.g. uap-anthropic-proxy.service')
  .option('--since <when>', 'journalctl --since window for proxy-log mining (default "24 hours ago")')
  .option('--model <id>', 'Model family stamp (default qwen36-35b-a3b-iq4xs)')
  .option('--transfer <path>', 'Transfer store to seed proposals from')
  .option('--pending <path>', 'Pending queue path (default ~/.uap/self-harness/pending.json)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('mine-prod', options);
  });
selfHarness
  .command('pending')
  .description('List queued proposals awaiting validation + gate (from mine-prod)')
  .option('--pending <path>', 'Pending queue path (default ~/.uap/self-harness/pending.json)')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('pending', options);
  });
selfHarness
  .command('prune')
  .description('Ablation-prune: drop stale / no-longer-paying-off transfer + pending entries')
  .option('--transfer <path>', 'Transfer store path')
  .option('--pending <path>', 'Pending queue path')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (options) => {
    const cmd = await lazy.selfHarness();
    await cmd('prune', options);
  });

// LLM Self-Tuning — raise a small model toward Opus by tuning UAP flags with a
// benchmark-validated, LLM-guided (or GP-BO) closed loop.
function addTuneOptions(cmd: import('commander').Command): import('commander').Command {
  return cmd
    .option('--model <id>', 'Executor model family to tune (default qwen36-a3b)')
    .option('--suite <dir>', 'Real-gate task suite (default benchmarks/suites/real-gate)')
    .option('--adapter <name>', 'Agent adapter: mock | opencode | claude | mini | raw | deliver (default mock)')
    .option('--judge <id>', 'Judge/tuner model id (else recipes.judge.model, else GP-only)')
    .option('--epochs <n>', 'Paired seeds per (task, arm) (default 5)')
    .option('--concurrency <n>', 'Max concurrent cells (default 4)')
    .option('--max-iterations <n>', 'Max tuning-loop iterations (default 6)')
    .option('--phase <name>', 'Force one search phase: coarse | medium | fine | combinatorial')
    .option('--iterations <n>', 'Bootstrap/permutation iterations for the paired stats (default 10000)')
    .option('--seed <n>', 'RNG/statistics seed (default 1)')
    .option('--apply', 'Commit accepted configs to .uap.json / proxy.env + save the profile (default: dry-run)')
    .option('--json', 'Emit JSON instead of a human-readable report');
}
addTuneOptions(
  program
    .command('tune')
    .description('Self-tune UAP flags to raise a small model toward Opus (propose -> validate -> decide -> learn)'),
).action(async (options) => {
  const cmd = await lazy.tune();
  await cmd(options);
});
addTuneOptions(
  selfHarness
    .command('tune')
    .description('Alias of `uap tune`: the LLM/GP flag self-tuning loop'),
).action(async (options) => {
  const cmd = await lazy.tune();
  await cmd(options);
});

// Open-collider divergent-ideation commands
const ideate = program
  .command('ideate')
  .description('Divergent ideation (open-collider): generate non-trivial ideas for hard problems');
ideate
  .command('setup')
  .description('Scaffold an ideation project under projects/<name>/')
  .argument('<name>', 'Project name')
  .option('--force', 'Overwrite an existing project')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (name: string, options) => {
    const cmd = await lazy.ideate();
    await cmd('setup', name, options);
  });
ideate
  .command('run')
  .description('Drive the brainstorm flow for a project (Skill mode is free)')
  .argument('<name>', 'Project name')
  .action(async (name: string, options) => {
    const cmd = await lazy.ideate();
    await cmd('run', name, options);
  });
ideate
  .command('ideas')
  .description('Print the curated ideas produced for a project')
  .argument('<name>', 'Project name')
  .option('--json', 'Emit JSON instead of a human-readable report')
  .action(async (name: string, options) => {
    const cmd = await lazy.ideate();
    await cmd('ideas', name, options);
  });

// Agent Coordination Commands
program
  .command('coord')
  .description('Agent coordination and status')
  .addCommand(
    new Command('status')
      .description('Show coordination status (agents, claims, deploys)')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.coord())('status', options);
      })
  )
  .addCommand(
    new Command('flush')
      .description('Force execute all pending deploys')
      .action(async (options) => {
        (await lazy.coord())('flush', options);
      })
  )
  .addCommand(
    new Command('cleanup')
      .description('Clean up stale agents and expired data')
      .action(async (options) => {
        (await lazy.coord())('cleanup', options);
      })
  )
  .addCommand(
    new Command('post')
      .description('Post a message to the shared collaboration board')
      .argument('<text>', 'Message text')
      .option('-k, --kind <kind>', 'note | finding | dead-end | flag | handoff | norm', 'note')
      .option('--agent <id>', 'Posting agent id (default: $UAP_AGENT_ID)')
      .action(async (text, options) => {
        (await lazy.coord())('post', { ...options, text });
      })
  )
  .addCommand(
    new Command('dead-end')
      .description('Record a tried-and-failed approach so peers don\'t repeat it')
      .argument('<text>', 'What was tried and why it failed')
      .option('--agent <id>', 'Posting agent id (default: $UAP_AGENT_ID)')
      .action(async (text, options) => {
        (await lazy.coord())('dead-end', { ...options, text });
      })
  )
  .addCommand(
    new Command('board')
      .description('Read the shared collaboration board (peer findings, dead-ends, flags)')
      .option('-n, --limit <n>', 'Max posts (default 15)')
      .option('--since <minutes>', 'Only posts newer than N minutes')
      .option('-k, --kind <kind>', 'Filter by kind')
      .option('--json', 'Emit JSON')
      .action(async (options) => {
        (await lazy.coord())('board', options);
      })
  )
  .addCommand(
    new Command('finding')
      .description('Findings ledger: propose | confirm | reverse | list tracked claims')
      .argument('<action>', 'propose | confirm | reverse | list')
      .argument('[value]', 'claim text (propose) or finding id (confirm/reverse)')
      .option('--evidence <text>', 'Supporting evidence (propose)')
      .option('--supersedes <id>', 'This finding supersedes/reverses finding #id (lineage)')
      .option('--resolution <text>', 'Ruling text (confirm/reverse)')
      .option('--status <status>', 'Filter list by proposed|confirmed|reversed|disputed')
      .option('-n, --limit <n>', 'Max rows (list)')
      .option('--agent <id>', 'Acting agent id')
      .option('--json', 'Emit JSON (list)')
      .action(async (action, value, options) => {
        const opts: Record<string, unknown> = { ...options, sub: action };
        if (action === 'propose') opts.text = value;
        else opts.id = value;
        (await lazy.coord())('finding', opts);
      })
  )
  .addCommand(
    new Command('flag')
      .description('Raise an integrity flag on a finding for peer/human ruling (disputes it)')
      .argument('<id>', 'Finding id to flag')
      .requiredOption('--reason <text>', 'Why the claim is suspect')
      .option('--agent <id>', 'Acting agent id')
      .action(async (id, options) => {
        (await lazy.coord())('flag', { ...options, id });
      })
  )
  .addCommand(
    new Command('stage')
      .description('Stage an artifact + acceptance spec for any capable agent (relay/quota pool); "list" to view')
      .argument('<title>', 'Work title, or "list" to view the staged pool')
      .option('--artifact <ref>', 'Path/ref to the staged artifact')
      .option('--acceptance <spec>', 'How a picker verifies it is done')
      .option('--needs <cap>', 'Capability/resource the picker needs (e.g. gpu, quota, deploy)')
      .option('--status <status>', 'Filter list: staged|claimed|completed|abandoned')
      .option('-n, --limit <n>', 'Max rows (list)')
      .option('--agent <id>', 'Acting agent id')
      .option('--json', 'Emit JSON (list)')
      .action(async (title, options) => {
        (await lazy.coord())('stage', { ...options, text: title });
      })
  )
  .addCommand(
    new Command('claim')
      .description('Claim a staged item to run it (atomic; fails if already taken)')
      .argument('<id>', 'Staged work id')
      .option('--agent <id>', 'Acting agent id')
      .action(async (id, options) => {
        (await lazy.coord())('claim', { ...options, id });
      })
  )
  .addCommand(
    new Command('complete')
      .description('Mark staged work complete and credit the originator on the board')
      .argument('<id>', 'Staged work id')
      .option('--result <text>', 'Outcome / result summary')
      .option('--agent <id>', 'Acting agent id')
      .action(async (id, options) => {
        (await lazy.coord())('complete', { ...options, id });
      })
  )
  .addCommand(
    new Command('collaboration')
      .description('Get/set collaboration auto-activation (auto|always|off|status)')
      .argument('[mode]', 'auto | always | off | status', 'status')
      .action(async (mode, options) => {
        (await lazy.coord())('collaboration', { ...options, sub: mode });
      })
  )
  .addCommand(
    new Command('slots')
      .description('Show the model-slot concurrency budget (probes the inference endpoint)')
      .option('--json', 'Emit JSON')
      .action(async (options) => {
        (await lazy.coord())('slots', options);
      })
  )
  .addCommand(
    new Command('ownership')
      .description('Show path-ownership lanes, or which lanes given paths fall into')
      .argument('[paths...]', 'Paths to resolve to lanes')
      .action(async (paths: string[]) => {
        (await lazy.coord())('ownership', { text: (paths || []).join(' ') });
      })
  );



program
  .command('agent')
  .description('Agent lifecycle, work coordination, and communication')
  .addCommand(
    new Command('register')
      .description('Register a new agent (each agent works in isolated worktree)')
      .option('-n, --name <name>', 'Agent name (required)')
      .option('-i, --id <id>', 'Stable agent ID (optional; generated if omitted). Use a known ID so other agents can address this one directly.')
      .option('-c, --capabilities <caps>', 'Comma-separated capabilities')
      .option('-w, --worktree <branch>', 'Git worktree branch this agent is using')
      .action(async (options) => {
        (await lazy.agent())('register', options);
      })
  )
  .addCommand(
    new Command('heartbeat')
      .description('Send heartbeat for an agent')
      .option('-i, --id <id>', 'Agent ID (required)')
      .action(async (options) => {
        (await lazy.agent())('heartbeat', options);
      })
  )
  .addCommand(
    new Command('status')
      .description('Show agent status')
      .option('-i, --id <id>', 'Agent ID (optional, shows all if omitted)')
      .action(async (options) => {
        (await lazy.agent())('status', options);
      })
  )
  .addCommand(
    new Command('announce')
      .description(
        'Announce intent to work on a resource (informational, enables overlap detection)'
      )
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-r, --resource <resource>', 'Resource path (file/directory) to work on')
      .option(
        '--intent <intent>',
        'Work intent: editing, reviewing, refactoring, testing, documenting'
      )
      .option('-d, --description <desc>', 'Description of planned changes')
      .option('-f, --files <files>', 'Comma-separated list of files that will be affected')
      .option('--minutes <minutes>', 'Estimated time to complete (in minutes)')
      .action(async (options) => {
        (await lazy.agent())('announce', options);
      })
  )
  .addCommand(
    new Command('complete')
      .description('Mark work as complete on a resource (notifies other agents)')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-r, --resource <resource>', 'Resource that work is complete on')
      .action(async (options) => {
        (await lazy.agent())('complete', options);
      })
  )
  .addCommand(
    new Command('overlaps')
      .description('Check for overlapping work (merge conflict risk assessment)')
      .option('-r, --resource <resource>', 'Resource to check (omit to show all active work)')
      .action(async (options) => {
        (await lazy.agent())('overlaps', options);
      })
  )
  .addCommand(
    new Command('broadcast')
      .description('Broadcast a message to all agents')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-c, --channel <channel>', 'Channel: broadcast, deploy, review, coordination')
      .option('-m, --message <message>', 'Message payload (JSON or string)')
      .option('-p, --priority <priority>', 'Priority 1-10', '5')
      .action(async (options) => {
        (await lazy.agent())('broadcast', options);
      })
  )
  .addCommand(
    new Command('send')
      .description('Send a direct message to another agent')
      .option('-i, --id <id>', 'Sender agent ID (required)')
      .option('-t, --to <to>', 'Recipient agent ID (required)')
      .option('-m, --message <message>', 'Message payload (JSON or string)')
      .option('-p, --priority <priority>', 'Priority 1-10', '5')
      .action(async (options) => {
        (await lazy.agent())('send', options);
      })
  )
  .addCommand(
    new Command('receive')
      .description('Receive pending messages')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-c, --channel <channel>', 'Filter by channel')
      .option('--no-mark-read', 'Do not mark messages as read')
      .action(async (options) => {
        (await lazy.agent())('receive', options);
      })
  )
  .addCommand(
    new Command('deregister')
      .description('Deregister an agent')
      .option('-i, --id <id>', 'Agent ID (required)')
      .action(async (options) => {
        (await lazy.agent())('deregister', options);
      })
  );

program
  .command('deploy')
  .description('Deployment batching and execution')
  .addCommand(
    new Command('queue')
      .description('Queue a deploy action for batching')
      .option('-a, --agent-id <id>', 'Agent ID (required)')
      .option('-t, --action-type <type>', 'Action type: commit, push, merge, deploy, workflow')
      .option('--target <target>', 'Target (branch, environment, workflow name)')
      .option('-m, --message <message>', 'Commit message (for commit action)')
      .option('-f, --files <files>', 'Comma-separated files (for commit action)')
      .option('-r, --remote <remote>', 'Git remote (for push action)', 'origin')
      .option('--force', 'Force push (for push action)')
      .option('--ref <ref>', 'Git ref (for workflow action)')
      .option('--inputs <inputs>', 'Workflow inputs as JSON (for workflow action)')
      .option('-p, --priority <priority>', 'Priority 1-10', '5')
      .action(async (options) => {
        (await lazy.deploy())('queue', options);
      })
  )
  .addCommand(
    new Command('batch')
      .description('Create a batch from pending deploy actions')
      .option('-v, --verbose', 'Show detailed batch info')
      .action(async (options) => {
        (await lazy.deploy())('batch', options);
      })
  )
  .addCommand(
    new Command('execute')
      .description('Execute a deploy batch')
      .option('-b, --batch-id <id>', 'Batch ID (required)')
      .option('--dry-run', 'Show what would be executed without running')
      .action(async (options) => {
        (await lazy.deploy())('execute', options);
      })
  )
  .addCommand(
    new Command('status')
      .description('Show deploy queue status')
      .option('-v, --verbose', 'Show detailed status')
      .action(async (options) => {
        (await lazy.deploy())('status', options);
      })
  )
  .addCommand(
    new Command('flush')
      .description('Flush all pending deploys (batch and execute)')
      .option('-v, --verbose', 'Show detailed results')
      .option('--dry-run', 'Show what would be executed without running')
      .action(async (options) => {
        (await lazy.deploy())('flush', options);
      })
  )
  .addCommand(
    new Command('config')
      .description('Show deploy batch configuration (window settings)')
      .action(async (options) => {
        (await lazy.deploy())('config', options);
      })
  )
  .addCommand(
    new Command('set-config')
      .description('Set deploy batch configuration (window settings)')
      .option(
        '--message <json>',
        'JSON object with window settings, e.g. {"commit":60000,"push":3000}'
      )
      .action(async (options) => {
        (await lazy.deploy())('set-config', options);
      })
  )
  .addCommand(
    new Command('urgent')
      .description('Enable or disable urgent mode (fast batch windows)')
      .option('--on', 'Enable urgent mode')
      .option('--off', 'Disable urgent mode (default)')
      .action(async (options) => {
        (await lazy.deploy())('urgent', { force: options.on, remote: options.off });
      })
  );

// Task Management
program
  .command('task')
  .description('Task management (superior alternative to Beads)')
  .addCommand(
    new Command('create')
      .description('Create a new task')
      .option('-t, --title <title>', 'Task title (required)')
      .option('-d, --description <desc>', 'Task description')
      .option('--type <type>', 'Type: task, bug, feature, epic, chore, story', 'task')
      .option('-p, --priority <priority>', 'Priority: 0-4 (P0=critical, P4=backlog)', '2')
      .option('-l, --labels <labels>', 'Comma-separated labels')
      .option('--parent <parent>', 'Parent task ID (for hierarchy)')
      .option('-n, --notes <notes>', 'Markdown notes')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('create', options);
      })
  )
  .addCommand(
    new Command('list')
      .description('List tasks')
      .option('-s, --filter-status <status>', 'Filter by status (comma-separated)')
      .option('--status <status>', 'Alias for --filter-status')
      .option('--filter-type <type>', 'Filter by type (comma-separated)')
      .option('--filter-priority <priority>', 'Filter by priority (comma-separated)')
      .option('-a, --filter-assignee <assignee>', 'Filter by assignee')
      .option('-l, --filter-labels <labels>', 'Filter by labels (comma-separated)')
      .option('--search <search>', 'Search in title/description')
      .option('--show-blocked', 'Show only blocked tasks')
      .option('--show-ready', 'Show only ready tasks')
      .option('-v, --verbose', 'Show more details')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        const filterStatus = options.filterStatus ?? options.status;
        (await lazy.task())('list', { ...options, filterStatus });
      })
  )
  .addCommand(
    new Command('show')
      .description('Show task details')
      .argument('<id>', 'Task ID')
      .option('-v, --verbose', 'Show history')
      .option('--json', 'Output as JSON')
      .action(async (id, options) => {
        (await lazy.task())('show', { id, ...options });
      })
  )
  .addCommand(
    new Command('update')
      .description('Update a task')
      .argument('<id>', 'Task ID')
      .option('-t, --title <title>', 'New title')
      .option('-d, --description <desc>', 'New description')
      .option('--type <type>', 'New type')
      .option('-s, --status <status>', 'New status: open, in_progress, blocked, done, wont_do')
      .option('-p, --priority <priority>', 'New priority (0-4)')
      .option('-a, --assignee <assignee>', 'Assign to agent (use "none" to unassign)')
      .option('-w, --worktree <worktree>', 'Set worktree branch')
      .option('-l, --labels <labels>', 'New labels (comma-separated)')
      .option('-n, --notes <notes>', 'New notes')
      .action(async (id, options) => {
        (await lazy.task())('update', { id, ...options });
      })
  )
  .addCommand(
    new Command('close')
      .description('Close a task (mark as done)')
      .argument('<id>', 'Task ID')
      .option('-r, --reason <reason>', 'Closure reason')
      .action(async (id, options) => {
        (await lazy.task())('close', { id, ...options });
      })
  )
  .addCommand(
    new Command('delete')
      .description('Delete a task')
      .argument('<id>', 'Task ID')
      .action(async (id) => {
        (await lazy.task())('delete', { id });
      })
  )
  .addCommand(
    new Command('ready')
      .description('List tasks ready to work on (no blockers)')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('ready', options);
      })
  )
  .addCommand(
    new Command('blocked')
      .description('List blocked tasks')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('blocked', options);
      })
  )
  .addCommand(
    new Command('dep')
      .description('Add a dependency between tasks')
      .option('-f, --from <from>', 'Dependent task (the task that is blocked)')
      .option('-t, --to <to>', 'Blocking task (the task that must complete first)')
      .option('--dep-type <type>', 'Dependency type: blocks, related, discovered_from', 'blocks')
      .action(async (options) => {
        (await lazy.task())('dep', options);
      })
  )
  .addCommand(
    new Command('undep')
      .description('Remove a dependency between tasks')
      .option('-f, --from <from>', 'Dependent task')
      .option('-t, --to <to>', 'Blocking task')
      .action(async (options) => {
        (await lazy.task())('undep', options);
      })
  )
  .addCommand(
    new Command('claim')
      .description('Claim a task (assign + announce work + create worktree)')
      .argument('<id>', 'Task ID')
      .option('-b, --branch <branch>', 'Worktree branch name')
      .action(async (id, options) => {
        (await lazy.task())('claim', { id, ...options });
      })
  )
  .addCommand(
    new Command('release')
      .description('Release a task (mark complete + announce)')
      .argument('<id>', 'Task ID')
      .option('-r, --reason <reason>', 'Completion reason')
      .action(async (id, options) => {
        (await lazy.task())('release', { id, ...options });
      })
  )
  .addCommand(
    new Command('stats')
      .description('Show task statistics')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('stats', options);
      })
  )
  .addCommand(
    new Command('board')
      .description('Show tasks as a kanban board')
      .action(async (options) => {
        (await lazy.task())('board', options);
      })
  )
  .addCommand(
    new Command('sync')
      .description('Sync tasks with JSONL file (for git versioning)')
      .action(async (options) => {
        (await lazy.task())('sync', options);
      })
  )
  .addCommand(
    new Command('compact')
      .description('Compact old closed tasks into summaries')
      .option('--days <days>', 'Compact tasks older than N days', '90')
      .action(async (options) => {
        (await lazy.task())('compact', options);
      })
  )
  .addCommand(
    new Command('reap')
      .description('Revert stale in_progress tasks (untouched > N days) back to open')
      .option('--days <days>', 'Staleness threshold in days', '14')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('reap', options);
      })
  )
  .addCommand(
    new Command('sync-beads')
      .description('Import/refresh issues from a legacy .beads tracker into the task DB (idempotent)')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.task())('sync-beads', options);
      })
  );

// Compliance - protocol verification and auto-fix
program
  .command('compliance')
  .description('UAP protocol compliance checking, auditing, and auto-fix')
  .addCommand(
    new Command('check')
      .description('Run compliance check (schema, memory, Qdrant, worktrees, secrets)')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.compliance())('check', options);
      })
  )
  .addCommand(
    new Command('report')
      .description('Generate detailed compliance report')
      .option('-o, --output <path>', 'Output file path')
      .option('-f, --format <format>', 'Format: text, markdown, json', 'text')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.compliance())('report', options);
      })
  )
  .addCommand(
    new Command('audit')
      .description('Deep compliance audit with verbose output')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.compliance())('audit', options);
      })
  )
  .addCommand(
    new Command('fix')
      .description(
        'Auto-fix compliance issues (schema migrations, Qdrant collections, worktree cleanup)'
      )
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.compliance())('fix', options);
      })
  );

program
  .command('coordination')
  .description('Coordination overlap checks and resolution')
  .addCommand(
    new Command('check')
      .description('Check for overlapping work between agents')
      .option('--agents <agents>', 'Comma-separated agent ids or names')
      .option('-r, --resource <resource>', 'Resource to check')
      .option('-v, --verbose', 'Show detailed overlap analysis')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.coord())('check', options);
      })
  )
  .addCommand(
    new Command('resolve')
      .description('Resolve identified overlaps')
      .argument('<overlapId>', 'Overlap identifier (resource path)')
      .option('--action <action>', 'Resolution action: assign, merge, delegate')
      .option('--json', 'Output as JSON')
      .action(async (overlapId, options) => {
        (await lazy.coord())('resolve', { overlapId, ...options });
      })
  );

program
  .command('skill')
  .description('Skill management and loading')
  .addCommand(
    new Command('list')
      .description('List available skills')
      .option('-c, --category <category>', 'Filter by category')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.skill())('list', options);
      })
  )
  .addCommand(
    new Command('load')
      .description('Load a specific skill for current session')
      .argument('<skill>', 'Skill name')
      .option('-c, --category <category>', 'Filter by category')
      .action(async (skill, options) => {
        (await lazy.skill())('load', { skill, ...options });
      })
  );

program
  .command('update')
  .description('Update CLAUDE.md, memory system, and all related components')
  .option('--dry-run', 'Show what would be updated without making changes')
  .option('--skip-memory', 'Skip memory system updates')
  .option('--skip-qdrant', 'Skip Qdrant collection updates')
  .option(
    '--pipeline-only',
    'Enforce pipeline-only infrastructure changes (no direct kubectl/terraform)'
  )
  .option('-v, --verbose', 'Show detailed update information')
  .action(async (options) => {
    const { updateCommand } = await import('../cli/update.js');
    await updateCommand(options);
  });

// Dashboard - rich data visualisation and progress tracking
program
  .command('dashboard')
  .alias('dash')
  .description('Rich data visualisation dashboard for tasks, agents, memory, and progress')
  .addCommand(
    new Command('overview')
      .description('Full system overview with charts and progress bars')
      .option('-v, --verbose', 'Show detailed information')
      .option('--compact', 'Compact output for narrow terminals')
      .action(async (options) => {
        (await lazy.dashboard())('overview', options);
      })
  )
  .addCommand(
    new Command('tasks')
      .description('Task breakdown with charts, progress bars, and hierarchy trees')
      .option('-v, --verbose', 'Show detailed information')
      .option('--compact', 'Compact output')
      .action(async (options) => {
        (await lazy.dashboard())('tasks', options);
      })
  )
  .addCommand(
    new Command('agents')
      .description('Agent activity, resource claims, and coordination status')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('agents', options);
      })
  )
  .addCommand(
    new Command('memory')
      .description('Memory system health, capacity, and layer architecture')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('memory', options);
      })
  )
  .addCommand(
    new Command('progress')
      .description('Completion tracking with per-priority and per-type progress')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('progress', options);
      })
  )
  .addCommand(
    new Command('serve')
      .description('Start web-based dashboard server with real-time updates')
      .option('-p, --port <number>', 'Port to listen on (default: 3847)', '3847')
      .option('--host <host>', 'Interface to bind (default: localhost; use 0.0.0.0 for LAN/remote access)', 'localhost')
      .option(
        '--refresh <seconds>',
        'Live snapshot push/poll interval in seconds (min 0.25; default 2, or UAP_DASH_REFRESH_MS)'
      )
      .action(async (options) => {
        (await lazy.dashboard())('serve', {
          port: parseInt(options.port),
          host: options.host,
          refresh: options.refresh,
        });
      })
  )
  .addCommand(
    new Command('stats')
      .description('Session context consumption stats with per-tool breakdown')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('stats', options);
      })
  )
  .addCommand(
    new Command('session')
      .description('Live UAP session state: infrastructure, patterns, skills, git, policies')
      .option('-v, --verbose', 'Show detailed information')
      .option('--compact', 'Compact summary box (for post-task / pre-compact)')
      .action(async (options) => {
        (await lazy.dashboard())('session', options);
      })
  )
  .addCommand(
    new Command('benchmark')
      .description('Benchmark results and performance comparison dashboard')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('benchmark', options);
      })
  )
  .addCommand(
    new Command('policies')
      .description('Policy enforcement status and compliance dashboard')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('policies', options);
      })
  )
  .addCommand(
    new Command('models')
      .description('Multi-model architecture status and routing analytics')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('models', options);
      })
  )
  .addCommand(
    new Command('export')
      .description('Export dashboard data as JSON for external analysis')
      .option('-o, --output <path>', 'Output file path')
      .action(async (options) => {
        (await lazy.dashboard())('export', options);
      })
  )
  .addCommand(
    new Command('history')
      .description('Session history and trend analysis')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        (await lazy.dashboard())('history', options);
      })
  );

// Multi-Model Architecture commands - visible in --help, loaded on demand
{
  const modelCmd = program
    .command('model')
    .description(
      'Multi-model architecture management (status, route, plan, compare, presets, select, export, health)'
    )
    // The real subcommands (with their own options like --save) are lazily
    // registered inside the action below, then argv is re-parsed. Allow unknown
    // options/args through the FIRST parse so they survive to the re-parse.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async () => {
      // Re-register with full subcommands and re-parse
      const cmds = program.commands as unknown as Command[];
      const idx = cmds.findIndex((c) => c.name() === 'model');
      if (idx >= 0) cmds.splice(idx, 1);
      const registerModelFn = await lazy.model();
      registerModelFn(program);
      await program.parseAsync(process.argv);
    });
  // Show help for model subcommands when invoked without action
  modelCmd.addHelpText('after', '\n  Run `uap model <subcommand>` for details.');
}

// MCP Router - Lightweight hierarchical router for 98%+ token reduction
program
  .command('mcp-router')
  .description('MCP Router - hierarchical router for 98%+ token reduction')
  .addCommand(
    new Command('start')
      .description('Start the MCP router as a stdio server')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('-v, --verbose', 'Enable verbose logging')
      .action(async (options) => {
        (await lazy.mcpRouter())('start', options);
      })
  )
  .addCommand(
    new Command('stats')
      .description('Show router statistics (servers, tools, token savings)')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('-v, --verbose', 'Enable verbose logging')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.mcpRouter())('stats', options);
      })
  )
  .addCommand(
    new Command('discover')
      .description('Discover tools matching a query')
      .option('-q, --query <query>', 'Search query (required)')
      .option('-s, --server <server>', 'Filter to specific server')
      .option('-l, --limit <limit>', 'Max results', '10')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('-v, --verbose', 'Enable verbose logging')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.mcpRouter())('discover', options);
      })
  )
  .addCommand(
    new Command('list')
      .description('List configured MCP servers')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('--json', 'Output as JSON')
      .action(async (options) => {
        (await lazy.mcpRouter())('list', options);
      })
  );

// Session Hooks - automatic memory injection and pre-compaction flush
program
  .command('hooks')
  .description(
    'Manage session hooks for Claude Code, Factory.AI, Cursor, VSCode, OpenCode, Codex, ForgeCode, Oh-My-Pi, Hermes'
  )
  .addCommand(
    new Command('install')
      .description('Install UAP session hooks')
      .option(
        '-t, --target <target>',
        'Target platform: claude, factory, cursor, vscode, opencode, codex, forgecode, omp, hermes (default: all)'
      )
      .option(
        '-p, --platform <platform>',
        'Alias for --target (claude, factory, cursor, vscode, opencode, codex, forgecode, omp, hermes)'
      )
      .action((options) =>
        lazy
          .hooks()
          .then((m) =>
            m.hooksCommand('install', {
              target: (options.target ?? options.platform) as HooksTarget | undefined,
            })
          )
      )
  )
  .addCommand(
    new Command('status')
      .description('Show hooks installation status')
      .option(
        '-t, --target <target>',
        'Target platform: claude, factory, cursor, vscode, opencode, codex, forgecode, omp, hermes (default: all)'
      )
      .option(
        '-p, --platform <platform>',
        'Alias for --target (claude, factory, cursor, vscode, opencode, codex, forgecode, omp, hermes)'
      )
      .action((options) =>
        lazy
          .hooks()
          .then((m) =>
            m.hooksCommand('status', {
              target: (options.target ?? options.platform) as HooksTarget | undefined,
            })
          )
      )
  )
  .addCommand(
    new Command('doctor')
      .description('Audit policy-gate coverage across platforms (exit non-zero on gaps)')
      .option('-t, --target <target>', 'Audit a single platform (default: all)')
      .option('-p, --platform <platform>', 'Alias for --target')
      .action((options) =>
        lazy
          .hooks()
          .then((m) =>
            m.hooksCommand('doctor', {
              target: (options.target ?? options.platform) as HooksTarget | undefined,
            })
          )
      )
  );

// Qwen3.5 Tool Call Fixes - performance optimizations for tool calling
const toolCallsCmd = new Command('tool-calls');
toolCallsCmd.description('Manage Qwen3.5 tool call fixes and chat templates');
toolCallsCmd.addCommand(
  new Command('setup').description('Install chat templates and Python scripts').action(async () => {
    (await lazy.toolCalls())('setup');
  })
);
toolCallsCmd.addCommand(
  new Command('test')
    .description('Run reliability test suite')
    .addOption(new Option('--verbose', 'Verbose output'))
    .action(async () => {
      (await lazy.toolCalls())('test');
    })
);
toolCallsCmd.addCommand(
  new Command('status').description('Check current configuration').action(async () => {
    (await lazy.toolCalls())('status');
  })
);
toolCallsCmd.addCommand(
  new Command('fix').description('Apply template fixes to existing templates').action(async () => {
    (await lazy.toolCalls())('fix');
  })
);
program.addCommand(toolCallsCmd);

// RTK (Rust Token Killer) - CLI proxy for 60-90% token savings
const rtkCmd = new Command('rtk');
rtkCmd.description('Manage RTK (Rust Token Killer) integration for token optimization');
rtkCmd.addCommand(
  new Command('install')
    .description('Install RTK CLI proxy for 60-90% token savings')
    .option('--force', 'Force reinstall')
    .option('--method <method>', 'Installation method (npm, cargo, binary)')
    .action(async (options) => {
      const rtk = await lazy.rtk();
      await rtk.installRTK({
        force: !!options.force,
        method: options.method as 'homebrew' | 'cargo' | 'curl',
      });
    })
);
rtkCmd.addCommand(
  new Command('status').description('Check RTK installation and token savings').action(async () => {
    const rtk = await lazy.rtk();
    await rtk.checkRTKStatus();
  })
);
rtkCmd.addCommand(
  new Command('help').description('Show RTK usage information').action(async () => {
    const rtk = await lazy.rtk();
    rtk.showRTKHelp();
  })
);
program.addCommand(rtkCmd);

// MCP Setup - Configure MCP Router for all platforms
program
  .command('mcp-setup')
  .description('Configure MCP Router for all AI harnesses (Claude, Factory, VSCode, Cursor)')
  .option('--force', 'Force replace existing MCP configurations')
  .option('--verbose', 'Enable verbose output')
  .action(async (options) => {
    const fn = await lazy.setupMcpRouter();
    await fn({ force: !!options.force, verbose: !!options.verbose });
  });

// Schema-diff and policy commands - visible in --help, loaded on demand
program
  .command('schema-diff')
  .description('Detect breaking schema changes between branches')
  .option('-b, --base <branch>', 'Base branch/commit to compare against', 'HEAD~1')
  .action(async (_options: { base: string }) => {
    const { registerSchemaDiffCommand } = await import('../cli/schema-diff.js');
    // Remove stub and register real command
    const cmds = program.commands as unknown as Command[];
    const idx = cmds.findIndex((c) => c.name() === 'schema-diff');
    if (idx >= 0) cmds.splice(idx, 1);
    registerSchemaDiffCommand(program);
    await program.parseAsync(process.argv);
  });

{
  // The policy command is lazy-loaded but needs to accept arbitrary sub-flags
  // like `-p <id> -c <file>` without strict validation — otherwise commander
  // rejects them before the action can register the real subcommands.
  const policyCmd = program
    .command('policy')
    .description('UAP policy management (list, install, enable, disable, status, add-tool, check, audit, toggle, stage, level)')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async () => {
      const cmds = program.commands as unknown as Command[];
      const idx = cmds.findIndex((c) => c.name() === 'policy');
      if (idx >= 0) cmds.splice(idx, 1);
      const registerPolicyFn = await lazy.policy();
      registerPolicyFn(program);
      await program.parseAsync(process.argv);
    });
  policyCmd.addHelpText('after', '\n  Run `uap policy <subcommand>` for details.');
}

// `uap config` — inspect, learn, and set every UAP setting from the registry.
registerConfigCommands(program);

// UAP for Oh-My-Pi - dashboard and controls for omp users
const uapOmpCmd = new Command('uap-omp');
uapOmpCmd.description('UAP integration commands for oh-my-pi (omp) users');

// Dashboard command
uapOmpCmd.addCommand(
  new Command('dashboard')
    .description('Show UAP dashboard with tasks, agents, memory, and worktrees')
    .action(async () => {
      try {
        const uapOmpDir = process.env.HOME + '/.uap/omp';
        const dashboardScript = `${uapOmpDir}/commands/uap-dashboard.sh`;
        if (existsSync(dashboardScript)) {
          execSync(`bash "${dashboardScript}"`, { stdio: 'inherit' });
        } else {
          console.error('UAP dashboard not installed. Run: uap-omp install');
        }
      } catch (error: unknown) {
        const err = error as Error;
        console.error('Error showing dashboard:', err.message);
      }
    })
);

// Memory command
uapOmpCmd.addCommand(
  new Command('memory')
    .description('Manage UAP memory for oh-my-pi')
    .addCommand(
      new Command('status').description('Show memory status').action(() => {
        try {
          const uapOmpDir = process.env.HOME + '/.uap/omp';
          const dbPath = `${uapOmpDir}/memory/short_term.db`;
          if (existsSync(dbPath)) {
            execSync(
              `sqlite3 "${dbPath}" "SELECT COUNT(*) as total, COUNT(DISTINCT type) as types FROM memories;"`,
              {
                stdio: 'inherit',
              }
            );
          } else {
            console.log('No memory database found. Run: uap-omp install');
          }
        } catch (error: unknown) {
          const err = error as Error;
          console.error('Error checking memory:', err.message);
        }
      })
    )
    .addCommand(
      new Command('query')
        .description('Query memory for relevant context')
        .argument('<search>', 'Search term')
        .option('-n, --limit <number>', 'Max results', '5')
        .action((search, options) => {
          try {
            const uapOmpDir = process.env.HOME + '/.uap/omp';
            const dbPath = `${uapOmpDir}/memory/short_term.db`;
            if (existsSync(dbPath)) {
              // Sanitize search term to prevent SQL injection
              const sanitizedSearch = search.replace(/'/g, "''");
              const sanitizedLimit = parseInt(options.limit, 10) || 5;
              execSync(
                `sqlite3 "${dbPath}" "SELECT content, type, importance FROM memories WHERE content LIKE '%${sanitizedSearch}%' ORDER BY importance DESC LIMIT ${sanitizedLimit};"`,
                {
                  stdio: 'inherit',
                }
              );
            } else {
              console.log('No memory database found. Run: uap-omp install');
            }
          } catch (error: unknown) {
            const err = error as Error;
            console.error('Error querying memory:', err.message);
          }
        })
    )
);

// Worktree command
uapOmpCmd.addCommand(
  new Command('worktree')
    .description('Manage UAP worktrees for oh-my-pi')
    .addCommand(
      new Command('list').description('List active worktrees').action(() => {
        try {
          const uapOmpDir = process.env.HOME + '/.uap/omp';
          const worktreesFile = `${uapOmpDir}/worktrees.json`;
          if (existsSync(worktreesFile)) {
            execSync(`cat "${worktreesFile}" | jq '.'`, { stdio: 'inherit' });
          } else {
            console.log('No worktrees tracked. Run: uap-omp install');
          }
        } catch (error: unknown) {
          const err = error as Error;
          console.error('Error listing worktrees:', err.message);
        }
      })
    )
    .addCommand(
      new Command('create')
        .description('Create a new worktree')
        .argument('<slug>', 'Worktree slug')
        .action((slug) => {
          try {
            execSync(`uap worktree create ${slug}`, { stdio: 'inherit' });
          } catch (error: unknown) {
            const err = error as Error;
            console.error('Error creating worktree:', err.message);
          }
        })
    )
);

// Hooks command
uapOmpCmd.addCommand(
  new Command('hooks')
    .description('Manage UAP hooks for oh-my-pi')
    .addCommand(
      new Command('install').description('Install UAP hooks for oh-my-pi').action(() => {
        try {
          const scriptPath = join(__dirname, '../../scripts/omp/uap-omp.sh');
          if (existsSync(scriptPath)) {
            execSync(`bash "${scriptPath}" install`, { stdio: 'inherit' });
          } else {
            console.error('UAP hooks script not found. Please rebuild with: npm run build');
          }
        } catch (error: unknown) {
          const err = error as Error;
          console.error('Error installing hooks:', err.message);
        }
      })
    )
    .addCommand(
      new Command('status').description('Show hook installation status').action(() => {
        try {
          const scriptPath = join(__dirname, '../../scripts/omp/uap-omp.sh');
          if (existsSync(scriptPath)) {
            execSync(`bash "${scriptPath}" status`, { stdio: 'inherit' });
          } else {
            console.error('UAP hooks script not found. Please rebuild with: npm run build');
          }
        } catch (error: unknown) {
          const err = error as Error;
          console.error('Error checking hook status:', err.message);
        }
      })
    )
);

program.addCommand(uapOmpCmd);

program.parse();
