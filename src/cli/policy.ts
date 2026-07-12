/**
 * Policy Management Commands
 *
 * Commands for managing UAP policies:
 * - uap policy list - List all policies
 * - uap policy install <name> - Install a built-in policy
 * - uap policy enable <id> - Enable a policy
 * - uap policy disable <id> - Disable a policy
 * - uap policy status - Show enabled/disabled policies
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getPolicyGate } from '../policies/policy-gate.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getPolicyToolRegistry } from '../policies/policy-tools.js';
import { convertPolicyToClaude } from '../policies/convert-policy-to-claude.js';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve built-in schema/enforcer dirs relative to the INSTALLED PACKAGE
// (dist/cli -> package root -> src/policies/...), falling back to cwd for
// in-repo dev. A plain process.cwd() base found ZERO built-ins when `uap` runs
// from any project other than this repo (so `uap policy install`/`matrix` were
// silently empty when installed globally).
const __dirname = dirname(fileURLToPath(import.meta.url));
function resolvePolicyDir(sub: string): string {
  const candidates = [
    join(__dirname, '..', '..', 'src', 'policies', sub), // dist/cli -> pkg root
    join(process.cwd(), 'src', 'policies', sub), // running inside this repo
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}
const POLICY_DIR = resolvePolicyDir('schemas/policies');
const ENFORCER_DIR = resolvePolicyDir('enforcers');

/**
 * If an enforcer Python file exists alongside the installed policy (same
 * basename with hyphens->underscores), attach it via PolicyToolRegistry.
 * Returns the tool name on success, null if no enforcer present.
 */
export async function autoAttachEnforcer(policyName: string): Promise<string | null> {
  const toolName = policyName.replace(/-/g, '_');
  const enforcerPath = join(ENFORCER_DIR, `${toolName}.py`);
  if (!existsSync(enforcerPath)) return null;

  const memory = getPolicyMemoryManager();
  const policies = await memory.getAllPolicies();
  const installed = policies.find((p) => p.name === policyName);
  if (!installed) return null;

  const code = readFileSync(enforcerPath, 'utf-8');
  const registry = getPolicyToolRegistry();
  await registry.storeToolCode(installed.id, toolName, code);
  return toolName;
}

/** One row of the policy matrix: a built-in and/or installed policy with its
 * effective settings. Pure data so the matrix is testable without a DB/TTY. */
export interface PolicyMatrixRow {
  name: string;
  builtin: boolean;
  installed: boolean;
  enabled: boolean;
  level: string;
  stage: string;
  category: string;
  id?: string;
}

/** Parse `**Level**` / `**Category**` / `**Enforcement Stage**` from a built-in
 * schema markdown (fail-soft defaults). */
export function parsePolicyMeta(md: string): { level: string; category: string; stage: string } {
  const grab = (label: string, dflt: string): string => {
    const m = md.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, 'i'));
    return m ? m[1].trim() : dflt;
  };
  return {
    level: grab('Level', 'OPTIONAL'),
    category: grab('Category', 'custom'),
    stage: grab('Enforcement Stage', 'pre-exec'),
  };
}

/**
 * Build the full policy matrix: every built-in schema policy merged with the
 * installed-policy rows, so the operator sees ALL policies and their current
 * settings in one place. Pure: takes the built-in list (name → parsed meta) and
 * the installed policies. Installed values win for level/stage/status.
 */
export function buildPolicyMatrix(
  builtins: Array<{ name: string; level: string; category: string; stage: string }>,
  installed: Array<{ id: string; name: string; isActive: boolean; level?: string; category?: string; enforcementStage?: string }>
): PolicyMatrixRow[] {
  const byName = new Map<string, PolicyMatrixRow>();
  for (const b of builtins) {
    byName.set(b.name, {
      name: b.name,
      builtin: true,
      installed: false,
      enabled: false,
      level: b.level,
      stage: b.stage,
      category: b.category,
    });
  }
  for (const p of installed) {
    const existing = byName.get(p.name);
    const row: PolicyMatrixRow = {
      name: p.name,
      builtin: existing?.builtin ?? false,
      installed: true,
      enabled: p.isActive,
      level: p.level ?? existing?.level ?? 'OPTIONAL',
      stage: p.enforcementStage ?? existing?.stage ?? 'pre-exec',
      category: p.category ?? existing?.category ?? 'custom',
      id: p.id,
    };
    byName.set(p.name, row);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Absolute path to a built-in policy schema markdown (or '' if absent). */
export function builtinPolicyPath(name: string): string {
  const p = join(POLICY_DIR, `${name}.md`);
  return existsSync(p) ? p : '';
}

/** Read built-in policy schema files (excludes UPPERCASE README-style files). */
export function listBuiltinPolicies(): Array<{ name: string; level: string; category: string; stage: string }> {
  if (!existsSync(POLICY_DIR)) return [];
  return readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md') && f !== f.toUpperCase()) // skip PACK READMEs
    .map((f) => {
      const name = f.replace(/\.md$/, '');
      const meta = parsePolicyMeta(readFileSync(join(POLICY_DIR, f), 'utf-8'));
      return { name, ...meta };
    });
}

/**
 * Matrix command - list ALL policies (built-in + installed) with their settings
 * (status/level/stage/category) in one table, and show how to toggle/adjust each.
 * The "policy setup where all policies are listed and their settings can be
 * toggled/adjusted" surface.
 */
async function matrixCommand(): Promise<void> {
  const installed = await getPolicyMemoryManager().getAllPolicies();
  const rows = buildPolicyMatrix(
    listBuiltinPolicies(),
    installed.map((p) => ({
      id: p.id,
      name: p.name,
      isActive: p.isActive,
      level: p.level,
      category: p.category,
      enforcementStage: p.enforcementStage,
    }))
  );

  console.log(chalk.bold('\n=== UAP Policy Matrix ===\n'));
  const nameW = Math.min(38, Math.max(20, ...rows.map((r) => r.name.length)) + 1);
  const head =
    chalk.dim(
      `${'STATUS'.padEnd(9)}${'POLICY'.padEnd(nameW)}${'LEVEL'.padEnd(13)}${'STAGE'.padEnd(11)}${'SOURCE'.padEnd(10)}CATEGORY`
    );
  console.log(head);
  for (const r of rows) {
    const status = !r.installed
      ? chalk.gray('· avail ')
      : r.enabled
        ? chalk.green('✓ on    ')
        : chalk.red('✗ off   ');
    const level =
      r.level === 'REQUIRED' ? chalk.red(r.level)
        : r.level === 'RECOMMENDED' ? chalk.yellow(r.level)
          : chalk.gray(r.level);
    const source = r.builtin ? chalk.blue('built-in') : chalk.magenta('custom');
    console.log(
      `${status} ${chalk.cyan(r.name.padEnd(nameW))}${level.padEnd(13 + 10)}${chalk.blue(r.stage.padEnd(11))}${source.padEnd(10 + 9)}${chalk.dim(r.category)}`
    );
  }
  const on = rows.filter((r) => r.installed && r.enabled).length;
  const off = rows.filter((r) => r.installed && !r.enabled).length;
  const avail = rows.filter((r) => !r.installed).length;
  console.log(
    chalk.dim(`\n${on} enabled · ${off} installed-but-off · ${avail} available (not installed)\n`)
  );
  console.log(chalk.bold('Adjust:'));
  console.log(chalk.dim('  Install available : uap policy install <name>'));
  console.log(chalk.dim('  Enable / disable  : uap policy toggle <id>   (or enable/disable <id>)'));
  console.log(chalk.dim('  Change level      : uap policy level <id> REQUIRED|RECOMMENDED|OPTIONAL'));
  console.log(chalk.dim('  Change stage      : uap policy stage <id> pre-exec|post-exec|review|always'));
  console.log(chalk.dim('  IDs are shown by  : uap policy list'));
}

/**
 * Select command — choose which policies to enforce. Interactive multiselect by
 * default (the same picker `uap setup` uses); scriptable via
 * --all/--recommended/--set/--enable/--disable. REQUIRED policies stay on.
 */
async function selectCommand(options: {
  enable?: string;
  disable?: string;
  set?: string;
  recommended?: boolean;
  all?: boolean;
  json?: boolean;
}): Promise<void> {
  const { listPolicyChoices, applyPolicySelection, recommendedSelection } = await import('./policy-select.js');
  const choices = await listPolicyChoices();
  const split = (s?: string): string[] => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const nonInteractive = Boolean(options.enable || options.disable || options.set || options.recommended || options.all);

  let target: string[];
  let ui: Awaited<ReturnType<typeof import('./prompt-ui.js').createClackUI>> | null = null;

  if (nonInteractive) {
    let sel = new Set(choices.filter((c) => c.installed && c.enabled).map((c) => c.name));
    if (options.all) sel = new Set(choices.map((c) => c.name));
    else if (options.recommended) sel = new Set(recommendedSelection(choices));
    else if (options.set) sel = new Set(split(options.set));
    for (const n of split(options.enable)) sel.add(n);
    for (const n of split(options.disable)) sel.delete(n);
    target = [...sel];
  } else {
    const { createClackUI } = await import('./prompt-ui.js');
    ui = await createClackUI();
    ui.intro('Select the policies to enforce');
    target = await ui.multiselect<string>({
      message: 'Space toggles, enter confirms. REQUIRED policies stay on regardless.',
      options: choices.map((c) => ({
        value: c.name,
        label: `${c.name}${c.protected ? chalk.dim(' (required)') : ''}`,
        hint: `${c.category} · ${c.level}${c.description ? ` — ${c.description}` : ''}`,
      })),
      initialValues: choices.filter((c) => (c.installed && c.enabled) || c.protected).map((c) => c.name),
      required: false,
    });
  }

  const result = await applyPolicySelection(target);

  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const changed = result.installed.length + result.enabled.length + result.disabled.length;
  const summary = [
    result.installed.length ? chalk.green(`installed ${result.installed.length}`) : '',
    result.enabled.length ? chalk.green(`enabled ${result.enabled.length}`) : '',
    result.disabled.length ? chalk.yellow(`disabled ${result.disabled.length}`) : '',
  ].filter(Boolean).join(', ');
  const body = changed
    ? `${summary}\n${[...result.installed, ...result.enabled].length ? chalk.green('  on:  ') + [...new Set([...result.installed, ...result.enabled])].join(', ') : ''}${result.disabled.length ? '\n' + chalk.yellow('  off: ') + result.disabled.join(', ') : ''}`
    : 'No changes — selection already matches enforced policies.';
  if (ui) ui.outro(body);
  else console.log(body);
}

/**
 * List command - show all policies
 */
async function listCommand(): Promise<void> {
  console.log(chalk.bold('\n=== UAP Policy Status ===\n'));

  const policyManager = getPolicyMemoryManager();
  const policies = await policyManager.getAllPolicies();

  if (policies.length === 0) {
    console.log(
      chalk.yellow('No policies found. Run `uap policy install <name>` to install policies.')
    );
    return;
  }

  console.log(`Total Policies: ${policies.length}\n`);

  for (const policy of policies) {
    const statusIcon = policy.isActive ? chalk.green('✓') : chalk.red('✗');
    const levelBadge =
      policy.level === 'REQUIRED'
        ? chalk.red('REQUIRED')
        : policy.level === 'RECOMMENDED'
          ? chalk.yellow('RECOMMENDED')
          : chalk.gray('OPTIONAL');

    console.log(`${statusIcon} ${chalk.cyan(policy.name)}`);
    console.log(`    Status: ${policy.isActive ? chalk.green('Enabled') : chalk.red('Disabled')}`);
    console.log(`    Level: ${levelBadge}`);
    console.log(`    Category: ${chalk.yellow(policy.category)}`);
    console.log(`    Stage: ${chalk.blue(policy.enforcementStage || 'pre-exec')}`);
    console.log(`    Version: ${policy.version}`);
    console.log();
  }
}

/**
 * Install command - install a built-in policy
 */
async function installCommand(name: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  // Check if policy file exists in the policies directory
  const policyPath = join(POLICY_DIR, `${name}.md`);

  if (!existsSync(policyPath)) {
    console.log(chalk.red(`\n❌ Policy '${name}' not found.`));
    console.log(chalk.yellow('\nAvailable built-in policies:'));

    // List available policy files
    if (existsSync(POLICY_DIR)) {
      const files = readdirSync(POLICY_DIR).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const policyName = file.replace('.md', '');
        console.log(`  - ${policyName}`);
      }
    } else {
      console.log('  - mandatory-testing-deployment');
    }

    return;
  }

  // Read policy content
  const content = readFileSync(policyPath, 'utf-8');

  try {
    await policyManager.storeRawPolicy(content);
    console.log(chalk.green(`\n✅ Policy '${name}' installed successfully!`));
    console.log(chalk.dim('The policy is now active and will be enforced.'));

    // Auto-attach Python enforcer if one lives alongside the markdown
    const toolName = await autoAttachEnforcer(name);
    if (toolName) {
      console.log(chalk.dim(`    → attached enforcer '${toolName}' from src/policies/enforcers/${toolName}.py`));
    }

    // Invalidate cache to pick up new policy
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to install policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Enable command - enable a policy
 */
async function enableCommand(id: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  try {
    await policyManager.togglePolicy(id, true);
    console.log(chalk.green(`\n✅ Policy '${id}' enabled successfully!`));
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to enable policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Disable command - disable a policy
 */
async function disableCommand(id: string): Promise<void> {
  const policyManager = getPolicyMemoryManager();
  const policyGate = getPolicyGate();

  try {
    await policyManager.togglePolicy(id, false);
    console.log(chalk.yellow(`\n⚠️  Policy '${id}' disabled. It will no longer be enforced.`));
    policyGate.invalidateCache();
  } catch (error) {
    console.error(
      chalk.red(
        `\n❌ Failed to disable policy: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Status command - show detailed policy status
 */
async function statusCommand(): Promise<void> {
  console.log(chalk.bold('\n=== Policy Enforcement Status ===\n'));

  const policyManager = getPolicyMemoryManager();
  const policies = await policyManager.getAllPolicies();

  const enabled = policies.filter((p) => p.isActive);
  const disabled = policies.filter((p) => !p.isActive);

  console.log(`Enabled:  ${chalk.green(enabled.length.toString())}`);
  console.log(`Disabled: ${chalk.red(disabled.length.toString())}`);
  console.log();

  if (enabled.length > 0) {
    console.log(chalk.bold('Active Policies:'));
    for (const policy of enabled) {
      console.log(`  ${chalk.green('✓')} ${policy.name} (${policy.level}) - ${policy.category}`);
    }
    console.log();
  }

  if (disabled.length > 0) {
    console.log(chalk.bold('Inactive Policies:'));
    for (const policy of disabled) {
      console.log(`  ${chalk.red('✗')} ${policy.name} - ${policy.category}`);
    }
    console.log();
  }

  // Show enforcement stages
  console.log(chalk.bold('\nEnforcement Stages:'));
  console.log('  pre-exec  - Before operation execution');
  console.log('  post-exec - After operation execution');
  console.log('  review    - During code review/task completion');
  console.log('  always    - Always enforced (all stages)');
}

/**
 * Register policy commands
 */
export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('UAP policy management');

  policy.command('list').description('List all policies and their status').action(listCommand);

  policy
    .command('matrix')
    .description('Show ALL policies (built-in + installed) with settings, and how to toggle/adjust them')
    .action(matrixCommand);

  policy
    .command('select')
    .description('Choose which policies to enforce — interactive picker, or --all/--recommended/--set/--enable/--disable')
    .option('--enable <names>', 'comma-separated policies to add (install+enable)')
    .option('--disable <names>', 'comma-separated policies to remove (REQUIRED policies stay on)')
    .option('--set <names>', 'comma-separated EXACT set to enforce (everything else off, except REQUIRED)')
    .option('--recommended', 'select all REQUIRED + RECOMMENDED policies')
    .option('--all', 'select every available policy')
    .option('--json', 'emit JSON result')
    .action(selectCommand);

  policy
    .command('recommend [scenario]')
    .description('Recommend policies for a workflow (solo-local | team | ci-gated | high-autonomy | security | ui)')
    .action(async (scenario?: string) => {
      const { CORE, SCENARIOS, getScenario, recommendedFor } = await import(
        '../config/policy-recommendations.js'
      );
      if (!scenario) {
        console.log(chalk.bold('\nPolicy recommendations\n'));
        console.log('Always recommended (the safety floor):');
        for (const r of CORE) console.log(`  ${chalk.green(r.slug)} — ${chalk.dim(r.why)}`);
        console.log('\nScenarios — run ' + chalk.cyan('uap policy recommend <id>') + ' for a tailored set:');
        for (const s of SCENARIOS) console.log(`  ${chalk.yellow(s.id.padEnd(14))} ${s.title} — ${chalk.dim(s.blurb)}`);
        console.log('\nInteractive: ' + chalk.cyan('uap config wizard') + ' (or ' + chalk.cyan('uap setup --profile custom') + ')\n');
        return;
      }
      const sc = getScenario(scenario);
      if (!sc) {
        console.error(
          chalk.red(`Unknown scenario '${scenario}'. One of: ${SCENARIOS.map((s) => s.id).join(', ')}`)
        );
        process.exitCode = 2;
        return;
      }
      const recs = recommendedFor(scenario);
      const coreSlugs = new Set(CORE.map((c) => c.slug));
      console.log(chalk.bold(`\nRecommended policies — ${sc.title}`));
      console.log(chalk.dim(sc.blurb) + '\n');
      for (const r of recs) {
        const tag = coreSlugs.has(r.slug) ? chalk.dim(' (core)') : '';
        console.log(`  ${chalk.green(r.slug)}${tag} — ${chalk.dim(r.why)}`);
      }
      console.log('\nInstall all:');
      console.log('  ' + chalk.cyan(recs.map((r) => `uap policy install ${r.slug}`).join(' && ')));
      console.log('\nReview what is active: ' + chalk.cyan('uap policy matrix') + '\n');
    });

  policy.command('install <name>').description('Install a built-in policy').action(installCommand);

  policy.command('enable <id>').description('Enable a policy by ID').action(enableCommand);

  policy.command('disable <id>').description('Disable a policy by ID').action(disableCommand);

  policy
    .command('status')
    .description('Show detailed policy enforcement status')
    .action(statusCommand);

  // ── Commands merged from bin/policy.ts ──────────────────────────────

  policy
    .command('add')
    .description('Add a new policy from markdown file')
    .requiredOption('-f, --file <path>', 'Path to policy markdown file')
    .option('-c, --category <name>', 'Policy category', 'custom')
    .option(
      '-l, --level <level>',
      'Enforcement level (REQUIRED, RECOMMENDED, OPTIONAL)',
      'RECOMMENDED'
    )
    .option('-t, --tags <tags>', 'Comma-separated tags', '')
    .action(async (options: { file: string; category: string; level: string; tags: string }) => {
      const memory = getPolicyMemoryManager();
      const rawMarkdown = readFileSync(options.file, 'utf-8');
      const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];
      const validLevels = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
      const level = validLevels.includes(options.level) ? options.level : 'RECOMMENDED';
      const policyId = await memory.storeRawPolicy(rawMarkdown, {
        category: options.category as
          | 'custom'
          | 'security'
          | 'testing'
          | 'code'
          | 'ui'
          | 'automation'
          | 'image',
        level: level as 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL',
        tags,
      });
      console.log(chalk.green(`Policy stored with ID: ${policyId}`));
    });

  policy
    .command('convert')
    .description('Convert raw policy to CLAUDE.md format')
    .requiredOption('-i, --input <id>', 'Policy ID or path to markdown file')
    .option('-o, --output <path>', 'Output file path')
    .action(async (options: { input: string; output?: string }) => {
      let rawMarkdown: string;
      if (options.input.endsWith('.md')) {
        rawMarkdown = readFileSync(options.input, 'utf-8');
      } else {
        const memory = getPolicyMemoryManager();
        const p = await memory.getPolicy(options.input);
        if (!p) throw new Error(`Policy ${options.input} not found`);
        rawMarkdown = p.rawMarkdown;
      }
      const converted = convertPolicyToClaude(rawMarkdown);
      const outputPath = options.output || `converted-${Date.now()}.md`;
      writeFileSync(outputPath, converted);
      console.log(chalk.green(`Converted to: ${outputPath}`));
    });

  policy
    .command('get-relevant')
    .description('Get policies relevant to current task context')
    .requiredOption('-t, --task <text>', 'Task description or context')
    .option('--top <n>', 'Number of policies to retrieve', '3')
    .action(async (options: { task: string; top: string }) => {
      const memory = getPolicyMemoryManager();
      const policies = await memory.getRelevantPolicies(options.task, parseInt(options.top));
      console.log(chalk.bold('\nRelevant Policies:\n'));
      for (const p of policies) {
        const preview = p.rawMarkdown.split('\n').slice(0, 2).join('\n     ');
        console.log(`  ${chalk.cyan(`[${p.level}]`)} ${p.name}`);
        console.log(`     ${preview}`);
        console.log('');
      }
    });

  policy
    .command('add-tool')
    .description('Add Python tool code to a policy')
    .requiredOption('-p, --policy <id>', 'Policy ID')
    .requiredOption('-t, --tool <name>', 'Tool name')
    .requiredOption('-c, --code <file>', 'Path to Python code file')
    .action(async (options: { policy: string; tool: string; code: string }) => {
      const registry = getPolicyToolRegistry();
      const pythonCode = readFileSync(options.code, 'utf-8');
      await registry.storeToolCode(options.policy, options.tool, pythonCode);
      console.log(chalk.green(`Tool "${options.tool}" added to policy ${options.policy}`));
    });

  policy
    .command('check')
    .description('Check if an operation would be allowed by policies')
    .requiredOption('-o, --operation <name>', 'Operation name')
    .option('-a, --args <json>', 'JSON arguments', '{}')
    .action(async (options: { operation: string; args: string }) => {
      const gate = getPolicyGate();
      const args = JSON.parse(options.args);
      const result = await gate.checkPolicies(options.operation, args);
      if (result.allowed) {
        console.log(
          chalk.green(`ALLOWED: Operation "${options.operation}" passes all policy checks`)
        );
      } else {
        console.log(chalk.red(`BLOCKED: Operation "${options.operation}" blocked by:`));
        for (const block of result.blockedBy) {
          console.log(`  ${chalk.red(`[${block.policyName}]`)} ${block.reason}`);
        }
      }
    });

  policy
    .command('audit')
    .description('Show policy enforcement audit trail')
    .option('-p, --policy <id>', 'Filter by policy ID')
    .option('-n, --limit <n>', 'Number of entries', '20')
    .action(async (options: { policy?: string; limit: string }) => {
      const gate = getPolicyGate();
      const entries = await gate.getAuditTrail(options.policy, parseInt(options.limit));
      console.log(chalk.bold('\nAudit Trail:\n'));
      for (const entry of entries) {
        const icon = entry.allowed ? chalk.green('PASS') : chalk.red('BLOCK');
        console.log(`  [${icon}] ${entry.operation} at ${entry.executedAt}`);
        console.log(`     Policy: ${entry.policyId}`);
        if (entry.reason) console.log(`     Reason: ${entry.reason}`);
        console.log('');
      }
    });

  policy
    .command('toggle <id>')
    .description('Toggle a policy on or off')
    .option('--on', 'Enable the policy')
    .option('--off', 'Disable the policy')
    .action(async (id: string, options: { on?: boolean; off?: boolean }) => {
      const memory = getPolicyMemoryManager();
      const p = await memory.getPolicy(id);
      if (!p) {
        console.error(chalk.red(`Policy ${id} not found`));
        process.exit(1);
      }
      const newState = options.off ? false : options.on ? true : !p.isActive;
      await memory.togglePolicy(id, newState);
      console.log(chalk.green(`Policy "${p.name}" is now ${newState ? 'ACTIVE' : 'INACTIVE'}`));
    });

  policy
    .command('stage <id>')
    .description('Change the enforcement stage of a policy')
    .requiredOption('-s, --stage <stage>', 'Enforcement stage: pre-exec, post-exec, review, always')
    .action(async (id: string, options: { stage: string }) => {
      const validStages = ['pre-exec', 'post-exec', 'review', 'always'];
      if (!validStages.includes(options.stage)) {
        console.error(
          chalk.red(`Invalid stage "${options.stage}". Must be one of: ${validStages.join(', ')}`)
        );
        process.exit(1);
      }
      const memory = getPolicyMemoryManager();
      const p = await memory.getPolicy(id);
      if (!p) {
        console.error(chalk.red(`Policy ${id} not found`));
        process.exit(1);
      }
      await memory.setEnforcementStage(
        id,
        options.stage as 'pre-exec' | 'post-exec' | 'review' | 'always'
      );
      console.log(chalk.green(`Policy "${p.name}" enforcement stage set to: ${options.stage}`));
    });

  policy
    .command('level <id>')
    .description('Change the enforcement level of a policy')
    .requiredOption('-l, --level <level>', 'Enforcement level: REQUIRED, RECOMMENDED, OPTIONAL')
    .action(async (id: string, options: { level: string }) => {
      const validLevels = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
      if (!validLevels.includes(options.level)) {
        console.error(
          chalk.red(`Invalid level "${options.level}". Must be one of: ${validLevels.join(', ')}`)
        );
        process.exit(1);
      }
      const memory = getPolicyMemoryManager();
      const p = await memory.getPolicy(id);
      if (!p) {
        console.error(chalk.red(`Policy ${id} not found`));
        process.exit(1);
      }
      await memory.setLevel(id, options.level as 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL');
      console.log(chalk.green(`Policy "${p.name}" enforcement level set to: ${options.level}`));
    });
}
