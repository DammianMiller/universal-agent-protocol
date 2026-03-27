import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename_init = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename_init);
import { analyzeProject } from '../analyzers/index.js';
import { generateClaudeMd } from '../generators/claude-md.js';
import { mergeClaudeMd } from '../utils/merge-claude-md.js';
import { initializeMemoryDatabase } from '../memory/short-term/schema.js';
import { CoordinationDatabase, getDefaultCoordinationDbPath } from '../coordination/database.js';
import { initializeCacheFromDb, autoWarmCache } from '../memory/speculative-cache.js';
import { ServerlessQdrantManager } from '../memory/serverless-qdrant.js';
import { generateScripts, ensurePythonVenv, findPython } from './patterns.js';
import { isQdrantReachable } from './memory.js';
import { installSystemdUserServices } from './systemd-services.js';
import type { AgentContextConfig, Platform } from '../types/index.js';

export interface InitOptions {
  platform: string[];
  web?: boolean;
  memory?: boolean; // --no-memory sets this to false
  worktrees?: boolean; // --no-worktrees sets this to false
  patterns?: boolean; // --patterns / --no-patterns (auto-detect by default)
  pipelineOnly?: boolean; // --pipeline-only enables infrastructure policy
  systemdServices?: boolean; // --systemd-services scaffolds user services for llama/proxy
  force?: boolean;
  projectDir?: string; // -d, --project-dir to override cwd
}

const PLATFORM_MAP: Record<string, Platform> = {
  claude: 'claudeCode',
  factory: 'factory',
  vscode: 'vscode',
  opencode: 'opencode',
  codex: 'codex',
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
    ? ['claudeCode', 'factory', 'vscode', 'opencode', 'codex']
    : (options.platform.map((p) => PLATFORM_MAP[p] || p) as Platform[]);

  // Load existing config if present to preserve user customizations
  let existingConfig: Partial<AgentContextConfig> = {};
  if (configExists) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Ignore parse errors, will create fresh config
    }
  }

  // Analyze project
  const spinner = ora('Analyzing project structure...').start();
  let analysis;
  try {
    analysis = await analyzeProject(cwd);
    if (!analysis) {
      spinner.warn('Project analysis returned undefined. Using defaults.');
      analysis = {
        projectName: existingConfig.project?.name || 'unknown-project',
        description: existingConfig.project?.description || '',
        defaultBranch: existingConfig.project?.defaultBranch || 'main',
        languages: [],
        frameworks: [],
        packageManagers: [],
        directories: {
          source: [],
          tests: [],
          infrastructure: [],
          docs: [],
          workflows: [],
        },
        urls: [],
        components: [],
        commands: {},
        databases: [],
        infrastructure: {
          cloud: [],
        },
        existingDroids: [],
        existingSkills: [],
        existingCommands: [],
        troubleshootingHints: [],
        keyFiles: [],
        securityNotes: [],
      };
    }
    spinner.succeed(`Analyzed: ${analysis.projectName}`);
  } catch (error) {
    spinner.fail('Failed to analyze project');
    console.error(chalk.red(error));
    return;
  }

  // Display analysis summary
  console.log(chalk.dim('\nDetected:'));
  console.log(
    chalk.dim(`  Languages: ${(analysis.languages || []).join(', ') || 'none detected'}`)
  );
  console.log(
    chalk.dim(`  Frameworks: ${(analysis.frameworks || []).join(', ') || 'none detected'}`)
  );
  console.log(
    chalk.dim(
      `  Databases: ${(analysis.databases || []).map((d) => d.type).join(', ') || 'none detected'}`
    )
  );

  // Auto-enable memory and worktrees unless explicitly disabled via --no-memory/--no-worktrees
  // No prompts - just works
  const withMemory = options.memory !== false;
  const withWorktrees = options.worktrees !== false;
  const withPipelineOnly = options.pipelineOnly === true;

  // Patterns: default to enabled when Qdrant is available, otherwise check existing config
  const withPatterns =
    options.patterns !== undefined
      ? options.patterns
      : (withMemory && existingConfig.memory?.longTerm?.provider === 'qdrant') ||
        existingConfig.memory?.patternRag?.enabled === true;

  // Build configuration - merge with existing to preserve user customizations
  const config: AgentContextConfig = {
    $schema:
      'https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/schema.json',
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
      codex: { enabled: platforms.includes('codex') },
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

  // Ensure Factory config exists with default context level
  if (platforms.includes('factory')) {
    const factoryDir = join(cwd, '.factory');
    if (!existsSync(factoryDir)) {
      mkdirSync(factoryDir, { recursive: true });
    }

    const factoryConfigPath = join(factoryDir, 'config.json');
    let existingFactoryConfig: Record<string, unknown> = {};
    if (existsSync(factoryConfigPath)) {
      try {
        existingFactoryConfig = JSON.parse(readFileSync(factoryConfigPath, 'utf-8'));
      } catch {
        existingFactoryConfig = {};
      }
    }

    const factoryConfig = {
      name: config.project.name,
      version: config.version,
      defaultBranch: config.project.defaultBranch || 'main',
      memory: {
        enabled: config.memory?.shortTerm?.enabled ?? true,
        path: config.memory?.shortTerm?.path || 'agents/data/memory/short_term.db',
      },
      worktrees: {
        enabled: true,
        directory: config.worktrees?.directory || '.worktrees',
      },
      contextLevel: (existingFactoryConfig.contextLevel as string) || 'quiet',
    };

    writeFileSync(factoryConfigPath, JSON.stringify(factoryConfig, null, 2));
  }

  // Create directory structure (never deletes existing)
  const dirsSpinner = ora('Creating directory structure...').start();
  try {
    const dirs = [
      'agents/data/memory',
      'agents/data/coordination',
      'agents/data/screenshots',
      'agents/scripts',
    ];

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

      // Wire speculative cache startup (OPT A1: was exported but never called)
      const cacheSpinner = ora('Warming speculative cache...').start();
      try {
        const { entriesLoaded } = await initializeCacheFromDb(fullDbPath);
        const warmed = autoWarmCache();
        cacheSpinner.succeed(
          `Cache warmed: ${entriesLoaded} from DB + ${warmed} high-value patterns`
        );
      } catch {
        cacheSpinner.warn('Cache warm-up skipped (non-fatal)');
      }
    } catch (error) {
      memorySpinner.fail('Failed to initialize memory database');
      console.error(chalk.red(error));
    }
  }

  // Initialize coordination database for multi-agent support
  if (withMemory) {
    const coordSpinner = ora('Initializing coordination database...').start();
    try {
      const coordDbPath = join(cwd, getDefaultCoordinationDbPath());
      CoordinationDatabase.getInstance(coordDbPath);
      CoordinationDatabase.resetInstance(); // Release the singleton after init
      coordSpinner.succeed('Coordination database initialized');
    } catch (error) {
      coordSpinner.fail('Failed to initialize coordination database');
      console.error(chalk.red(error));
    }

    // B3: Pre-warm Qdrant if configured (was schema-only, now wired)
    const qdrantServerless = existingConfig.memory?.longTerm?.serverless;
    if (qdrantServerless?.enabled) {
      const prewarmSpinner = ora('Pre-warming Qdrant...').start();
      try {
        const manager = new ServerlessQdrantManager(qdrantServerless);
        await manager.ensureLocalRunning();
        prewarmSpinner.succeed('Qdrant pre-warmed and ready');
      } catch {
        prewarmSpinner.warn('Qdrant pre-warming skipped (non-fatal)');
      }
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
  if (options.systemdServices === true) {
    const systemdSpinner = ora('Installing optional user systemd services...').start();
    try {
      const result = installSystemdUserServices(cwd, { force: options.force === true });
      systemdSpinner.succeed('Installed user systemd service scaffolding');
      console.log(chalk.dim(`  Installed/updated: ${result.installed.length}`));
      if (result.skipped.length > 0) {
        console.log(chalk.dim(`  Preserved existing: ${result.skipped.length}`));
      }
      console.log(chalk.dim('  Next: systemctl --user daemon-reload'));
      console.log(
        chalk.dim(
          '  Next: systemctl --user enable --now uap-llama-server.service uap-anthropic-proxy.service'
        )
      );
    } catch (error) {
      systemdSpinner.fail('Failed to install optional user systemd services');
      console.error(chalk.red(error));
    }
  }

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
    codex: ['.codex', '.agents/skills'],
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

  // Codex CLI: generate AGENTS.md, config.toml, and skills
  if (platform === 'codex') {
    // Generate AGENTS.md for Codex with UAP integration instructions
    const agentsMdPath = join(cwd, 'AGENTS.md');
    if (!existsSync(agentsMdPath)) {
      const agentsMdContent = [
        '# AGENTS.md - UAP Integration for Codex CLI',
        '',
        '## Universal Agent Protocol (UAP)',
        '',
        'This project uses UAP for persistent memory, multi-agent coordination,',
        'pattern libraries, and policy enforcement across sessions.',
        '',
        '## Session Start',
        '',
        'At the beginning of each session, run the following to load context:',
        '',
        '```',
        'bash .codex/hooks/session-start.sh',
        '```',
        '',
        '## Memory System',
        '',
        'Use the UAP memory system to query and store knowledge:',
        '',
        '- **Query memory**: `uap memory query "<search terms>"`',
        '- **Store lesson**: `uap memory store "<content>" --importance <1-10>`',
        '- **Memory status**: `uap memory status`',
        '',
        '## Worktree Workflow',
        '',
        'All code changes MUST use worktrees for safe git workflow:',
        '',
        '1. `uap worktree create <slug>` - Create isolated worktree',
        '2. Make changes in the worktree directory',
        '3. `uap worktree cleanup <id>` - Clean up after merge',
        '4. `uap worktree list` - List active worktrees',
        '',
        '## Pattern Library',
        '',
        'Query task-relevant patterns before starting work:',
        '',
        '- `uap patterns query "<task description>"`',
        '',
        '## Task Management',
        '',
        '- `uap task create "<description>"` - Create a new task',
        '- `uap task list` - List current tasks',
        '- `uap task ready` - Check task readiness',
        '',
        '## Agent Coordination',
        '',
        '- `uap agent status` - Show agent coordination status',
        '- `uap dashboard` - Show UAP session dashboard',
        '',
        '## Pre-Compact',
        '',
        'Before context compaction, save state:',
        '',
        '```',
        'bash .codex/hooks/pre-compact.sh',
        '```',
        '',
      ].join('\n');
      writeFileSync(agentsMdPath, agentsMdContent);
    }

    // Generate .codex/config.toml with UAP MCP server
    const codexDir = join(cwd, '.codex');
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }
    const configTomlPath = join(codexDir, 'config.toml');
    if (!existsSync(configTomlPath)) {
      const configToml = [
        '# Codex CLI configuration with UAP integration',
        '# Generated by: uap init -p codex',
        '',
        '# UAP MCP Server - provides memory, worktree, pattern, and task tools',
        '[mcp_servers.uap]',
        'command = "uap"',
        'args = ["mcp", "serve"]',
        'startup_timeout_sec = 15',
        'tool_timeout_sec = 120',
        '',
      ].join('\n');
      writeFileSync(configTomlPath, configToml);
    }

    // Generate .codex/hooks directory with session scripts
    const codexHooksDir = join(codexDir, 'hooks');
    if (!existsSync(codexHooksDir)) {
      mkdirSync(codexHooksDir, { recursive: true });
    }

    // Copy hook scripts from templates if available, otherwise generate
    const templateHooksDir = join(__dirname, '../../templates/hooks');
    const hookFiles = ['session-start.sh', 'pre-compact.sh'];
    for (const file of hookFiles) {
      const dest = join(codexHooksDir, file);
      if (!existsSync(dest)) {
        const src = join(templateHooksDir, file);
        if (existsSync(src)) {
          copyFileSync(src, dest);
          chmodSync(dest, 0o755);
        }
      }
    }

    // Generate .codex/.gitignore
    const codexGitignorePath = join(codexDir, '.gitignore');
    if (!existsSync(codexGitignorePath)) {
      writeFileSync(codexGitignorePath, 'config.toml\n');
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
