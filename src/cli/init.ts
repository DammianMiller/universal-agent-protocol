import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { analyzeProject } from '../analyzers/index.js';
import { generateClaudeMd } from '../generators/claude-md.js';
import { mergeClaudeMd } from '../utils/merge-claude-md.js';
import { initializeMemoryDatabase } from '../memory/short-term/schema.js';
import { generateScripts, ensurePythonVenv, findPython } from './patterns.js';
import { isQdrantReachable } from './memory.js';
import type { AgentContextConfig, Platform } from '../types/index.js';

export interface InitOptions {
  platform: string[];
  web?: boolean;
  memory?: boolean; // --no-memory sets this to false
  worktrees?: boolean; // --no-worktrees sets this to false
  patterns?: boolean; // --patterns / --no-patterns (auto-detect by default)
  pipelineOnly?: boolean; // --pipeline-only enables infrastructure policy
  force?: boolean;
  projectDir?: string; // -d, --project-dir to override cwd
}

const PLATFORM_MAP: Record<string, Platform> = {
  claude: 'claudeCode',
  factory: 'factory',
  vscode: 'vscode',
  opencode: 'opencode',
};

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = options.projectDir || process.cwd();
  const configPath = join(cwd, '.uap.json');

  console.log(chalk.bold('\n🚀 Universal Agent Memory Initialization\n'));

  // Check for existing config - if exists and not --force, just update
  const configExists = existsSync(configPath);
  if (configExists && !options.force) {
    console.log(chalk.dim('Existing configuration found. Updating...\n'));
  }

  // Determine platforms - default to all if not specified
  const platforms: Platform[] = options.platform.includes('all')
    ? ['claudeCode', 'factory', 'vscode', 'opencode']
    : (options.platform.map((p) => PLATFORM_MAP[p] || p) as Platform[]);

  // Analyze project
  const spinner = ora('Analyzing project structure...').start();
  let analysis;
  try {
    analysis = await analyzeProject(cwd);
    spinner.succeed(`Analyzed: ${analysis.projectName}`);
  } catch (error) {
    spinner.fail('Failed to analyze project');
    console.error(chalk.red(error));
    return;
  }

  // Display analysis summary
  console.log(chalk.dim('\nDetected:'));
  console.log(chalk.dim(`  Languages: ${analysis.languages.join(', ') || 'none detected'}`));
  console.log(chalk.dim(`  Frameworks: ${analysis.frameworks.join(', ') || 'none detected'}`));
  console.log(
    chalk.dim(`  Databases: ${analysis.databases.map((d) => d.type).join(', ') || 'none detected'}`)
  );

  // Auto-enable memory and worktrees unless explicitly disabled via --no-memory/--no-worktrees
  // No prompts - just works
  const withMemory = options.memory !== false;
  const withWorktrees = options.worktrees !== false;
  const withPipelineOnly = options.pipelineOnly === true;

  // Load existing config if present to preserve user customizations
  let existingConfig: Partial<AgentContextConfig> = {};
  if (configExists) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Ignore parse errors, will create fresh config
    }
  }

  // Patterns: auto-detect from existing config if not explicitly set
  const withPatterns =
    options.patterns !== undefined
      ? options.patterns
      : existingConfig.memory?.patternRag?.enabled === true ||
        (withMemory && existingConfig.memory?.longTerm?.provider === 'qdrant');

  // Build configuration - merge with existing to preserve user customizations
  const config: AgentContextConfig = {
    $schema:
      'https://raw.githubusercontent.com/DammianMiller/universal-agent-memory/main/schema.json',
    version: '1.0.0',
    project: {
      name: existingConfig.project?.name || analysis.projectName,
      description: existingConfig.project?.description || analysis.description,
      defaultBranch: existingConfig.project?.defaultBranch || analysis.defaultBranch,
    },
    platforms: existingConfig.platforms || {
      claudeCode: { enabled: platforms.includes('claudeCode') },
      factory: { enabled: platforms.includes('factory') },
      vscode: { enabled: platforms.includes('vscode') },
      opencode: { enabled: platforms.includes('opencode') },
    },
    memory: withMemory
      ? {
          shortTerm: {
            enabled: true,
            path: existingConfig.memory?.shortTerm?.path || './agents/data/memory/short_term.db',
            // Only set webDatabase if --web flag is used (for web platforms like claude.ai)
            ...(options.web
              ? {
                  webDatabase:
                    existingConfig.memory?.shortTerm?.webDatabase || 'agent_context_memory',
                }
              : {}),
            maxEntries: existingConfig.memory?.shortTerm?.maxEntries || 50,
          },
          longTerm: {
            enabled: true,
            provider: existingConfig.memory?.longTerm?.provider || 'qdrant',
            endpoint: existingConfig.memory?.longTerm?.endpoint || 'localhost:6333',
            collection: existingConfig.memory?.longTerm?.collection || 'agent_memory',
            embeddingModel: existingConfig.memory?.longTerm?.embeddingModel || 'all-MiniLM-L6-v2',
          },
          ...(withPatterns
            ? {
                patternRag: {
                  enabled: true,
                  collection: existingConfig.memory?.patternRag?.collection || 'agent_patterns',
                  embeddingModel:
                    existingConfig.memory?.patternRag?.embeddingModel || 'all-MiniLM-L6-v2',
                  vectorSize: existingConfig.memory?.patternRag?.vectorSize || 384,
                  scoreThreshold: existingConfig.memory?.patternRag?.scoreThreshold || 0.35,
                  topK: existingConfig.memory?.patternRag?.topK || 2,
                  indexScript:
                    existingConfig.memory?.patternRag?.indexScript ||
                    './agents/scripts/index_patterns_to_qdrant.py',
                  queryScript:
                    existingConfig.memory?.patternRag?.queryScript ||
                    './agents/scripts/query_patterns.py',
                  sourceFile: existingConfig.memory?.patternRag?.sourceFile || 'CLAUDE.md',
                  sourceFiles: existingConfig.memory?.patternRag?.sourceFiles || [],
                  skillsDir: existingConfig.memory?.patternRag?.skillsDir,
                  maxBodyChars: existingConfig.memory?.patternRag?.maxBodyChars || 400,
                },
              }
            : {}),
        }
      : existingConfig.memory,
    worktrees: withWorktrees
      ? {
          enabled: true,
          directory: existingConfig.worktrees?.directory || '.worktrees',
          branchPrefix: existingConfig.worktrees?.branchPrefix || 'feature/',
          autoCleanup: existingConfig.worktrees?.autoCleanup ?? true,
        }
      : existingConfig.worktrees,
    droids: existingConfig.droids || [],
    commands: existingConfig.commands || [],
    template: {
      extends: existingConfig.template?.extends || 'default',
      sections: {
        memorySystem: withMemory,
        browserUsage: true,
        decisionLoop: true,
        worktreeWorkflow: withWorktrees,
        troubleshooting: true,
        augmentedCapabilities: true,
        pipelineOnly: withPipelineOnly,
        benchmark: false,
        // codeField enabled by default in template v8.0
        ...existingConfig.template?.sections,
      },
    },
  };

  // Write configuration
  const configSpinner = ora('Writing configuration...').start();
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    configSpinner.succeed(configExists ? 'Updated .uap.json' : 'Created .uap.json');
  } catch (error) {
    configSpinner.fail('Failed to write configuration');
    console.error(chalk.red(error));
    return;
  }

  // Create directory structure (never deletes existing)
  const dirsSpinner = ora('Creating directory structure...').start();
  try {
    const dirs = ['agents/data/memory', 'agents/data/screenshots', 'agents/scripts'];

    if (withWorktrees) {
      dirs.push('.worktrees');
    }

    for (const dir of dirs) {
      const fullPath = join(cwd, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
    }
    dirsSpinner.succeed('Directory structure ready');
  } catch (error) {
    dirsSpinner.fail('Failed to create directories');
    console.error(chalk.red(error));
  }

  if (withMemory) {
    const memorySpinner = ora('Initializing memory database...').start();
    try {
      const dbPath = config.memory?.shortTerm?.path || './agents/data/memory/short_term.db';
      const fullDbPath = join(cwd, dbPath);
      initializeMemoryDatabase(fullDbPath);
      memorySpinner.succeed('Memory database initialized');
    } catch (error) {
      memorySpinner.fail('Failed to initialize memory database');
      console.error(chalk.red(error));
    }
  }

  // Pattern RAG scaffolding (best-effort, don't fail init)
  if (withPatterns) {
    const scriptsSpinner = ora('Generating pattern scripts...').start();
    try {
      await generateScripts(cwd);
      scriptsSpinner.succeed('Generated pattern scripts');
    } catch {
      scriptsSpinner.warn('Could not generate pattern scripts (non-fatal)');
    }

    const venvSpinner = ora('Setting up Python venv...').start();
    const pythonPath = findPython(cwd) || ensurePythonVenv(cwd);
    if (pythonPath) {
      venvSpinner.succeed(`Python ready (${pythonPath})`);

      // Attempt to index patterns if Qdrant is reachable
      const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
      const qdrantUp = await isQdrantReachable(
        endpoint.startsWith('http') ? endpoint : `http://${endpoint}`
      );
      if (qdrantUp) {
        const indexSpinner = ora('Indexing patterns into Qdrant...').start();
        try {
          const { execFileSync } = await import('child_process');
          const indexScript =
            config.memory?.patternRag?.indexScript ||
            './agents/scripts/index_patterns_to_qdrant.py';
          const scriptPath = join(cwd, indexScript);
          if (existsSync(scriptPath)) {
            execFileSync(pythonPath, [scriptPath], { cwd, stdio: 'pipe', timeout: 120000 });
            indexSpinner.succeed('Patterns indexed into Qdrant');
          } else {
            indexSpinner.warn('Index script not found, skipping indexing');
          }
        } catch {
          indexSpinner.warn('Could not index patterns (non-fatal)');
        }
      } else {
        console.log(chalk.dim('  Qdrant not reachable — skipping pattern indexing'));
        console.log(chalk.dim('  Run `uap memory start` then `uap patterns index` later'));
      }
    } else {
      venvSpinner.warn('Python not available — skipping venv setup');
      console.log(chalk.dim('  Install Python 3 to enable pattern RAG'));
    }
  }

  // Generate/Update CLAUDE.md - always merge, never overwrite
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  const agentMdPath = join(cwd, 'AGENT.md');
  const claudeMdExists = existsSync(claudeMdPath);
  const agentMdExists = existsSync(agentMdPath);

  let existingContent: string | undefined;
  let targetPath = claudeMdPath;

  // Read existing content if present
  if (claudeMdExists) {
    existingContent = readFileSync(claudeMdPath, 'utf-8');
    targetPath = claudeMdPath;
  } else if (agentMdExists) {
    existingContent = readFileSync(agentMdPath, 'utf-8');
    targetPath = agentMdPath;
  }

  const claudeSpinner = ora(`${existingContent ? 'Updating' : 'Generating'} CLAUDE.md...`).start();
  try {
    const newClaudeMd = await generateClaudeMd(analysis, config);
    // Always merge to preserve user content - never lose information
    const claudeMd = existingContent ? mergeClaudeMd(existingContent, newClaudeMd) : newClaudeMd;
    writeFileSync(targetPath, claudeMd);
    claudeSpinner.succeed(
      `${existingContent ? 'Updated' : 'Generated'} ${targetPath.endsWith('CLAUDE.md') ? 'CLAUDE.md' : 'AGENT.md'}`
    );
    if (existingContent) {
      console.log(chalk.dim('  Merged with existing content - no information lost'));
    }
  } catch (error) {
    claudeSpinner.fail(`Failed to ${existingContent ? 'update' : 'generate'} CLAUDE.md`);
    console.error(chalk.red(error));
  }

  // Platform-specific setup (create directories only, never delete)
  for (const platform of platforms) {
    const platformSpinner = ora(`Setting up ${platform}...`).start();
    try {
      await setupPlatform(cwd, platform, config);
      platformSpinner.succeed(`Set up ${platform}`);
    } catch (error) {
      platformSpinner.fail(`Failed to set up ${platform}`);
      console.error(chalk.red(error));
    }
  }

  // Final summary - no next steps needed, it just works
  console.log(chalk.green('\n✅ Initialization complete!\n'));

  console.log(chalk.bold('What happens now:\n'));
  console.log('  Your AI assistant automatically reads CLAUDE.md and:');
  console.log('  • Queries memory before starting work (endless context)');
  console.log('  • Routes tasks to specialized droids (optimal quality)');
  console.log('  • Uses worktrees for all changes (safe git workflow)');
  console.log('  • Applies Code Field for better code (100% assumption stating)');
  console.log('  • Stores learnings for future sessions (knowledge accumulation)');
  console.log('');

  if (withMemory) {
    // Check if memory DB exists
    const dbPath = config.memory?.shortTerm?.path || './agents/data/memory/short_term.db';
    const fullDbPath = join(cwd, dbPath);
    if (existsSync(fullDbPath)) {
      console.log(chalk.dim('Memory database found - existing data preserved'));
    } else {
      console.log(chalk.dim('Memory database will be created on first use'));
    }
    console.log(
      chalk.dim('Optional: Run `uap memory start` for semantic search (requires Docker)')
    );
  }

  console.log('');
}

async function setupPlatform(
  cwd: string,
  platform: Platform,
  _config: AgentContextConfig
): Promise<void> {
  const platformDirs: Record<Platform, string[]> = {
    claudeCode: ['.claude/agents', '.claude/commands'],
    factory: [
      '.factory/droids',
      '.factory/commands',
      '.factory/skills',
      '.factory/scripts',
      '.factory/templates',
    ],
    vscode: ['.vscode'],
    opencode: ['.opencode/plugin'],
    claudeWeb: [], // Web platforms don't need local directories
    factoryWeb: [],
  };

  const dirs = platformDirs[platform] || [];
  for (const dir of dirs) {
    const fullPath = join(cwd, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // OpenCode: generate plugin package.json if missing
  if (platform === 'opencode') {
    const pkgPath = join(cwd, '.opencode', 'package.json');
    if (!existsSync(pkgPath)) {
      writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            dependencies: {
              '@opencode-ai/plugin': '^1.2.24',
            },
          },
          null,
          2
        )
      );
    }

    const gitignorePath = join(cwd, '.opencode', '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, 'node_modules\npackage.json\nbun.lock\n.gitignore\n');
    }
  }
}
