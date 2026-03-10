import chalk from 'chalk';
import ora from 'ora';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import { prepopulateMemory } from '../memory/prepopulate.js';
import { SQLiteShortTermMemory } from '../memory/short-term/sqlite.js';
import { ensureKnowledgeSchema, ensureSessionSchema } from '../memory/short-term/schema.js';
import { AgentContextConfigSchema } from '../types/index.js';
import type { AgentContextConfig } from '../types/index.js';
import type { MemoryEntry } from '../memory/backends/base.js';
import type { DiscoveredSkill } from '../memory/prepopulate.js';
import { statusBadge, miniGauge, divider, keyValue, tree, type TreeNode } from './visualize.js';
import { evaluateWriteGate, formatGateResult } from '../memory/write-gate.js';
import { DailyLog } from '../memory/daily-log.js';
import { propagateCorrection } from '../memory/correction-propagator.js';
import { runMaintenance } from '../memory/memory-maintenance.js';

// CRITICAL: Memory databases are NEVER deleted or overwritten.
// They persist with the project for its entire lifecycle.
// Users can manually delete if absolutely necessary.

type MemoryAction = 'status' | 'start' | 'stop' | 'query' | 'store' | 'prepopulate' | 'promote' | 'correct' | 'maintain';

interface MemoryOptions {
  search?: string;
  limit?: string;
  content?: string;
  tags?: string;
  importance?: string;
  docs?: boolean;
  git?: boolean;
  since?: string;
  verbose?: boolean;
  force?: boolean;
  correction?: string;
  reason?: string;
}

export async function memoryCommand(action: MemoryAction, options: MemoryOptions = {}): Promise<void> {
  const cwd = process.cwd();

  switch (action) {
    case 'status':
      await showStatus(cwd);
      break;
    case 'start':
      await startServices(cwd);
      break;
    case 'stop':
      await stopServices(cwd);
      break;
    case 'query':
      await queryMemory(cwd, options.search!, parseInt(options.limit || '10'));
      break;
    case 'store':
      await storeMemory(cwd, options.content!, options.tags, parseInt(options.importance || '5'), options.force);
      break;
    case 'prepopulate':
      await prepopulateFromSources(cwd, options);
      break;
    case 'promote':
      await promoteFromDailyLog(cwd, options);
      break;
    case 'correct':
      await correctMemory(cwd, options);
      break;
    case 'maintain':
      await maintainMemory(cwd, options);
      break;
  }
}

async function showStatus(cwd: string): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('  Memory System Status'));
  console.log(divider(50));
  console.log('');

  let sqliteActive = false;
  let qdrantActive = false;

  // Short-term memory
  const shortTermPath = join(cwd, 'agents/data/memory/short_term.db');
  if (existsSync(shortTermPath)) {
    sqliteActive = true;
    const stats = statSync(shortTermPath);
    const sizeKB = Math.round(stats.size / 1024);
    
    let entryCount = 0;
    try {
      const db = new SQLiteShortTermMemory({
        dbPath: shortTermPath,
        projectId: 'status-check',
        maxEntries: 9999,
      });
      entryCount = await db.count();
      await db.close();
    } catch { /* ignore */ }

    console.log(`  ${statusBadge('active')} ${chalk.bold('Short-term Memory')}`);
    for (const line of keyValue([
      ['Size', `${sizeKB} KB`],
      ['Entries', entryCount],
      ['Modified', stats.mtime.toLocaleDateString()],
    ], { indent: 4 })) console.log(line);
    console.log(`    ${'Capacity'.padEnd(18)} ${miniGauge(entryCount, 50, 15)} ${chalk.dim(`${entryCount}/50`)}`);
  } else {
    console.log(`  ${statusBadge('not_available')} ${chalk.bold('Short-term Memory')} ${chalk.dim('Not initialized')}`);
  }
  console.log('');

  // Qdrant
  try {
    const dockerStatus = execSync(
      'docker ps --filter name=qdrant --format "{{.Status}}"',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (dockerStatus) {
      qdrantActive = true;
      console.log(`  ${statusBadge('running')} ${chalk.bold('Qdrant')} ${chalk.dim(dockerStatus)}`);
      console.log(chalk.dim('    Endpoint: http://localhost:6333'));
    } else {
      console.log(`  ${statusBadge('stopped')} ${chalk.bold('Qdrant')} ${chalk.dim('Container not running')}`);
    }
  } catch {
    console.log(`  ${statusBadge('not_available')} ${chalk.bold('Qdrant')} ${chalk.dim('Docker not available')}`);
  }
  console.log('');

  // Ollama
  try {
    const ollamaResponse = await fetch('http://localhost:11434/api/tags', {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    
    if (ollamaResponse.ok) {
      const ollamaData = await ollamaResponse.json() as { models: Array<{ name: string; size: number }> };
      const embedModels = ollamaData.models?.filter(m => 
        m.name.includes('embed') || m.name.includes('nomic')
      ) || [];
      
      if (embedModels.length > 0) {
        console.log(`  ${statusBadge('active')} ${chalk.bold('Embeddings')}`);
        for (const model of embedModels) {
          const sizeMB = Math.round((model.size || 0) / 1024 / 1024);
          console.log(`    ${chalk.cyan(model.name)} ${chalk.dim(`${sizeMB} MB`)}`);
        }
      } else {
        console.log(`  ${statusBadge('not_available')} ${chalk.bold('Embeddings')} ${chalk.dim('No embed models')}`);
        console.log(chalk.dim('    Run: ollama pull nomic-embed-text'));
      }
    } else {
      console.log(`  ${statusBadge('stopped')} ${chalk.bold('Embeddings')} ${chalk.dim('Not responding')}`);
    }
  } catch {
    console.log(`  ${statusBadge('not_available')} ${chalk.bold('Embeddings')} ${chalk.dim('Ollama not running')}`);
  }

  // Architecture tree
  console.log('');
  const layers: TreeNode = {
    label: chalk.bold('Memory Layers'),
    children: [
      { label: 'L1 Working',  status: sqliteActive ? chalk.green('ON') : chalk.red('--'), meta: 'SQLite, <1ms' },
      { label: 'L2 Session',  status: sqliteActive ? chalk.green('ON') : chalk.red('--'), meta: 'SQLite, <5ms' },
      { label: 'L3 Semantic', status: qdrantActive ? chalk.green('ON') : chalk.yellow('--'), meta: 'Qdrant, ~50ms' },
      { label: 'L4 Graph',    status: sqliteActive ? chalk.green('ON') : chalk.red('--'), meta: 'SQLite entities' },
    ],
  };
  for (const line of tree(layers)) console.log(line);
  console.log('');
}

export async function startServices(cwd: string): Promise<void> {
  const spinner = ora('Starting memory services...').start();

  // Check for docker-compose file
  const composePaths = [
    join(cwd, 'agents/docker-compose.yml'),
    join(cwd, 'docker/docker-compose.yml'),
  ];

  let composePath: string | null = null;
  for (const path of composePaths) {
    if (existsSync(path)) {
      composePath = path;
      break;
    }
  }

  if (!composePath) {
    // Create default docker-compose
    spinner.text = 'Creating docker-compose.yml...';
    const defaultCompose = `version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: uap-qdrant
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - ./qdrant_data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    restart: unless-stopped
`;
    const agentsDir = join(cwd, 'agents');
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
    composePath = join(agentsDir, 'docker-compose.yml');
    writeFileSync(composePath, defaultCompose);
  }

  try {
    execSync(`docker-compose -f "${composePath}" up -d`, { encoding: 'utf-8', stdio: 'pipe' });
    spinner.succeed('Memory services started');
    console.log(chalk.dim('  Qdrant available at http://localhost:6333'));
  } catch (error) {
    spinner.fail('Failed to start memory services');
    console.error(chalk.red('Make sure Docker is installed and running'));
    console.error(error);
  }
}

/**
 * Check if Qdrant is reachable by polling its health endpoint.
 * Optionally waits up to `timeoutMs` for it to become available.
 */
export async function isQdrantReachable(endpoint = 'http://localhost:6333', timeoutMs = 0): Promise<boolean> {
  const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 1000;

  do {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not yet available
    }
    if (Date.now() + pollInterval > deadline) break;
    await new Promise(r => setTimeout(r, pollInterval));
  } while (Date.now() < deadline);

  return false;
}

async function stopServices(cwd: string): Promise<void> {
  const spinner = ora('Stopping memory services...').start();

  const composePaths = [
    join(cwd, 'agents/docker-compose.yml'),
    join(cwd, 'docker/docker-compose.yml'),
  ];

  let composePath: string | null = null;
  for (const path of composePaths) {
    if (existsSync(path)) {
      composePath = path;
      break;
    }
  }

  if (!composePath) {
    spinner.fail('No docker-compose.yml found');
    return;
  }

  try {
    execSync(`docker-compose -f "${composePath}" down`, { encoding: 'utf-8', stdio: 'pipe' });
    spinner.succeed('Memory services stopped');
  } catch (error) {
    spinner.fail('Failed to stop memory services');
    console.error(error);
  }
}

async function queryMemory(cwd: string, search: string, limit: number): Promise<void> {
  console.log(chalk.bold(`\n🔍 Searching for: "${search}" (limit: ${limit})\n`));

  // Load config
  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = AgentContextConfigSchema.parse(raw);
    } catch {
      config = {
        version: '1.0.0',
        project: { name: 'project', defaultBranch: 'main' },
      };
    }
  } else {
    config = {
      version: '1.0.0',
      project: { name: 'project', defaultBranch: 'main' },
    };
  }

  // Query short-term memory (SQLite) first
  const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
  if (existsSync(dbPath)) {
    try {
      const shortTermDb = new SQLiteShortTermMemory({
        dbPath,
        projectId: config.project.name,
        maxEntries: config.memory?.shortTerm?.maxEntries || 50,
      });

      const results = await shortTermDb.query(search, limit);
      await shortTermDb.close();

      if (results.length > 0) {
        console.log(chalk.green(`Found ${results.length} results in short-term memory:\n`));
        for (const r of results) {
          const typeColor = r.type === 'action' ? chalk.blue :
                           r.type === 'observation' ? chalk.cyan :
                           r.type === 'thought' ? chalk.magenta :
                           chalk.yellow;
          console.log(`  ${typeColor(`[${r.type}]`)} ${chalk.dim(r.timestamp.slice(0, 10))}`);
          console.log(`    ${r.content.slice(0, 150)}${r.content.length > 150 ? '...' : ''}\n`);
        }
      } else {
        console.log(chalk.dim('No results in short-term memory'));
      }
    } catch (error) {
      console.log(chalk.yellow('Could not query short-term memory:'), error);
    }
  }

  // Query long-term memory (Qdrant) if available
  await queryQdrant(cwd, config, search, limit);
}

async function queryQdrant(
  _cwd: string,
  config: AgentContextConfig,
  search: string,
  limit: number
): Promise<void> {
  const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `http://${endpoint}`;
  const apiKey = config.memory?.longTerm?.qdrantCloud?.apiKey || process.env.QDRANT_API_KEY;
  const collection = config.memory?.longTerm?.collection || 'agent_memory';

  try {
    const client = new QdrantClient({ url, apiKey });
    await client.getCollections();

    // Try collection variants (main and prepopulated)
    const collections = await client.getCollections();
    const candidates = [collection, `${collection}_prepopulated`];
    const availableCollections = candidates.filter(c =>
      collections.collections.some(col => col.name === c)
    );

    if (availableCollections.length === 0) {
      console.log(chalk.dim('\nNo Qdrant collections found. Run `uap memory prepopulate` first.'));
      return;
    }

    // Use deterministic embedding for search (same as storage)
    const searchVector = createDeterministicEmbedding(`${search}`);

    let allResults: Array<{ content: string; type: string; score: number; tags?: string[] }> = [];
    for (const col of availableCollections) {
      try {
        const results = await client.search(col, {
          vector: searchVector,
          limit,
          with_payload: true,
        });
        for (const r of results) {
          const payload = r.payload as Record<string, unknown> | null;
          if (payload) {
            allResults.push({
              content: (payload.content as string) || '',
              type: (payload.type as string) || 'unknown',
              score: r.score,
              tags: payload.tags as string[] | undefined,
            });
          }
        }
      } catch {
        // Collection might have incompatible vector size
      }
    }

    // Deduplicate and sort by score
    const seen = new Set<string>();
    allResults = allResults.filter(r => {
      const key = r.content.slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    if (allResults.length > 0) {
      console.log(chalk.green(`\nFound ${allResults.length} results in long-term memory (Qdrant):\n`));
      for (const r of allResults) {
        const typeColor = r.type === 'action' ? chalk.blue :
                         r.type === 'observation' ? chalk.cyan :
                         r.type === 'thought' ? chalk.magenta :
                         chalk.yellow;
        const scoreStr = chalk.dim(`(${(r.score * 100).toFixed(0)}%)`);
        console.log(`  ${typeColor(`[${r.type}]`)} ${scoreStr}`);
        console.log(`    ${r.content.slice(0, 150)}${r.content.length > 150 ? '...' : ''}`);
        if (r.tags && r.tags.length > 0) {
          console.log(`    ${chalk.dim(`tags: ${r.tags.join(', ')}`)}`);
        }
        console.log('');
      }
    } else {
      console.log(chalk.dim('\nNo results in long-term memory'));
    }
  } catch {
    console.log(chalk.dim('\nQdrant not available for long-term search. Run `uap memory start` first.'));
  }
}

async function storeMemory(
  cwd: string,
  content: string,
  tags?: string,
  importance: number = 5,
  force: boolean = false
): Promise<void> {
  // Apply write gate unless --force is used
  if (!force) {
    const gateResult = evaluateWriteGate(content);
    if (!gateResult.passed) {
      console.log(chalk.bold('\n🚫 Write Gate: REJECTED\n'));
      console.log(chalk.dim(formatGateResult(gateResult)));
      console.log('');
      console.log(chalk.yellow('  This memory does not meet the write gate criteria.'));
      console.log(chalk.yellow('  Use --force to bypass the write gate.'));
      console.log('');
      return;
    }
    console.log(chalk.bold('\n✓ Write Gate: PASSED') + chalk.dim(` (score: ${gateResult.score.toFixed(2)})`));
    const matchedCriteria = gateResult.criteria.filter(c => c.matched);
    if (matchedCriteria.length > 0) {
      console.log(chalk.dim(`  Matched: ${matchedCriteria.map(c => c.name).join(', ')}`));
    }
  } else {
    console.log(chalk.dim('\n  Write gate bypassed (--force)'));
  }

  console.log(chalk.bold('\n💾 Storing memory...\n'));
  console.log(chalk.dim(`Content: ${content}`));
  console.log(chalk.dim(`Tags: ${tags || 'none'}`));
  console.log(chalk.dim(`Importance: ${importance}/10`));

  // Load config
  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = AgentContextConfigSchema.parse(raw);
    } catch {
      config = {
        version: '1.0.0',
        project: { name: 'project', defaultBranch: 'main' },
      };
    }
  } else {
    config = {
      version: '1.0.0',
      project: { name: 'project', defaultBranch: 'main' },
    };
  }

  // Determine memory type based on importance
  const memoryType: 'action' | 'observation' | 'thought' | 'goal' = 
    importance >= 8 ? 'goal' :
    importance >= 6 ? 'thought' :
    tags?.includes('observation') ? 'observation' : 'action';

  // Always write to daily log first (staging area)
  const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
  const gateScore = force ? 1.0 : evaluateWriteGate(content).score;
  try {
    const dailyLog = new DailyLog(dbPath);
    dailyLog.write(content, memoryType, gateScore);
    dailyLog.close();
    console.log(chalk.green('\n✓ Written to daily log (staging area)'));
  } catch (error) {
    console.log(chalk.yellow('Could not write to daily log:'), error);
  }

  // Also store in short-term memory (SQLite) for immediate availability
  try {
    const shortTermDb = new SQLiteShortTermMemory({
      dbPath,
      projectId: config.project.name,
      maxEntries: config.memory?.shortTerm?.maxEntries || 50,
    });

    await shortTermDb.store(memoryType, content);
    await shortTermDb.close();

    console.log(chalk.green('✓ Stored in short-term memory (SQLite)'));
    console.log(chalk.dim(`  Type: ${memoryType}`));
    console.log(chalk.dim(`  Path: ${dbPath}`));
  } catch (error) {
    console.log(chalk.red('Failed to store in short-term memory:'), error);
  }

  // Note about long-term storage
  if (importance >= 7) {
    console.log(chalk.dim('\nNote: High-importance memories should also be stored in long-term memory.'));
    console.log(chalk.dim('Long-term semantic storage requires Qdrant + embedding service (not yet integrated).'));
  }
}

async function prepopulateFromSources(cwd: string, options: MemoryOptions): Promise<void> {
  console.log(chalk.bold('\n🧠 Prepopulating Memory from Project Sources\n'));

  // Load config
  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = AgentContextConfigSchema.parse(raw);
    } catch {
      config = {
        version: '1.0.0',
        project: { name: 'project', defaultBranch: 'main' },
      };
    }
  } else {
    config = {
      version: '1.0.0',
      project: { name: 'project', defaultBranch: 'main' },
    };
  }

  const sources: string[] = [];
  if (options.docs) sources.push('documentation');
  if (options.git) sources.push('git history');
  if (sources.length === 0) sources.push('documentation', 'git history');

  console.log(chalk.dim(`Sources: ${sources.join(', ')}`));
  if (options.limit) console.log(chalk.dim(`Git commit limit: ${options.limit}`));
  if (options.since) console.log(chalk.dim(`Git commits since: ${options.since}`));
  console.log('');

  const spinner = ora('Extracting knowledge from project...').start();

  try {
    const { shortTerm, longTerm, skills } = await prepopulateMemory(cwd, {
      docs: options.docs || (!options.docs && !options.git),
      git: options.git || (!options.docs && !options.git),
      skills: true, // Always discover skills
      limit: options.limit ? parseInt(options.limit) : 500,
      since: options.since,
      verbose: options.verbose,
    });

    spinner.succeed(`Extracted ${shortTerm.length} short-term, ${longTerm.length} long-term memories, ${skills.length} skills/artifacts`);

    // Store short-term memories to SQLite
    if (shortTerm.length > 0) {
      const stSpinner = ora('Storing short-term memories...').start();
      try {
        const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
        const shortTermDb = new SQLiteShortTermMemory({
          dbPath,
          projectId: config.project.name,
          maxEntries: config.memory?.shortTerm?.maxEntries || 50,
        });

        // Store memories in batch
        const entries = shortTerm.map(m => ({
          type: m.type,
          content: m.content,
          timestamp: m.timestamp,
        }));
        await shortTermDb.storeBatch(entries);
        await shortTermDb.close();

        stSpinner.succeed(`Stored ${shortTerm.length} short-term memories to SQLite`);
        console.log(chalk.dim(`  Database: ${dbPath}`));
      } catch (error) {
        stSpinner.fail('Failed to store short-term memories');
        console.error(chalk.red(error));
      }
    }

    let sessionInserted = 0;
    let graphStats: { entities: number; relationships: number } = { entities: 0, relationships: 0 };

    if (shortTerm.length > 0 || longTerm.length > 0) {
      const sessionSpinner = ora('Storing session memories...').start();
      try {
        const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
        sessionInserted = storeSessionMemories(dbPath, config.project.name, shortTerm, longTerm);
        sessionSpinner.succeed(`Stored ${sessionInserted} session memories`);
      } catch (error) {
        sessionSpinner.fail('Failed to store session memories');
        console.error(chalk.red(error));
      }
    }

    if (longTerm.length > 0 || skills.length > 0) {
      const graphSpinner = ora('Building knowledge graph...').start();
      try {
        const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
        graphStats = storeKnowledgeGraph(dbPath, config.project.name, longTerm, skills);
        graphSpinner.succeed(`Stored ${graphStats.entities} entities, ${graphStats.relationships} relationships`);
      } catch (error) {
        graphSpinner.fail('Failed to build knowledge graph');
        console.error(chalk.red(error));
      }
    }

    // Store long-term memories (Qdrant + export)
    if (longTerm.length > 0) {
      console.log(chalk.dim(`\n  Long-term memories ready: ${longTerm.length} entries`));
      const ltSpinner = ora('Storing long-term memories to Qdrant...').start();
      const ltResult = await storeLongTermToQdrant(longTerm, config);
      if (ltResult.stored > 0) {
        ltSpinner.succeed(`Stored ${ltResult.stored} long-term memories to ${ltResult.backend}`);
      } else {
        ltSpinner.warn(`Skipped long-term store: ${ltResult.reason || 'Qdrant not available'}`);
      }
      
      // Save long-term memories as JSON for manual import or Qdrant storage
      const ltPath = join(cwd, 'agents/data/memory/long_term_prepopulated.json');
      const ltDir = join(cwd, 'agents/data/memory');
      if (!existsSync(ltDir)) {
        mkdirSync(ltDir, { recursive: true });
      }
      writeFileSync(ltPath, JSON.stringify(longTerm, null, 2));
      console.log(chalk.dim(`  Exported to: ${ltPath}`));
    }

    // Summary by type
    console.log(chalk.bold('\n📊 Memory Summary:\n'));
    const byType = {
      observations: longTerm.filter(m => m.type === 'observation').length,
      thoughts: longTerm.filter(m => m.type === 'thought').length,
      actions: longTerm.filter(m => m.type === 'action').length,
      goals: longTerm.filter(m => m.type === 'goal').length,
    };
    console.log(chalk.dim(`  Observations: ${byType.observations}`));
    console.log(chalk.dim(`  Thoughts: ${byType.thoughts}`));
    console.log(chalk.dim(`  Actions: ${byType.actions}`));
    console.log(chalk.dim(`  Goals: ${byType.goals}`));
    console.log(chalk.dim(`  Session memories: ${sessionInserted}`));
    console.log(chalk.dim(`  Graph entities: ${graphStats.entities}`));
    console.log(chalk.dim(`  Graph relationships: ${graphStats.relationships}`));

    // Show sample memories
    if (options.verbose && shortTerm.length > 0) {
      console.log(chalk.bold('\n📝 Sample Memories:\n'));
      for (const mem of shortTerm.slice(0, 3)) {
        console.log(chalk.cyan(`  [${mem.type}] `) + chalk.dim(mem.content.substring(0, 100) + '...'));
      }
    }

    console.log(chalk.green('\n✅ Memory prepopulation complete!\n'));

  } catch (error) {
    spinner.fail('Failed to prepopulate memory');
    console.error(chalk.red(error));
  }
}

function storeSessionMemories(
  dbPath: string,
  projectId: string,
  shortTerm: MemoryEntry[],
  longTerm: MemoryEntry[]
): number {
  const db = new Database(dbPath);
  ensureSessionSchema(db);

  const entries = [...shortTerm, ...longTerm.filter((m) => (m.importance || 0) >= 7)];
  const unique = new Map(entries.map((m) => [m.content, m]));
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO session_memories (session_id, timestamp, type, content, importance)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((items: MemoryEntry[]) => {
    let inserted = 0;
    for (const entry of items) {
      inserted += stmt.run(
        projectId,
        entry.timestamp,
        entry.type,
        entry.content,
        entry.importance ?? 5
      ).changes;
    }
    return inserted;
  });

  const inserted = insertMany([...unique.values()]);
  db.close();
  return inserted;
}

function storeKnowledgeGraph(
  dbPath: string,
  projectName: string,
  longTerm: MemoryEntry[],
  skills: DiscoveredSkill[]
): { entities: number; relationships: number } {
  const db = new Database(dbPath);
  ensureKnowledgeSchema(db);
  const now = new Date().toISOString();

  const projectEntity = upsertEntity(db, 'project', projectName, now);
  let entities = projectEntity.inserted;
  let relationships = 0;

  const filePaths = new Set<string>();
  for (const entry of longTerm) {
    const file = entry.metadata?.file;
    if (typeof file === 'string') filePaths.add(file);
    const files = entry.metadata?.files;
    if (Array.isArray(files)) {
      for (const item of files) {
        if (typeof item === 'string') filePaths.add(item);
      }
    }
  }

  for (const file of filePaths) {
    const fileEntity = upsertEntity(db, 'file', file, now);
    entities += fileEntity.inserted;
    relationships += insertRelationship(db, projectEntity.id, fileEntity.id, 'contains', now);
  }

  for (const skill of skills) {
    const skillEntity = upsertEntity(db, skill.type, skill.name, now);
    entities += skillEntity.inserted;
    relationships += insertRelationship(db, projectEntity.id, skillEntity.id, 'contains', now);
  }

  db.close();
  return { entities, relationships };
}


function upsertEntity(
  db: Database.Database,
  type: string,
  name: string,
  now: string
): { id: number; inserted: number } {
  const existing = db.prepare('SELECT id, mention_count FROM entities WHERE type = ? AND name = ?').get(type, name) as { id: number; mention_count: number } | undefined;
  if (existing) {
    db.prepare('UPDATE entities SET last_seen = ?, mention_count = ? WHERE id = ?').run(now, existing.mention_count + 1, existing.id);
    return { id: existing.id, inserted: 0 };
  }

  const result = db.prepare('INSERT INTO entities (type, name, first_seen, last_seen, mention_count) VALUES (?, ?, ?, ?, 1)').run(type, name, now, now);
  return { id: Number(result.lastInsertRowid), inserted: 1 };
}

function insertRelationship(db: Database.Database, sourceId: number, targetId: number, relation: string, now: string): number {
  const result = db.prepare('INSERT OR IGNORE INTO relationships (source_id, target_id, relation, timestamp) VALUES (?, ?, ?, ?)').run(sourceId, targetId, relation, now);
  return result.changes;
}

function createDeterministicEmbedding(input: string, size = 384): number[] {
  const hash = createHash('sha256').update(input).digest();
  let seed = hash.readUInt32LE(0);
  const vector = new Array<number>(size);

  for (let i = 0; i < size; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    const normalized = (seed >>> 0) / 0xffffffff;
    vector[i] = normalized * 2 - 1;
  }

  return vector;
}

function toDeterministicUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  const timeLow = hash.slice(0, 8);
  const timeMid = hash.slice(8, 12);
  const timeHighAndVersion = `5${hash.slice(13, 16)}`;
  const clockSeq = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const clockSeqLow = hash.slice(18, 20);
  const node = hash.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHighAndVersion}-${clockSeq}${clockSeqLow}-${node}`;
}

async function storeLongTermToQdrant(
  longTerm: MemoryEntry[],
  config: AgentContextConfig
): Promise<{ stored: number; backend: string; reason?: string }> {
  if (longTerm.length === 0) {
    return { stored: 0, backend: 'qdrant', reason: 'No long-term entries' };
  }
  if (config.memory?.longTerm?.provider === 'github') {
    return { stored: 0, backend: 'github', reason: 'Long-term provider set to github' };
  }
  const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `http://${endpoint}`;
  const apiKey = config.memory?.longTerm?.qdrantCloud?.apiKey || process.env.QDRANT_API_KEY;
  const collection = config.memory?.longTerm?.collection || 'agent_memory';

  const client = new QdrantClient({ url, apiKey });
  try {
    await client.getCollections();
  } catch {
    return { stored: 0, backend: 'qdrant', reason: 'Qdrant not reachable' };
  }

  try {
    const collections = await client.getCollections();
    let collectionName = collection;
    const exists = collections.collections.some((c) => c.name === collectionName);
    if (exists) {
      const info = await client.getCollection(collectionName);
      const size = (info.config as { params?: { vectors?: { size?: number } } }).params?.vectors?.size;
      if (size && size !== 384) {
        collectionName = `${collectionName}_prepopulated`;
      }
    }

    const finalExists = collections.collections.some((c) => c.name === collectionName);
    if (!finalExists) {
      await client.createCollection(collectionName, { vectors: { size: 384, distance: 'Cosine' } });
    }

    const batchSize = 64;
    for (let i = 0; i < longTerm.length; i += batchSize) {
      const batch = longTerm.slice(i, i + batchSize);
      const points = batch.map((entry) => ({
        id: toDeterministicUuid(entry.id),
        vector: createDeterministicEmbedding(`${entry.content} ${entry.tags?.join(' ') || ''}`),
        payload: {
          timestamp: entry.timestamp,
          type: entry.type,
          content: entry.content,
          tags: entry.tags,
          importance: entry.importance,
          ...entry.metadata,
        },
      }));

      await client.upsert(collectionName, { points });
    }

    return { stored: longTerm.length, backend: `qdrant (${url}, ${collectionName})` };
  } catch (error) {
    return { stored: 0, backend: `qdrant (${url})`, reason: error instanceof Error ? error.message : 'Qdrant error' };
  }
}

async function promoteFromDailyLog(cwd: string, _options: MemoryOptions): Promise<void> {
  console.log(chalk.bold('\n📋 Daily Log Promotion Review\n'));

  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  try {
    config = existsSync(configPath)
      ? AgentContextConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')))
      : { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  } catch {
    config = { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  }

  const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');

  try {
    const dailyLog = new DailyLog(dbPath);
    const candidates = dailyLog.getPromotionCandidates();

    if (candidates.length === 0) {
      console.log(chalk.dim('  No candidates for promotion. All entries are either already promoted or below threshold.'));
      dailyLog.close();
      return;
    }

    console.log(chalk.dim(`  Found ${candidates.length} candidates for promotion:\n`));

    const shortTermDb = new SQLiteShortTermMemory({
      dbPath,
      projectId: config.project.name,
      maxEntries: config.memory?.shortTerm?.maxEntries || 50,
    });

    let promoted = 0;
    for (const candidate of candidates) {
      const { entry, suggestedTier, reason } = candidate;
      console.log(`  ${chalk.cyan(`[${entry.date}]`)} ${entry.content.slice(0, 100)}${entry.content.length > 100 ? '...' : ''}`);
      console.log(chalk.dim(`    → ${suggestedTier} (score: ${entry.gateScore.toFixed(2)}) - ${reason}`));

      // Auto-promote based on score
      if (suggestedTier === 'working') {
        const memType = entry.type === 'goal' || entry.type === 'action' || entry.type === 'observation' || entry.type === 'thought'
          ? entry.type as 'action' | 'observation' | 'thought' | 'goal'
          : 'observation';
        await shortTermDb.store(memType, entry.content, Math.round(entry.gateScore * 10));
        dailyLog.markPromoted(entry.id, 'working');
        promoted++;
        console.log(chalk.green(`    ✓ Promoted to working memory`));
      } else {
        dailyLog.markPromoted(entry.id, 'semantic');
        promoted++;
        console.log(chalk.green(`    ✓ Marked for semantic storage`));
      }
      console.log('');
    }

    await shortTermDb.close();
    dailyLog.close();
    console.log(chalk.bold.green(`\n  Promoted ${promoted} entries.\n`));
  } catch (error) {
    console.log(chalk.red('Failed to promote:'), error);
  }
}

async function correctMemory(cwd: string, options: MemoryOptions): Promise<void> {
  console.log(chalk.bold('\n🔄 Correction Propagation\n'));

  if (!options.search || !options.correction) {
    console.log(chalk.red('  Usage: uap memory correct <search> --correction <corrected> [--reason <reason>]'));
    return;
  }

  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  try {
    config = existsSync(configPath)
      ? AgentContextConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')))
      : { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  } catch {
    config = { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  }

  const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
  const result = propagateCorrection(dbPath, options.search, options.correction, options.reason || 'user correction');

  if (result.originalFound) {
    console.log(chalk.green(`  ✓ Found and corrected across ${result.tiersUpdated.length} tiers`));
    console.log(chalk.dim(`    Tiers updated: ${result.tiersUpdated.join(', ')}`));
    console.log(chalk.dim(`    Superseded entries: ${result.supersededCount}`));
    if (result.originalContent) {
      console.log(chalk.dim(`    Original: ${result.originalContent.slice(0, 100)}...`));
    }
    console.log(chalk.dim(`    Corrected: ${options.correction}`));
  } else {
    console.log(chalk.yellow(`  No matching entries found for: "${options.search}"`));
    console.log(chalk.dim('  The correction was still logged to the daily log for reference.'));
  }
  console.log('');
}

async function maintainMemory(cwd: string, _options: MemoryOptions): Promise<void> {
  console.log(chalk.bold('\n🔧 Memory Maintenance\n'));

  const configPath = join(cwd, '.uap.json');
  let config: AgentContextConfig;
  try {
    config = existsSync(configPath)
      ? AgentContextConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')))
      : { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  } catch {
    config = { version: '1.0.0', project: { name: 'project', defaultBranch: 'main' } };
  }

  const dbPath = config.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');
  const spinner = ora('Running maintenance cycle...').start();

  const result = runMaintenance(dbPath);
  spinner.succeed('Maintenance complete');

  console.log('');
  console.log(chalk.dim(`  Decayed entries updated: ${result.decayedEntriesUpdated}`));
  console.log(chalk.dim(`  Stale entries pruned: ${result.staleEntriesPruned}`));
  console.log(chalk.dim(`  Daily logs archived: ${result.dailyLogsArchived}`));
  console.log(chalk.dim(`  Duplicates removed: ${result.duplicatesRemoved}`));
  if (result.staleWorktrees.length > 0) {
    console.log(chalk.yellow(`  Stale worktrees: ${result.staleWorktrees.length}`));
  }
  console.log('');

  if (result.recommendations.length > 0) {
    console.log(chalk.bold('  Recommendations:'));
    for (const rec of result.recommendations) {
      console.log(`    ${chalk.yellow('•')} ${rec}`);
    }
  }
  console.log('');
}
