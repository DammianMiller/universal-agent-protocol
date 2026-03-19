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

interface SetupOptions {
  platform?: string[];
  patterns?: boolean; // --no-patterns to skip
  memory?: boolean; // --no-memory to skip
  verbose?: boolean; // --verbose for detailed output
  projectDir?: string; // -d, --project-dir to override cwd
  interactive?: boolean; // -i, --interactive for wizard mode
}

/**
 * One-command setup: init + start services + venv + index patterns.
 * Chains existing commands so everything "just works".
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  // Interactive wizard mode
  if (options.interactive) {
    const { runSetupWizard } = await import('./setup-wizard.js');
    return runSetupWizard();
  }

  // Default to current working directory unless explicitly overridden
  const defaultProjectDir = process.cwd();
  const cwd = options.projectDir || defaultProjectDir;
  const withPatterns = options.patterns !== false;
  const withMemory = options.memory !== false;

  console.log(chalk.bold('\n🚀 Universal Agent Memory Setup\n'));

  // Step 1: Run init (creates config, dirs, CLAUDE.md, memory DB, pattern scripts)
  await initCommand({
    platform: options.platform || ['all'],
    memory: withMemory,
    patterns: withPatterns,
    worktrees: true,
    projectDir: cwd,
  });

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
      const uapConfigRaw = existsSync(join(cwd, '.uap.json'))
        ? JSON.parse(readFileSync(join(cwd, '.uap.json'), 'utf-8'))
        : null;
      const serverlessConfig = uapConfigRaw?.memory?.longTerm?.serverless;
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

  // Step 7: Print summary
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
