import chalk from 'chalk';
import ora from 'ora';
import { initCommand } from './init.js';
import { startServices, isQdrantReachable } from './memory.js';
import { ensurePythonVenv, findPython, generateScripts } from './patterns.js';
import { patternsCommand } from './patterns.js';
import { setupMcpRouter } from './setup-mcp-router.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AgentContextConfigSchema } from '../types/index.js';
import { selfUpdateCli } from '../utils/self-update.js';
import { detectCustomSections, extractAuto, reportOnly } from './setup-extract.js';
import { backupInstructionFiles } from './setup-backup.js';

export interface SetupOptions {
  platform?: string[];
  patterns?: boolean; // --no-patterns to skip
  memory?: boolean; // --no-memory to skip
  verbose?: boolean; // --verbose for detailed output
  projectDir?: string; // -d, --project-dir to override cwd
  interactive?: boolean; // -i, --interactive (legacy alias → guided wizard)
  systemdServices?: boolean; // --systemd-services scaffolds llama/proxy user services
  selfUpdate?: boolean; // --no-self-update to skip the CLI version check
  nonInteractive?: boolean; // --non-interactive forces the scripted path
  yes?: boolean; // -y/--yes forces the scripted path
  extract?: boolean; // --no-extract skips custom-content extraction
  extractAuto?: boolean; // --extract-auto extracts without prompting
  backup?: boolean; // --no-backup disables instruction-file backup
  profile?: 'recommended' | 'maximum' | 'minimal'; // --profile preset bundle
}

/**
 * Decide whether to run the guided (interactive) wizard. Default is interactive,
 * but a non-TTY / CI / explicit --non-interactive|-y run uses the scripted path
 * so pipelines never hang on a prompt.
 */
export function resolveInteractive(options: SetupOptions): boolean {
  if (options.nonInteractive || options.yes) return false;
  if (!process.stdout.isTTY || process.env.CI) return false;
  return true;
}

/**
 * One-command setup: init + start services + venv + index patterns.
 * Chains existing commands so everything "just works".
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  const cwd = options.projectDir || process.cwd();

  // Run the self-update check once, up front, for every mode.
  maybeSelfUpdate(options);

  // Guided wizard is the DEFAULT (interactive TTY); non-interactive/CI run the
  // scripted path below.
  if (resolveInteractive(options)) {
    const { runGuidedSetup } = await import('./guided-setup.js');
    return runGuidedSetup(options);
  }

  // Non-interactive `--profile maximum|minimal`: apply the SAME bundle through the
  // shared finalize path (init + config + proxy env + steps + tool-call profile),
  // so a headless run matches the interactive preset exactly. Reproducible.
  if (options.profile === 'maximum' || options.profile === 'minimal') {
    const { finalizeGuidedSetup, detectLocalModel, dockerAvailable } = await import('./guided-setup.js');
    const { maxSelections, minSelections } = await import('./wizard-config.js');
    const { createNonInteractiveUI } = await import('./prompt-ui.js');
    const localModel = await detectLocalModel();
    const hasDocker = dockerAvailable();
    const ctx = { platforms: options.platform ?? ['all'], localModel, hasDocker };
    const selections = options.profile === 'maximum' ? maxSelections(ctx) : minSelections(ctx);
    await finalizeGuidedSetup(cwd, createNonInteractiveUI(), options, selections);
    return;
  }

  const withPatterns = options.patterns !== false;
  const withMemory = options.memory !== false;

  console.log(chalk.bold('\n🚀 Universal Agent Memory Setup\n'));

  // Step 0: back up + extract on the ORIGINAL instruction files, BEFORE init
  // merges/regenerates CLAUDE.md — otherwise extraction would parse the merged
  // file and risk misreading regenerated standard scaffolding as custom content.
  if (options.backup !== false) {
    const b = backupInstructionFiles(cwd);
    if (b.backedUp.length > 0) {
      console.log(chalk.dim(`  Backed up ${b.backedUp.length} instruction file(s) → .uap-backups/${b.date}/`));
    }
  }
  if (options.extract !== false) {
    if (options.extractAuto) {
      const r = await extractAuto(cwd);
      console.log(
        chalk.cyan(
          `  Extracted ${r.extractedPolicies.length} policy(ies) + ${r.extractedSkills.length} skill(s) from custom instructions`
        )
      );
    } else {
      reportOnly(detectCustomSections(cwd));
    }
  }

  // Step 1: Run init (already backed up above → backup:false avoids a redundant pass)
  await initCommand({
    platform: options.platform || ['all'],
    memory: withMemory,
    patterns: withPatterns,
    worktrees: true,
    systemdServices: options.systemdServices,
    projectDir: cwd,
    backup: false,
  });

  await runSetupSteps(cwd, options);
}

/** Self-update preflight (shared by all modes). Non-fatal. */
function maybeSelfUpdate(options: SetupOptions): void {
  if (options.selfUpdate === false) return;
  const suSpinner = ora('Checking for a newer UAP CLI…').start();
  const su = selfUpdateCli();
  if (su.updated) {
    suSpinner.succeed(`Updated UAP CLI ${su.current} → ${su.latest} (re-run uap to use it)`);
  } else if (su.skipped && su.reason) {
    suSpinner.info(`UAP CLI v${su.current} — ${su.reason}`);
  } else {
    suSpinner.succeed(`UAP CLI up to date (v${su.current})`);
  }
}

/**
 * Run the post-init setup steps (Qdrant, consolidation, venv, pattern index,
 * MCP router, delivery-enforcement, hooks, summary). Shared by the scripted
 * path and the guided wizard so neither duplicates the work.
 */
export async function runSetupSteps(cwd: string, options: SetupOptions): Promise<void> {
  const withPatterns = options.patterns !== false;
  const withMemory = options.memory !== false;

  if (!withMemory) {
    console.log(chalk.green('\n✅ Setup complete (memory disabled).\n'));
    return;
  }

  // Step 2: Start Qdrant (try serverless manager first, fall back to docker-compose)
  const qdrantSpinner = ora('Starting Qdrant...').start();
  try {
    // Try serverless Qdrant manager if configured in .uap.json
    let serverlessStarted = false;
    try {
      const { loadUapConfig: loadCfg } = await import('../utils/config-loader.js');
      const uapConfigParsed = loadCfg(cwd);
      const serverlessConfig = uapConfigParsed?.memory?.longTerm?.serverless;
      if (serverlessConfig?.enabled) {
        const { initServerlessQdrant } = await import('../memory/serverless-qdrant.js');
        const manager = initServerlessQdrant(serverlessConfig);
        await manager.ensureLocalRunning();
        serverlessStarted = true;
        qdrantSpinner.succeed('Started Qdrant (serverless)');
      }
    } catch {
      // Serverless not available, fall through
    }

    if (!serverlessStarted) {
      await startServices(cwd);
      qdrantSpinner.succeed('Started Qdrant (docker)');
    }
  } catch {
    qdrantSpinner.warn('Could not start Qdrant (Docker may not be available)');
  }

  // Step 3: Wait for Qdrant healthcheck
  const configPath = join(cwd, '.uap.json');
  let endpoint = 'http://localhost:6333';
  if (existsSync(configPath)) {
    try {
      const config = AgentContextConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
      const ep = config.memory?.longTerm?.endpoint || 'localhost:6333';
      endpoint = ep.startsWith('http') ? ep : `http://${ep}`;
    } catch {
      // use default
    }
  }

  const healthSpinner = ora('Waiting for Qdrant healthcheck...').start();
  const qdrantReady = await isQdrantReachable(endpoint, 15000);
  if (qdrantReady) {
    healthSpinner.succeed('Qdrant is healthy');
  } else {
    healthSpinner.warn('Qdrant not reachable after 15s — pattern indexing will be skipped');
  }

  // Step 3b: Auto-start background memory consolidation
  try {
    const { autoStartConsolidation } = await import('../memory/memory-consolidator.js');
    const stDbPath = join(cwd, 'agents/data/memory/short_term.db');
    if (autoStartConsolidation(stDbPath)) {
      console.log(chalk.green('  Background memory consolidation started'));
    }
  } catch {
    // Non-fatal
  }

  // Step 3c: Auto-promote high-quality daily log entries
  try {
    const { DailyLog } = await import('../memory/daily-log.js');
    const dlDbPath = join(cwd, 'agents/data/memory/short_term.db');
    if (existsSync(dlDbPath)) {
      const dailyLog = new DailyLog(dlDbPath);
      const promoted = dailyLog.autoPromote(0.5);
      if (promoted > 0) {
        console.log(chalk.green(`  Auto-promoted ${promoted} daily log entries`));
      }
      dailyLog.close();
    }
  } catch {
    // Non-fatal
  }

  if (!withPatterns) {
    console.log(chalk.green('\n Setup complete (patterns disabled).\n'));
    return;
  }

  // Step 4: Ensure Python venv (if init didn't already handle it)
  let pythonPath = findPython(cwd);
  if (!pythonPath) {
    const venvSpinner = ora('Creating Python venv...').start();
    pythonPath = ensurePythonVenv(cwd);
    if (pythonPath) {
      venvSpinner.succeed(`Python venv ready (${pythonPath})`);
    } else {
      venvSpinner.warn('Python not available — pattern RAG requires Python 3');
    }
  }

  // Step 5: Index patterns if Qdrant is up and Python is available
  if (qdrantReady && pythonPath) {
    // generateScripts may have already been called by init, but ensure they exist
    try {
      await generateScripts(cwd);
    } catch {
      // non-fatal, init already attempted this
    }

    const indexSpinner = ora('Indexing patterns into Qdrant...').start();
    try {
      await patternsCommand('index');
      indexSpinner.succeed('Patterns indexed');
    } catch {
      indexSpinner.warn('Pattern indexing failed (non-fatal)');
    }
  }

  // Step 6: Setup MCP Router for all platforms
  const mcpSpinner = ora('Configuring MCP Router...').start();
  try {
    await setupMcpRouter({ force: true, verbose: options.verbose });
    mcpSpinner.succeed('MCP Router configured');
  } catch (err) {
    mcpSpinner.warn('MCP Router setup failed: ' + err);
  }

  // Step 6b: Enable delivery-enforcement by default + wire the deliver MCP tool.
  // The policy-gate hook defaults UAP_ENFORCE_DELIVERY=block, so once the policy
  // is installed + enabled here, coding agents are routed through `uap deliver`.
  const deliverSpinner = ora('Enabling delivery-enforcement + wiring deliver tool...').start();
  try {
    const { ensureDeliveryEnforcement, wireDeliverMcp } = await import('./deliver-defaults.js');
    const result = await ensureDeliveryEnforcement();
    wireDeliverMcp(cwd);
    if (result.enabled) {
      deliverSpinner.succeed('delivery-enforcement active (block by default) + deliver tool wired');
    } else {
      deliverSpinner.warn(`delivery-enforcement not enabled: ${result.reason ?? 'unknown'}`);
    }
  } catch (err) {
    deliverSpinner.warn('delivery-enforcement setup failed: ' + err);
  }

  // Step 7: Install policy-gate + lifecycle hooks for all project platforms.
  // Previously setup never installed hooks, so the policy gate was never active
  // until a separate manual `uap hooks install`. (Hermes is global → opt-in via
  // `uap hooks install -t hermes`.)
  const hooksSpinner = ora('Installing policy-gate + lifecycle hooks...').start();
  try {
    const { hooksCommand } = await import('./hooks.js');
    await hooksCommand('install', { projectDir: cwd });
    hooksSpinner.succeed('Hooks installed (run `uap hooks doctor` to verify coverage)');
  } catch (err) {
    hooksSpinner.warn('Hook install failed: ' + err);
  }

  // Step 7b: DESIGN.md — auto-interrogate an existing UI into a design system,
  // then sync the token gate's allow-list so new UI is guided/gated on-token.
  const designSpinner = ora('Configuring DESIGN.md design system…').start();
  try {
    const { findDesignFile, loadDesign, buildAllowList, writeAllowList } = await import('../design/tokens.js');
    if (findDesignFile(cwd)) {
      const loaded = loadDesign(cwd);
      if (loaded) {
        writeAllowList(cwd, buildAllowList(loaded.parsed, loaded.path, cwd));
        designSpinner.succeed('DESIGN.md found — token gate synced (.uap/design-tokens.json)');
      } else {
        designSpinner.info('DESIGN.md present');
      }
    } else {
      const { interrogate, renderDesignMd } = await import('../design/interrogate.js');
      const result = interrogate(cwd);
      if (result.stats.source !== 'none') {
        const { writeFileSync } = await import('fs');
        const { join: pjoin } = await import('path');
        const outPath = pjoin(cwd, 'DESIGN.md');
        const md = renderDesignMd(result);
        writeFileSync(outPath, md);
        const { parseDesignMd } = await import('../design/tokens.js');
        writeAllowList(cwd, buildAllowList(parseDesignMd(md), outPath, cwd));
        designSpinner.succeed(
          `Auto-interrogated DESIGN.md from existing UI (${result.stats.colorsFound} colors) — refine + \`uap design lint\``
        );
      } else {
        designSpinner.info('No UI design signals — skipping DESIGN.md (run `uap design interrogate` later)');
      }
    }
  } catch (err) {
    designSpinner.warn('DESIGN.md setup skipped: ' + err);
  }

  // Step 8: Print summary
  console.log('');
  printSummary(cwd, qdrantReady, pythonPath);
}

function printSummary(cwd: string, qdrantReady: boolean, pythonPath: string | null): void {
  const checks = [
    { label: 'Created .uap.json', ok: existsSync(join(cwd, '.uap.json')) },
    { label: 'Directory structure ready', ok: existsSync(join(cwd, 'agents/data/memory')) },
    {
      label: 'Memory database initialized',
      ok: existsSync(join(cwd, 'agents/data/memory/short_term.db')),
    },
    {
      label: 'Generated CLAUDE.md',
      ok: existsSync(join(cwd, 'CLAUDE.md')) || existsSync(join(cwd, 'AGENT.md')),
    },
    { label: 'Qdrant available', ok: qdrantReady },
    { label: 'Python venv ready', ok: !!pythonPath },
    { label: 'Deliver tool wired (.mcp.json)', ok: existsSync(join(cwd, '.mcp.json')) },
    {
      label: 'Pattern scripts generated',
      ok: existsSync(join(cwd, 'agents/scripts/index_patterns_to_qdrant.py')),
    },
  ];

  for (const check of checks) {
    const icon = check.ok ? chalk.green('✓') : chalk.yellow('○');
    console.log(`  ${icon} ${check.label}`);
  }

  const allGreen = checks.every((c) => c.ok);
  if (allGreen) {
    console.log(chalk.green('\n✅ Setup complete! Everything is ready.\n'));
  } else {
    console.log(chalk.yellow('\n⚠ Setup complete with some optional steps skipped.\n'));
  }

  console.log(chalk.bold('Your AI assistant will now:'));
  console.log('  • Query memory before starting work');
  if (pythonPath && qdrantReady) {
    console.log('  • Retrieve relevant patterns on-demand (~12K tokens saved)');
  }
  console.log('  • Store learnings for future sessions');
  console.log('');
}
