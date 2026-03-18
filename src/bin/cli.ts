#!/usr/bin/env node

import { Command, Option } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initCommand } from '../cli/init.js';
import { analyzeCommand } from '../cli/analyze.js';
import { generateCommand } from '../cli/generate.js';
import { memoryCommand } from '../cli/memory.js';
import { worktreeCommand } from '../cli/worktree.js';
import { syncCommand } from '../cli/sync.js';
import { droidsCommand } from '../cli/droids.js';
import { coordCommand } from '../cli/coord.js';
import { agentCommand } from '../cli/agent.js';
import { deployCommand } from '../cli/deploy.js';
import { taskCommand } from '../cli/task.js';
import { registerModelCommands } from '../cli/model.js';
import { mcpRouterCommand } from '../cli/mcp-router.js';
import { dashboardCommand } from '../cli/dashboard.js';
import { hooksCommand, type HooksTarget } from '../cli/hooks.js';
import { patternsCommand } from '../cli/patterns.js';
import { setupCommand } from '../cli/setup.js';
import { setupMcpRouter } from '../cli/setup-mcp-router.js';
import { complianceCommand } from '../cli/compliance.js';
import { registerSchemaDiffCommand } from '../cli/schema-diff.js';
import { installRTK, checkRTKStatus, showRTKHelp } from '../cli/rtk.js';
import { toolCallsCommand } from '../cli/tool-calls.js';

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
  .option('-f, --force', 'Overwrite existing configuration')
  .action(initCommand);

program
  .command('setup')
  .description('Full one-command setup: init + start Qdrant + install Python deps + index patterns')
  .option(
    '-p, --platform <platforms...>',
    'Target platforms (claude, factory, vscode, opencode, omp, cline, codex, aider, continue, windsurf, zed, copilot, jetbrains, swe-agent, all)',
    ['all']
  )
  .option('--no-patterns', 'Skip pattern RAG setup')
  .option('--no-memory', 'Skip memory system setup')
  .option(
    '-d, --project-dir <path>',
    'Target project directory (defaults to current working directory)'
  )
  .option('-i, --interactive', 'Run interactive setup wizard with feature toggles')
  .action(setupCommand);

program
  .command('analyze')
  .description('Analyze project structure and generate metadata')
  .option('-o, --output <format>', 'Output format (json, yaml, md)', 'json')
  .option('--save', 'Save analysis to .uap.analysis.json')
  .action(analyzeCommand);

program
  .command('generate')
  .description('Generate or update CLAUDE.md and related files')
  .option('-f, --force', 'Overwrite existing files without confirmation')
  .option('-d, --dry-run', 'Show what would be generated without writing')
  .option('-p, --platform <platform>', 'Generate for specific platform only')
  .option('--web', 'Generate AGENT.md for web platforms (claude.ai, factory.ai)')
  .option(
    '--pipeline-only',
    'Enforce pipeline-only infrastructure changes (no direct kubectl/terraform)'
  )
  .action(generateCommand);

program
  .command('memory')
  .description('Manage agent memory system')
  .addCommand(
    new Command('status')
      .description('Show memory system status')
      .action(() => memoryCommand('status'))
  )
  .addCommand(
    new Command('start')
      .description('Start memory services (Qdrant container)')
      .action(() => memoryCommand('start'))
  )
  .addCommand(
    new Command('stop').description('Stop memory services').action(() => memoryCommand('stop'))
  )
  .addCommand(
    new Command('query')
      .description('Query long-term memory')
      .argument('<search>', 'Search term')
      .option('-n, --limit <number>', 'Max results', '10')
      .action((search, options) => memoryCommand('query', { search, ...options }))
  )
  .addCommand(
    new Command('store')
      .description('Store a memory (applies write gate unless --force)')
      .argument('<content>', 'Memory content')
      .option('-t, --tags <tags>', 'Comma-separated tags')
      .option('-i, --importance <number>', 'Importance score (1-10)', '5')
      .option('-f, --force', 'Bypass write gate (store without quality check)')
      .action((content, options) => memoryCommand('store', { content, ...options }))
  )
  .addCommand(
    new Command('prepopulate')
      .description('Prepopulate memory from documentation and git history')
      .option('--docs', 'Import from documentation only')
      .option('--git', 'Import from git history only')
      .option('-n, --limit <number>', 'Limit git commits to analyze', '500')
      .option('--since <date>', 'Only analyze commits since date (e.g., "2024-01-01")')
      .option('-v, --verbose', 'Show detailed output')
      .action((options) => memoryCommand('prepopulate', options))
  )
  .addCommand(
    new Command('promote')
      .description('Review and promote daily log entries to working/semantic memory')
      .action((options) => memoryCommand('promote', options))
  )
  .addCommand(
    new Command('correct')
      .description('Correct a memory (propagates across all tiers, marks old as superseded)')
      .argument('<search>', 'Search term to find the memory to correct')
      .option('-c, --correction <text>', 'The corrected content')
      .option('-r, --reason <reason>', 'Reason for correction')
      .action((search, options) => memoryCommand('correct', { search, ...options }))
  )
  .addCommand(
    new Command('maintain')
      .description('Run maintenance: decay, prune stale, archive old, remove duplicates')
      .option('-v, --verbose', 'Show detailed output')
      .action((options) => memoryCommand('maintain', options))
  );

// Pattern RAG Commands
program
  .command('patterns')
  .description('Manage pattern RAG (on-demand pattern retrieval via Qdrant)')
  .addCommand(
    new Command('status')
      .description('Show pattern RAG status and collection info')
      .action(() => patternsCommand('status'))
  )
  .addCommand(
    new Command('index')
      .description('Index patterns from CLAUDE.md into Qdrant')
      .option('-v, --verbose', 'Show detailed output')
      .action((options) => patternsCommand('index', options))
  )
  .addCommand(
    new Command('query')
      .description('Query patterns by task description')
      .argument('<search>', 'Task description to match')
      .option('-n, --top <number>', 'Number of results', '2')
      .option('--min-score <number>', 'Minimum similarity score', '0.35')
      .option('--format <format>', 'Output format (text, json, context)', 'text')
      .action((search, options) => patternsCommand('query', { search, ...options }))
  )
  .addCommand(
    new Command('generate')
      .description('Generate Python index/query scripts from config')
      .option('-f, --force', 'Overwrite existing scripts')
      .action((options) => patternsCommand('generate', options))
  );

program
  .command('worktree')
  .description('Manage git worktrees')
  .addCommand(
    new Command('create')
      .description('Create a new worktree for a feature')
      .argument('<slug>', 'Feature slug (e.g., add-user-auth)')
      .action((slug) => worktreeCommand('create', { slug }))
  )
  .addCommand(
    new Command('list').description('List all worktrees').action(() => worktreeCommand('list'))
  )
  .addCommand(
    new Command('pr')
      .description('Create PR from worktree')
      .argument('<id>', 'Worktree ID')
      .option('--draft', 'Create as draft PR')
      .action((id, options) => worktreeCommand('pr', { id, ...options }))
  )
  .addCommand(
    new Command('cleanup')
      .description('Remove worktree and delete branch')
      .argument('<id>', 'Worktree ID')
      .action((id) => worktreeCommand('cleanup', { id }))
  );

program
  .command('sync')
  .description('Sync configuration between platforms')
  .option('--from <platform>', 'Source platform (claude, factory, vscode, opencode)')
  .option('--to <platform>', 'Target platform(s)')
  .option('--dry-run', 'Preview changes without writing files')
  .action(syncCommand);

program
  .command('droids')
  .description('Manage custom droids/agents')
  .addCommand(
    new Command('list').description('List all droids').action(() => droidsCommand('list'))
  )
  .addCommand(
    new Command('add')
      .description('Add a new droid')
      .argument('<name>', 'Droid name')
      .option('-t, --template <template>', 'Use built-in template')
      .action((name, options) => droidsCommand('add', { name, ...options }))
  )
  .addCommand(
    new Command('import')
      .description('Import droids from another platform')
      .argument('<path>', 'Path to import from')
      .action((path) => droidsCommand('import', { path }))
  );

// Agent Coordination Commands
program
  .command('coord')
  .description('Agent coordination and status')
  .addCommand(
    new Command('status')
      .description('Show coordination status (agents, claims, deploys)')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => coordCommand('status', options))
  )
  .addCommand(
    new Command('flush')
      .description('Force execute all pending deploys')
      .action((options) => coordCommand('flush', options))
  )
  .addCommand(
    new Command('cleanup')
      .description('Clean up stale agents and expired data')
      .action((options) => coordCommand('cleanup', options))
  );

program
  .command('agent')
  .description('Agent lifecycle, work coordination, and communication')
  .addCommand(
    new Command('register')
      .description('Register a new agent (each agent works in isolated worktree)')
      .option('-n, --name <name>', 'Agent name (required)')
      .option('-c, --capabilities <caps>', 'Comma-separated capabilities')
      .option('-w, --worktree <branch>', 'Git worktree branch this agent is using')
      .action((options) => agentCommand('register', options))
  )
  .addCommand(
    new Command('heartbeat')
      .description('Send heartbeat for an agent')
      .option('-i, --id <id>', 'Agent ID (required)')
      .action((options) => agentCommand('heartbeat', options))
  )
  .addCommand(
    new Command('status')
      .description('Show agent status')
      .option('-i, --id <id>', 'Agent ID (optional, shows all if omitted)')
      .action((options) => agentCommand('status', options))
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
      .action((options) => agentCommand('announce', options))
  )
  .addCommand(
    new Command('complete')
      .description('Mark work as complete on a resource (notifies other agents)')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-r, --resource <resource>', 'Resource that work is complete on')
      .action((options) => agentCommand('complete', options))
  )
  .addCommand(
    new Command('overlaps')
      .description('Check for overlapping work (merge conflict risk assessment)')
      .option('-r, --resource <resource>', 'Resource to check (omit to show all active work)')
      .action((options) => agentCommand('overlaps', options))
  )
  .addCommand(
    new Command('broadcast')
      .description('Broadcast a message to all agents')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-c, --channel <channel>', 'Channel: broadcast, deploy, review, coordination')
      .option('-m, --message <message>', 'Message payload (JSON or string)')
      .option('-p, --priority <priority>', 'Priority 1-10', '5')
      .action((options) => agentCommand('broadcast', options))
  )
  .addCommand(
    new Command('send')
      .description('Send a direct message to another agent')
      .option('-i, --id <id>', 'Sender agent ID (required)')
      .option('-t, --to <to>', 'Recipient agent ID (required)')
      .option('-m, --message <message>', 'Message payload (JSON or string)')
      .option('-p, --priority <priority>', 'Priority 1-10', '5')
      .action((options) => agentCommand('send', options))
  )
  .addCommand(
    new Command('receive')
      .description('Receive pending messages')
      .option('-i, --id <id>', 'Agent ID (required)')
      .option('-c, --channel <channel>', 'Filter by channel')
      .option('--no-mark-read', 'Do not mark messages as read')
      .action((options) => agentCommand('receive', options))
  )
  .addCommand(
    new Command('deregister')
      .description('Deregister an agent')
      .option('-i, --id <id>', 'Agent ID (required)')
      .action((options) => agentCommand('deregister', options))
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
      .action((options) => deployCommand('queue', options))
  )
  .addCommand(
    new Command('batch')
      .description('Create a batch from pending deploy actions')
      .option('-v, --verbose', 'Show detailed batch info')
      .action((options) => deployCommand('batch', options))
  )
  .addCommand(
    new Command('execute')
      .description('Execute a deploy batch')
      .option('-b, --batch-id <id>', 'Batch ID (required)')
      .option('--dry-run', 'Show what would be executed without running')
      .action((options) => deployCommand('execute', options))
  )
  .addCommand(
    new Command('status')
      .description('Show deploy queue status')
      .option('-v, --verbose', 'Show detailed status')
      .action((options) => deployCommand('status', options))
  )
  .addCommand(
    new Command('flush')
      .description('Flush all pending deploys (batch and execute)')
      .option('-v, --verbose', 'Show detailed results')
      .option('--dry-run', 'Show what would be executed without running')
      .action((options) => deployCommand('flush', options))
  )
  .addCommand(
    new Command('config')
      .description('Show deploy batch configuration (window settings)')
      .action((options) => deployCommand('config', options))
  )
  .addCommand(
    new Command('set-config')
      .description('Set deploy batch configuration (window settings)')
      .option(
        '--message <json>',
        'JSON object with window settings, e.g. {"commit":60000,"push":3000}'
      )
      .action((options) => deployCommand('set-config', options))
  )
  .addCommand(
    new Command('urgent')
      .description('Enable or disable urgent mode (fast batch windows)')
      .option('--on', 'Enable urgent mode')
      .option('--off', 'Disable urgent mode (default)')
      .action((options) => deployCommand('urgent', { force: options.on, remote: options.off }))
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
      .action((options) => taskCommand('create', options))
  )
  .addCommand(
    new Command('list')
      .description('List tasks')
      .option('-s, --filter-status <status>', 'Filter by status (comma-separated)')
      .option('--filter-type <type>', 'Filter by type (comma-separated)')
      .option('--filter-priority <priority>', 'Filter by priority (comma-separated)')
      .option('-a, --filter-assignee <assignee>', 'Filter by assignee')
      .option('-l, --filter-labels <labels>', 'Filter by labels (comma-separated)')
      .option('--search <search>', 'Search in title/description')
      .option('--show-blocked', 'Show only blocked tasks')
      .option('--show-ready', 'Show only ready tasks')
      .option('-v, --verbose', 'Show more details')
      .option('--json', 'Output as JSON')
      .action((options) => taskCommand('list', options))
  )
  .addCommand(
    new Command('show')
      .description('Show task details')
      .argument('<id>', 'Task ID')
      .option('-v, --verbose', 'Show history')
      .option('--json', 'Output as JSON')
      .action((id, options) => taskCommand('show', { id, ...options }))
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
      .action((id, options) => taskCommand('update', { id, ...options }))
  )
  .addCommand(
    new Command('close')
      .description('Close a task (mark as done)')
      .argument('<id>', 'Task ID')
      .option('-r, --reason <reason>', 'Closure reason')
      .action((id, options) => taskCommand('close', { id, ...options }))
  )
  .addCommand(
    new Command('delete')
      .description('Delete a task')
      .argument('<id>', 'Task ID')
      .action((id) => taskCommand('delete', { id }))
  )
  .addCommand(
    new Command('ready')
      .description('List tasks ready to work on (no blockers)')
      .option('--json', 'Output as JSON')
      .action((options) => taskCommand('ready', options))
  )
  .addCommand(
    new Command('blocked')
      .description('List blocked tasks')
      .option('--json', 'Output as JSON')
      .action((options) => taskCommand('blocked', options))
  )
  .addCommand(
    new Command('dep')
      .description('Add a dependency between tasks')
      .option('-f, --from <from>', 'Dependent task (the task that is blocked)')
      .option('-t, --to <to>', 'Blocking task (the task that must complete first)')
      .option('--dep-type <type>', 'Dependency type: blocks, related, discovered_from', 'blocks')
      .action((options) => taskCommand('dep', options))
  )
  .addCommand(
    new Command('undep')
      .description('Remove a dependency between tasks')
      .option('-f, --from <from>', 'Dependent task')
      .option('-t, --to <to>', 'Blocking task')
      .action((options) => taskCommand('undep', options))
  )
  .addCommand(
    new Command('claim')
      .description('Claim a task (assign + announce work + create worktree)')
      .argument('<id>', 'Task ID')
      .option('-b, --branch <branch>', 'Worktree branch name')
      .action((id, options) => taskCommand('claim', { id, ...options }))
  )
  .addCommand(
    new Command('release')
      .description('Release a task (mark complete + announce)')
      .argument('<id>', 'Task ID')
      .option('-r, --reason <reason>', 'Completion reason')
      .action((id, options) => taskCommand('release', { id, ...options }))
  )
  .addCommand(
    new Command('stats')
      .description('Show task statistics')
      .option('--json', 'Output as JSON')
      .action((options) => taskCommand('stats', options))
  )
  .addCommand(
    new Command('sync')
      .description('Sync tasks with JSONL file (for git versioning)')
      .action((options) => taskCommand('sync', options))
  )
  .addCommand(
    new Command('compact')
      .description('Compact old closed tasks into summaries')
      .option('--days <days>', 'Compact tasks older than N days', '90')
      .action((options) => taskCommand('compact', options))
  );

// Compliance - protocol verification and auto-fix
program
  .command('compliance')
  .description('UAP protocol compliance checking, auditing, and auto-fix')
  .addCommand(
    new Command('check')
      .description('Run compliance check (schema, memory, Qdrant, worktrees, secrets)')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => complianceCommand('check', options))
  )
  .addCommand(
    new Command('audit')
      .description('Deep compliance audit with verbose output')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => complianceCommand('audit', options))
  )
  .addCommand(
    new Command('fix')
      .description(
        'Auto-fix compliance issues (schema migrations, Qdrant collections, worktree cleanup)'
      )
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => complianceCommand('fix', options))
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
      .action((options) => dashboardCommand('overview', options))
  )
  .addCommand(
    new Command('tasks')
      .description('Task breakdown with charts, progress bars, and hierarchy trees')
      .option('-v, --verbose', 'Show detailed information')
      .option('--compact', 'Compact output')
      .action((options) => dashboardCommand('tasks', options))
  )
  .addCommand(
    new Command('agents')
      .description('Agent activity, resource claims, and coordination status')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => dashboardCommand('agents', options))
  )
  .addCommand(
    new Command('memory')
      .description('Memory system health, capacity, and layer architecture')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => dashboardCommand('memory', options))
  )
  .addCommand(
    new Command('progress')
      .description('Completion tracking with per-priority and per-type progress')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => dashboardCommand('progress', options))
  )
  .addCommand(
    new Command('stats')
      .description('Session context consumption stats with per-tool breakdown')
      .option('-v, --verbose', 'Show detailed information')
      .action((options) => dashboardCommand('stats', options))
  )
  .addCommand(
    new Command('session')
      .description('Live UAP session state: infrastructure, patterns, skills, git, policies')
      .option('-v, --verbose', 'Show detailed information')
      .option('--compact', 'Compact summary box (for post-task / pre-compact)')
      .action((options) => dashboardCommand('session', options))
  );

// Multi-Model Architecture commands
registerModelCommands(program);

// MCP Router - Lightweight hierarchical router for 98%+ token reduction
program
  .command('mcp-router')
  .description('MCP Router - hierarchical router for 98%+ token reduction')
  .addCommand(
    new Command('start')
      .description('Start the MCP router as a stdio server')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('-v, --verbose', 'Enable verbose logging')
      .action((options) => mcpRouterCommand('start', options))
  )
  .addCommand(
    new Command('stats')
      .description('Show router statistics (servers, tools, token savings)')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('-v, --verbose', 'Enable verbose logging')
      .option('--json', 'Output as JSON')
      .action((options) => mcpRouterCommand('stats', options))
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
      .action((options) => mcpRouterCommand('discover', options))
  )
  .addCommand(
    new Command('list')
      .description('List configured MCP servers')
      .option('-c, --config <path>', 'Path to mcp.json config file')
      .option('--json', 'Output as JSON')
      .action((options) => mcpRouterCommand('list', options))
  );

// Session Hooks - automatic memory injection and pre-compaction flush
program
  .command('hooks')
  .description(
    'Manage session hooks for Claude Code, Factory.AI, Cursor, VSCode, OpenCode, Oh-My-Pi'
  )
  .addCommand(
    new Command('install')
      .description('Install UAP session hooks')
      .option(
        '-t, --target <target>',
        'Target platform: claude, factory, cursor, vscode, opencode, omp (default: all)'
      )
      .action((options) =>
        hooksCommand('install', { target: options.target as HooksTarget | undefined })
      )
  )
  .addCommand(
    new Command('status')
      .description('Show hooks installation status')
      .option(
        '-t, --target <target>',
        'Target platform: claude, factory, cursor, vscode, opencode, omp (default: all)'
      )
      .action((options) =>
        hooksCommand('status', { target: options.target as HooksTarget | undefined })
      )
  );

// Qwen3.5 Tool Call Fixes - performance optimizations for tool calling
const toolCallsCmd = new Command('tool-calls');
toolCallsCmd.description('Manage Qwen3.5 tool call fixes and chat templates');
toolCallsCmd.addCommand(
  new Command('setup')
    .description('Install chat templates and Python scripts')
    .action(() => toolCallsCommand('setup'))
);
toolCallsCmd.addCommand(
  new Command('test')
    .description('Run reliability test suite')
    .addOption(new Option('--verbose', 'Verbose output'))
    .action(() => toolCallsCommand('test'))
);
toolCallsCmd.addCommand(
  new Command('status')
    .description('Check current configuration')
    .action(() => toolCallsCommand('status'))
);
toolCallsCmd.addCommand(
  new Command('fix')
    .description('Apply template fixes to existing templates')
    .action(() => toolCallsCommand('fix'))
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
      await installRTK({
        force: !!options.force,
        method: options.method as any,
      });
    })
);
rtkCmd.addCommand(
  new Command('status').description('Check RTK installation and token savings').action(async () => {
    await checkRTKStatus();
  })
);
rtkCmd.addCommand(
  new Command('help').description('Show RTK usage information').action(() => {
    showRTKHelp();
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
    await setupMcpRouter({ force: !!options.force, verbose: !!options.verbose });
  });

// Register schema-diff command
registerSchemaDiffCommand(program);

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
