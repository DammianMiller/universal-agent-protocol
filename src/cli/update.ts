import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';

import { analyzeProject } from '../analyzers/index.js';
import { generateClaudeMd } from '../generators/claude-md.js';
import { mergeClaudeMd, validateMerge } from '../utils/merge-claude-md.js';
import { AgentContextConfigSchema } from '../types/index.js';
import { initializeMemoryDatabase } from '../memory/short-term/schema.js';
import { getEmbeddingService } from '../memory/embeddings.js';
import { getMemoryConsolidator } from '../memory/memory-consolidator.js';
import type { AgentContextConfig } from '../types/index.js';

interface UpdateOptions {
  dryRun?: boolean;
  skipMemory?: boolean;
  skipQdrant?: boolean;
  verbose?: boolean;
  pipelineOnly?: boolean;
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, '.uap.json');
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  const agentMdPath = join(cwd, 'AGENT.md');

  console.log(chalk.bold('\n🔄 UAP Update - Preserving All Customizations\n'));

  // Check for existing config
  if (!existsSync(configPath)) {
    console.log(chalk.yellow('No .uap.json found. Run `uap init` first.'));
    return;
  }

  // Load config
  let config: AgentContextConfig;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    config = AgentContextConfigSchema.parse(raw);
  } catch (error) {
    console.error(chalk.red('Invalid .uap.json configuration'));
    console.error(error);
    return;
  }

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

  // Find existing CLAUDE.md or AGENT.md
  let existingPath: string | null = null;
  let existingContent: string | null = null;

  if (existsSync(claudeMdPath)) {
    existingPath = claudeMdPath;
    existingContent = readFileSync(claudeMdPath, 'utf-8');
  } else if (existsSync(agentMdPath)) {
    existingPath = agentMdPath;
    existingContent = readFileSync(agentMdPath, 'utf-8');
  }

  if (!existingContent) {
    console.log(chalk.yellow('No CLAUDE.md or AGENT.md found. Run `uap generate` instead.'));
    return;
  }

  // Create backup before update
  const backupPath = existingPath + '.backup.' + new Date().toISOString().replace(/[:.]/g, '-');

  if (options.dryRun) {
    console.log(chalk.dim(`Would create backup at: ${backupPath}`));
  } else {
    copyFileSync(existingPath!, backupPath);
    console.log(chalk.dim(`Created backup: ${backupPath}`));
  }

  // Apply --pipeline-only flag to config if provided
  const effectiveConfig: AgentContextConfig = options.pipelineOnly
    ? {
        ...config,
        template: {
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
        },
      }
    : config;

  // Generate new content from latest template
  const genSpinner = ora('Generating updated content from latest template...').start();
  let newContent: string;
  try {
    newContent = await generateClaudeMd(analysis, effectiveConfig);
    genSpinner.succeed('Generated updated content');
  } catch (error) {
    genSpinner.fail('Failed to generate new content');
    console.error(chalk.red(error));
    return;
  }

  // Merge: New template structure + existing user content
  const mergeSpinner = ora(
    'Merging with existing content (preserving all customizations)...'
  ).start();
  let mergedContent: string;
  try {
    mergedContent = mergeClaudeMd(existingContent, newContent);
    mergeSpinner.succeed('Merged content');
  } catch (error) {
    mergeSpinner.fail('Failed to merge content');
    console.error(chalk.red(error));
    return;
  }

  // Validate merge
  const validation = validateMerge(existingContent, mergedContent);
  if (!validation.valid) {
    console.log(chalk.yellow('\n  Merge validation warnings:'));
    for (const warning of validation.warnings) {
      console.log(chalk.dim(`    - ${warning}`));
    }
  }

  // Show diff summary
  const existingLines = existingContent.split('\n').length;
  const newLines = newContent.split('\n').length;
  const mergedLines = mergedContent.split('\n').length;

  console.log(chalk.bold('\n📊 Update Summary:\n'));
  console.log(chalk.dim(`  Existing file: ${existingLines} lines`));
  console.log(chalk.dim(`  New template:  ${newLines} lines`));
  console.log(chalk.dim(`  Merged result: ${mergedLines} lines`));

  // Count preserved sections
  const existingSections = (existingContent.match(/^## /gm) || []).length;
  const mergedSections = (mergedContent.match(/^## /gm) || []).length;
  console.log(chalk.dim(`  Sections: ${existingSections} → ${mergedSections}`));

  if (options.dryRun) {
    console.log(chalk.yellow('\n  --dry-run: No changes made\n'));

    // Show preview
    console.log(chalk.dim('--- Preview (first 50 lines) ---\n'));
    console.log(mergedContent.split('\n').slice(0, 50).join('\n'));
    console.log(chalk.dim('\n... [truncated] ...'));
    return;
  }

  // Write merged content
  writeFileSync(existingPath!, mergedContent);

  console.log(chalk.green(`\n✅ Updated ${existingPath}\n`));

  // Update memory system
  if (!options.skipMemory) {
    await updateMemorySystem(cwd, config, options);
  }

  // Update Qdrant if available
  if (!options.skipQdrant) {
    await updateQdrantCollection(cwd, config, options);
  }

  // Summary
  console.log(chalk.bold('\n📋 Update Summary:\n'));
  console.log('CLAUDE.md:');
  console.log('  • All custom sections preserved');
  console.log('  • Template structure updated');
  console.log('  • Code Field cognitive environment (v9.0)');
  console.log('');
  console.log('Memory System:');
  console.log('  • SQLite database schema updated');
  console.log('  • Embedding service initialized');
  console.log('  • Background consolidation ready');
  console.log('');
  console.log(chalk.dim(`Backup saved at: ${backupPath}`));
  console.log(chalk.dim('If something looks wrong, restore from backup.'));
}

/**
 * Update memory system - SQLite schema, embeddings, consolidator
 */
async function updateMemorySystem(
  cwd: string,
  config: AgentContextConfig,
  options: UpdateOptions
): Promise<void> {
  const memSpinner = ora('Updating memory system...').start();

  try {
    // Ensure directories exist
    const memoryDir = join(cwd, 'agents/data/memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Initialize/update SQLite database
    const dbPath = config.memory?.shortTerm?.path || './agents/data/memory/short_term.db';
    const fullDbPath = join(cwd, dbPath);
    initializeMemoryDatabase(fullDbPath);

    // Initialize embedding service
    const embeddingService = getEmbeddingService();
    await embeddingService.initialize();

    if (options.verbose) {
      console.log(chalk.dim(`  Embedding provider: ${embeddingService.getProviderName()}`));
      console.log(chalk.dim(`  Dimensions: ${embeddingService.getDimensions()}`));
    }

    // Initialize consolidator
    const consolidator = getMemoryConsolidator();
    consolidator.initialize(fullDbPath);

    memSpinner.succeed('Memory system updated');

    if (options.verbose) {
      const stats = consolidator.getStats();
      console.log(chalk.dim(`  Total memories: ${stats.totalMemories}`));
      console.log(chalk.dim(`  Session memories: ${stats.totalSessionMemories}`));
      console.log(chalk.dim(`  Lessons extracted: ${stats.totalLessons}`));
    }
  } catch (error) {
    memSpinner.warn('Memory system update had issues');
    if (options.verbose) {
      console.error(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

/**
 * Generate a safe collection name from project ID (matches qdrant-cloud.ts)
 */
function getProjectCollectionName(base: string, projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 8);
  const projectName =
    projectPath.split(/[/\\]/).pop() || projectPath.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `${base}_${projectName}_${hash}`;
}

/**
 * Update Qdrant collection - handle dimension migration if needed
 * Collections are project-scoped for data isolation
 */
async function updateQdrantCollection(
  cwd: string,
  config: AgentContextConfig,
  options: UpdateOptions
): Promise<void> {
  const qdrantSpinner = ora('Checking Qdrant collection...').start();

  try {
    // Check if Qdrant is running
    const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
    const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;

    const response = await fetch(`${url}/collections`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      qdrantSpinner.info('Qdrant not available (optional)');
      return;
    }

    const data = (await response.json()) as { result: { collections: Array<{ name: string }> } };
    const baseCollection = config.memory?.longTerm?.collection || 'agent_memory';
    const projectId = config.project?.name || cwd;

    // Generate project-scoped collection name
    const collection = getProjectCollectionName(baseCollection, projectId);

    if (options.verbose) {
      console.log(chalk.dim(`  Project-scoped collection: ${collection}`));
    }

    // Check collection dimensions
    const collectionExists = data.result.collections.some((c) => c.name === collection);

    if (collectionExists) {
      const collectionInfo = await fetch(`${url}/collections/${collection}`);
      const info = (await collectionInfo.json()) as {
        result: { config: { params: { vectors: { size: number } } } };
      };
      const currentSize = info.result?.config?.params?.vectors?.size;

      // Get expected dimensions from embedding service
      const embeddingService = getEmbeddingService();
      await embeddingService.initialize();
      const expectedSize = embeddingService.getDimensions();

      if (currentSize && currentSize !== expectedSize) {
        qdrantSpinner.text = `Migrating collection (${currentSize} → ${expectedSize} dimensions)...`;

        // Create new collection with correct dimensions
        const newCollection = `${collection}_v${expectedSize}`;
        const newExists = data.result.collections.some((c) => c.name === newCollection);

        if (!newExists) {
          await fetch(`${url}/collections/${newCollection}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vectors: { size: expectedSize, distance: 'Cosine' },
            }),
          });

          qdrantSpinner.succeed(`Created new collection: ${newCollection} (${expectedSize} dims)`);
          console.log(chalk.dim(`  Old collection ${collection} preserved for reference`));
        } else {
          qdrantSpinner.succeed(
            `Collection ${newCollection} already exists with correct dimensions`
          );
        }
      } else {
        qdrantSpinner.succeed(`Qdrant collection OK (${currentSize} dimensions)`);
      }
    } else {
      // Create collection with correct dimensions
      const embeddingService = getEmbeddingService();
      await embeddingService.initialize();
      const expectedSize = embeddingService.getDimensions();

      await fetch(`${url}/collections/${collection}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: { size: expectedSize, distance: 'Cosine' },
        }),
      });

      qdrantSpinner.succeed(`Created Qdrant collection: ${collection} (${expectedSize} dims)`);
    }
  } catch (error) {
    qdrantSpinner.info('Qdrant not available (run `uap memory start` to enable)');
    if (options.verbose) {
      console.log(chalk.dim(`  ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
