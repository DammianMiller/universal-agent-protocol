import chalk from 'chalk';
import ora from 'ora';
// inquirer lazy-loaded via shared utility (saves ~500ms startup)
import { ensureInquirer as _ensureInquirer } from '../utils/lazy-imports.js';
let inquirer: typeof import('inquirer').default;
async function ensureInquirer(): Promise<void> {
  inquirer = await _ensureInquirer();
}
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { analyzeProject } from '../analyzers/index.js';
import { generateClaudeMd } from '../generators/claude-md.js';
import { AgentContextConfigSchema } from '../types/index.js';
import { mergeClaudeMd, validateMerge } from '../utils/merge-claude-md.js';
import type { AgentContextConfig, Platform } from '../types/index.js';

interface GenerateOptions {
  force?: boolean;
  dryRun?: boolean;
  platform?: string;
  web?: boolean;
  pipelineOnly?: boolean;
  template?: string;
  sections?: string;
}

interface DependencyStatus {
  git: boolean;
  docker: boolean;
  node: boolean;
  qdrant: boolean;
}

function checkDependencies(): DependencyStatus {
  const status: DependencyStatus = {
    git: false,
    docker: false,
    node: true, // We're running, so Node exists
    qdrant: false,
  };

  try {
    execSync('git --version', { stdio: 'pipe' });
    status.git = true;
  } catch {
    // git not found
  }

  try {
    execSync('docker --version', { stdio: 'pipe' });
    status.docker = true;

    // Check if Qdrant container is running
    try {
      const output = execSync('docker ps --filter "name=qdrant" --format "{{.Names}}"', {
        stdio: 'pipe',
      }).toString();
      status.qdrant = output.includes('qdrant');
    } catch {
      // docker ps failed
    }
  } catch {
    // docker not found
  }

  return status;
}

// printDependencyHelp removed — was exported but never called from any consumer

export async function generateCommand(options: GenerateOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, '.uap.json');

  // Check dependencies
  const deps = checkDependencies();

  if (!deps.git) {
    console.error(chalk.red('\n❌ Git is required but not found.'));
    console.log(chalk.dim('  Install Git: https://git-scm.com/downloads\n'));
    process.exit(1);
  }

  console.log(chalk.bold('\n📝 Generate Agent Context Files\n'));

  // Load config if exists
  let config: AgentContextConfig;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = AgentContextConfigSchema.parse(raw);
      console.log(chalk.dim(`Using config from .uap.json`));
    } catch (error) {
      console.error(chalk.red('Invalid .uap.json configuration'));
      console.error(error);
      return;
    }
  } else {
    console.log(
      chalk.yellow('No .uap.json found. Run `uap init` first, or generating with defaults.')
    );
    config = {
      version: '1.0.0',
      project: {
        name: 'Unknown Project',
        defaultBranch: 'main',
      },
      template: {
        extends: 'default',
      },
    };
  }

  if (options.template) {
    config.template = { ...(config.template || {}), extends: options.template };
  }

  if (options.sections) {
    const normalizedSections = options.sections
      .split(',')
      .map((section) => section.trim())
      .filter(Boolean);

    const defaultSections = {
      memorySystem: false,
      browserUsage: false,
      decisionLoop: false,
      worktreeWorkflow: false,
      troubleshooting: false,
      augmentedCapabilities: false,
      pipelineOnly: false,
      benchmark: false,
    };

    const sectionMap: Record<string, keyof typeof defaultSections> = {
      memorysystem: 'memorySystem',
      browserusage: 'browserUsage',
      decisionloop: 'decisionLoop',
      worktreeworkflow: 'worktreeWorkflow',
      troubleshooting: 'troubleshooting',
      augmentedcapabilities: 'augmentedCapabilities',
      pipelineonly: 'pipelineOnly',
      benchmark: 'benchmark',
    };

    const sections = normalizedSections.reduce((acc, name) => {
      const key = sectionMap[name.replace(/[^a-z]/gi, '').toLowerCase()];
      if (key) acc[key] = true;
      return acc;
    }, { ...defaultSections });

    config.template = {
      ...(config.template || { extends: 'default' }),
      sections,
    };
  }

  // Analyze project
  const spinner = ora('Analyzing project...').start();
  let analysis;
  try {
    analysis = await analyzeProject(cwd);
    spinner.succeed(`Analyzed: ${analysis.projectName}`);
  } catch (error) {
    spinner.fail('Failed to analyze project');
    console.error(chalk.red(error));
    return;
  }

  // Determine target file based on --web flag
  const isWebPlatform = options.web === true;
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  const agentMdPath = join(cwd, 'AGENT.md');
  const claudeMdExists = existsSync(claudeMdPath);
  const agentMdExists = existsSync(agentMdPath);

  let existingContent: string | undefined;
  // Use AGENT.md when --web flag is passed, CLAUDE.md otherwise
  let targetPath = isWebPlatform ? agentMdPath : claudeMdPath;
  let targetFileName = isWebPlatform ? 'AGENT.md' : 'CLAUDE.md';

  // Check if target file or alternate file exists
  const targetExists = existsSync(targetPath);
  const alternateExists = isWebPlatform ? claudeMdExists : agentMdExists;

  if ((targetExists || alternateExists) && !options.force && !options.dryRun) {
    // Read existing content from target or alternate file
    if (targetExists) {
      existingContent = readFileSync(targetPath, 'utf-8');
    } else if (alternateExists) {
      // Read from alternate file but will write to target
      const alternatePath = isWebPlatform ? claudeMdPath : agentMdPath;
      existingContent = readFileSync(alternatePath, 'utf-8');
      console.log(
        chalk.dim(`Migrating ${isWebPlatform ? 'CLAUDE.md' : 'AGENT.md'} to ${targetFileName}`)
      );
    }

    await ensureInquirer();
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: `${targetFileName} ${targetExists ? 'already exists' : 'will be created'}. What would you like to do?`,
        choices: [
          { name: 'Merge with existing content (recommended)', value: 'merge' },
          { name: 'Overwrite completely', value: 'overwrite' },
          { name: 'Cancel', value: 'cancel' },
        ],
        default: 'merge',
      },
    ]);

    if (action === 'cancel') {
      console.log(chalk.yellow('Generation cancelled.'));
      return;
    }

    if (action === 'overwrite') {
      existingContent = undefined;
    }
  }

  // Apply --pipeline-only flag to config sections if provided
  const pipelineOnlyEnabled =
    options.pipelineOnly || config.template?.sections?.pipelineOnly || false;

  // Override config based on flags
  // --web: set webDatabase to trigger web platform detection
  // --pipeline-only: enable pipeline-only infrastructure policy
  const effectiveConfig: AgentContextConfig = {
    ...config,
    memory: isWebPlatform
      ? {
          ...config.memory,
          shortTerm: {
            enabled: config.memory?.shortTerm?.enabled ?? true,
            path: config.memory?.shortTerm?.path ?? './agents/data/memory/short_term.db',
            webDatabase: 'agentContext',
            maxEntries: config.memory?.shortTerm?.maxEntries ?? 50,
            forceDesktop: false,
          },
        }
      : {
          // Desktop mode: ensure forceDesktop is true to override any webDatabase in config
          ...config.memory,
          shortTerm: config.memory?.shortTerm
            ? {
                ...config.memory.shortTerm,
                forceDesktop: true, // Force desktop mode regardless of config
              }
            : undefined,
        },
    template: pipelineOnlyEnabled
      ? {
          extends: config.template?.extends ?? 'default',
          sections: {
            memorySystem: config.template?.sections?.memorySystem ?? true,
            browserUsage: config.template?.sections?.browserUsage ?? true,
            decisionLoop: config.template?.sections?.decisionLoop ?? true,
            worktreeWorkflow: config.template?.sections?.worktreeWorkflow ?? true,
            troubleshooting: config.template?.sections?.troubleshooting ?? true,
            augmentedCapabilities: config.template?.sections?.augmentedCapabilities ?? true,
            pipelineOnly: true,
            benchmark: false,
          },
        }
      : config.template,
  };

  const genSpinner = ora(
    `${existingContent ? 'Merging' : 'Generating'} ${targetFileName}...`
  ).start();
  try {
    const newClaudeMd = await generateClaudeMd(analysis, effectiveConfig);
    const claudeMd = existingContent ? mergeClaudeMd(existingContent, newClaudeMd) : newClaudeMd;

    // Validate merge if we merged existing content
    if (existingContent) {
      const validation = validateMerge(existingContent, claudeMd);
      if (!validation.valid) {
        genSpinner.warn(`Merged with warnings`);
        console.log(chalk.yellow('\n  Merge validation warnings:'));
        for (const warning of validation.warnings) {
          console.log(chalk.dim(`    - ${warning}`));
        }
        console.log('');
      }
    }

    if (options.dryRun) {
      genSpinner.succeed(`${existingContent ? 'Merged' : 'Generated'} (dry run)`);
      console.log(chalk.dim(`\n--- ${targetFileName} Preview ---\n`));
      console.log(claudeMd.substring(0, 2000) + '\n...\n');
      console.log(
        chalk.dim(`Total: ${claudeMd.length} characters, ${claudeMd.split('\n').length} lines`)
      );
    } else {
      writeFileSync(targetPath, claudeMd);
      genSpinner.succeed(
        `${existingContent ? 'Merged and updated' : 'Generated'} ${targetFileName}`
      );
      if (existingContent) {
        console.log(
          chalk.dim('  Preserved custom sections and extracted valuable content from existing file')
        );
      }
    }
  } catch (error) {
    genSpinner.fail(`Failed to ${existingContent ? 'merge' : 'generate'} ${targetFileName}`);
    console.error(chalk.red(error));
    return;
  }

  // Generate platform-specific files if requested
  if (options.platform || !options.dryRun) {
    const platforms = options.platform
      ? [options.platform as Platform]
      : Object.entries(config.platforms || {})
          .filter(([_, v]) => v?.enabled)
          .map(([k]) => k as Platform);

    for (const platform of platforms) {
      const platformSpinner = ora(`Generating ${platform} files...`).start();
      try {
        await generatePlatformFiles(cwd, platform, analysis, config, options.dryRun);
        platformSpinner.succeed(`Generated ${platform} files`);
      } catch (error) {
        platformSpinner.fail(`Failed to generate ${platform} files`);
        console.error(chalk.red(error));
      }
    }
  }

  if (!options.dryRun) {
    console.log(chalk.green('\n✅ Generation complete!\n'));

    // Print helpful next steps
    console.log(chalk.bold('Next Steps:\n'));
    console.log('  1. Your AI assistant will now read CLAUDE.md automatically');
    console.log('  2. The AI handles memory, tasks, and workflows autonomously');
    console.log('  3. Just talk to your AI naturally - it follows the CLAUDE.md instructions\n');

    // Show optional enhancements
    if (!deps.docker || !deps.qdrant) {
      console.log(chalk.dim('Optional: For persistent semantic memory across sessions:'));
      if (!deps.docker) {
        console.log(chalk.dim('  - Install Docker: https://docs.docker.com/get-docker/'));
      }
      if (deps.docker && !deps.qdrant) {
        console.log(chalk.dim('  - Start Qdrant: uap memory start'));
      }
      console.log('');
    }
  }
}

async function generatePlatformFiles(
  cwd: string,
  platform: Platform,
  analysis: Awaited<ReturnType<typeof analyzeProject>>,
  config: AgentContextConfig,
  dryRun?: boolean
): Promise<void> {
  const { mkdirSync, writeFileSync, existsSync: pathExists } = await import('fs');

  switch (platform) {
    case 'claudeCode': {
      // Generate .claude/ structure for Claude Code Desktop
      const claudeDir = join(cwd, '.claude');
      if (!dryRun) {
        if (!pathExists(claudeDir)) {
          mkdirSync(claudeDir, { recursive: true });
        }

        // .claude/settings.json - workspace-specific settings
        const settings = {
          autoApprove: ['read', 'write', 'shell'],
          defaultModel: 'claude-sonnet-4-6-20250514',
          contextWindow: 200000,
          memoryPath: config.memory?.shortTerm?.path || 'agents/data/memory/short_term.db',
          worktreeDirectory: config.worktrees?.directory || '.worktrees',
        };
        writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

        // .claude/commands.json - custom slash commands
        const commands = {
          memory: 'uap memory query "$1"',
          store: 'uap memory store "$1" --importance 7',
          worktree: 'uap worktree create "$1"',
          status: 'uap memory status',
        };
        writeFileSync(join(claudeDir, 'commands.json'), JSON.stringify(commands, null, 2));
      }
      break;
    }

    case 'factory': {
      // Generate .factory/ structure for Factory.AI
      const factoryDir = join(cwd, '.factory');
      if (!dryRun) {
        if (!pathExists(factoryDir)) {
          mkdirSync(factoryDir, { recursive: true });
        }

        // .factory/config.json
        const factoryConfig = {
          name: analysis.projectName || config.project.name,
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
        };
        writeFileSync(join(factoryDir, 'config.json'), JSON.stringify(factoryConfig, null, 2));

        // Ensure droids and skills directories exist
        const droidsDir = join(factoryDir, 'droids');
        const skillsDir = join(factoryDir, 'skills');
        if (!pathExists(droidsDir)) mkdirSync(droidsDir, { recursive: true });
        if (!pathExists(skillsDir)) mkdirSync(skillsDir, { recursive: true });
      }
      break;
    }

    case 'vscode': {
      // Generate .vscode/ settings for VSCode + extensions
      const vscodeDir = join(cwd, '.vscode');
      if (!dryRun) {
        if (!pathExists(vscodeDir)) {
          mkdirSync(vscodeDir, { recursive: true });
        }

        // .vscode/settings.json
        const settingsPath = join(vscodeDir, 'settings.json');
        let existingSettings: Record<string, unknown> = {};
        if (pathExists(settingsPath)) {
          try {
            existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          } catch {
            // Ignore parse errors
          }
        }

        const vscodeSettings = {
          ...existingSettings,
          'files.associations': {
            ...((existingSettings['files.associations'] as Record<string, string>) || {}),
            'CLAUDE.md': 'markdown',
            'AGENT.md': 'markdown',
            '*.uap.json': 'json',
          },
          'editor.formatOnSave': existingSettings['editor.formatOnSave'] ?? true,
          '[markdown]': {
            'editor.wordWrap': 'on',
            ...((existingSettings['[markdown]'] as Record<string, unknown>) || {}),
          },
        };
        writeFileSync(settingsPath, JSON.stringify(vscodeSettings, null, 2));

        // .vscode/extensions.json - recommended extensions
        const extensions = {
          recommendations: [
            'dbaeumer.vscode-eslint',
            'esbenp.prettier-vscode',
            'yzhang.markdown-all-in-one',
          ],
        };
        writeFileSync(join(vscodeDir, 'extensions.json'), JSON.stringify(extensions, null, 2));
      }
      break;
    }

    case 'opencode': {
      // Generate opencode.json for OpenCode CLI
      // OpenCode config only supports: $schema, provider, model, agent (singular), mcp
      // Project context (memory, git, commands) belongs in CLAUDE.md, not here
      if (!dryRun) {
        const opencodeConfigPath = join(cwd, 'opencode.json');

        // Preserve existing config if present (user may have provider/model settings)
        let existingOpencodeConfig: Record<string, unknown> = {};
        if (pathExists(opencodeConfigPath)) {
          try {
            existingOpencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, 'utf-8'));
          } catch {
            // Ignore parse errors, will overwrite with valid config
          }
        }

        const opencodeConfig: Record<string, unknown> = {
          $schema: 'https://opencode.ai/config.json',
          provider: existingOpencodeConfig.provider ?? {
            'llama.cpp': {
              npm: '@ai-sdk/openai-compatible',
              name: 'llama-server (local)',
              options: {
                baseURL: 'http://localhost:8080/v1',
                apiKey: 'sk-qwen35b',
              },
              models: {
                'qwen35-a3b-iq4xs': {
                  name: 'Qwen3.5 35B A3B (IQ4_XS)',
                  limit: { context: 262144, output: 16384 },
                },
              },
            },
          },
          model: existingOpencodeConfig.model ?? 'llama.cpp/qwen35-a3b-iq4xs',
          agent: existingOpencodeConfig.agent ??
            existingOpencodeConfig.agents ?? {
              build: { model: 'llama.cpp/qwen35-a3b-iq4xs', temperature: 0.1 },
              plan: { model: 'llama.cpp/qwen35-a3b-iq4xs', temperature: 0.2 },
              memory: { model: 'llama.cpp/qwen35-a3b-iq4xs', temperature: 0.0 },
            },
          ...(existingOpencodeConfig.mcp ? { mcp: existingOpencodeConfig.mcp } : {}),
        };
        writeFileSync(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2));
      }
      break;
    }
  }
}
