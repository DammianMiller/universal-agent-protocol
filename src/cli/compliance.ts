import chalk from 'chalk';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { AgentContextConfigSchema } from '../types/index.js';
import type { AgentContextConfig } from '../types/index.js';
import {
  ensureShortTermSchema,
  ensureSessionSchema,
  ensureKnowledgeSchema,
  initializeMemoryDatabase,
} from '../memory/short-term/schema.js';

type ComplianceAction = 'check' | 'audit' | 'fix';

interface ComplianceOptions {
  verbose?: boolean;
  fix?: boolean;
}

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fixable?: boolean;
}

export async function complianceCommand(
  action: ComplianceAction,
  options: ComplianceOptions = {}
): Promise<void> {
  const cwd = process.cwd();

  switch (action) {
    case 'check':
      await runComplianceCheck(cwd, options);
      break;
    case 'audit':
      await runComplianceAudit(cwd, options);
      break;
    case 'fix':
      await runComplianceFix(cwd, options);
      break;
  }
}

async function runComplianceCheck(cwd: string, options: ComplianceOptions = {}): Promise<void> {
  console.log(chalk.bold('\n=== UAP Protocol Compliance Check ===\n'));

  const results: CheckResult[] = [];
  const config = loadConfig(cwd);
  const dbPath = config?.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');

  // Gate 1: Memory database exists
  if (existsSync(dbPath)) {
    results.push({ name: 'Memory database', status: 'pass', message: 'Database exists' });
  } else {
    results.push({
      name: 'Memory database',
      status: 'fail',
      message: 'Database not found',
      fixable: true,
    });
  }

  // Gate 2: Schema tables exist
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((t) => t.name);

      for (const table of ['memories', 'session_memories', 'entities', 'relationships']) {
        if (tables.includes(table)) {
          results.push({ name: `Table '${table}'`, status: 'pass', message: 'Exists' });
        } else {
          results.push({
            name: `Table '${table}'`,
            status: 'fail',
            message: 'Missing',
            fixable: true,
          });
        }
      }

      // Gate 3: FTS5 index
      if (tables.includes('memories_fts')) {
        results.push({ name: 'FTS5 index', status: 'pass', message: 'Full-text search available' });
      } else {
        results.push({ name: 'FTS5 index', status: 'fail', message: 'Missing', fixable: true });
      }

      // Gate 4: Schema compliance — entities has description column
      const entityCols = (
        db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (entityCols.includes('description')) {
        results.push({ name: 'entities.description', status: 'pass', message: 'Column exists' });
      } else {
        results.push({
          name: 'entities.description',
          status: 'warn',
          message: 'Missing column (run uap compliance fix)',
          fixable: true,
        });
      }

      // Gate 5: Schema compliance — relationships has strength column
      const relCols = (
        db.prepare('PRAGMA table_info(relationships)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (relCols.includes('strength')) {
        results.push({ name: 'relationships.strength', status: 'pass', message: 'Column exists' });
      } else {
        results.push({
          name: 'relationships.strength',
          status: 'warn',
          message: 'Missing column (run uap compliance fix)',
          fixable: true,
        });
      }

      // Gate 6: Schema compliance — memories allows 'lesson' type
      try {
        db.close();
        const dbRW = new Database(dbPath);
        try {
          dbRW
            .prepare(
              "INSERT INTO memories (timestamp, type, content) VALUES ('__test__', 'lesson', '__test__')"
            )
            .run();
          dbRW.exec("DELETE FROM memories WHERE content = '__test__' AND timestamp = '__test__'");
          results.push({
            name: 'memories.type (lesson)',
            status: 'pass',
            message: 'Lesson type allowed',
          });
        } catch {
          results.push({
            name: 'memories.type (lesson)',
            status: 'warn',
            message: 'Lesson type blocked by old CHECK constraint',
            fixable: true,
          });
        }
        dbRW.close();
      } catch {
        results.push({
          name: 'memories.type (lesson)',
          status: 'warn',
          message: 'Could not verify type constraint',
        });
      }

      // Gate 7: Recent memory activity
      try {
        const dbCheck = new Database(dbPath, { readonly: true });
        const recent = dbCheck
          .prepare(
            "SELECT COUNT(*) as cnt FROM memories WHERE timestamp >= datetime('now', '-2 hours')"
          )
          .get() as { cnt: number };
        if (recent.cnt > 0) {
          results.push({
            name: 'Recent activity',
            status: 'pass',
            message: `${recent.cnt} entries in last 2 hours`,
          });
        } else {
          results.push({
            name: 'Recent activity',
            status: 'warn',
            message: 'No entries in last 2 hours',
          });
        }

        // Gate 8: Session memories exist
        const sessionCount = dbCheck
          .prepare('SELECT COUNT(*) as cnt FROM session_memories')
          .get() as { cnt: number };
        if (sessionCount.cnt > 0) {
          results.push({
            name: 'Session memories',
            status: 'pass',
            message: `${sessionCount.cnt} session memories stored`,
          });
        } else {
          results.push({
            name: 'Session memories',
            status: 'warn',
            message: 'No session memories stored yet',
          });
        }

        dbCheck.close();
      } catch {
        // ignore
      }
    } catch (err) {
      results.push({
        name: 'Database access',
        status: 'fail',
        message: `Cannot open database: ${err}`,
      });
    }
  }

  // Gate 9: Coordination database
  const coordPath = join(cwd, 'agents/data/coordination/coordination.db');
  if (existsSync(coordPath)) {
    results.push({ name: 'Coordination DB', status: 'pass', message: 'Exists' });
  } else {
    results.push({
      name: 'Coordination DB',
      status: 'warn',
      message: 'Not found (single-agent mode)',
    });
  }

  // Gate 10: Qdrant collections
  try {
    const endpoint = config?.memory?.longTerm?.endpoint || 'localhost:6333';
    const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
    const res = await fetch(`${url}/collections`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as { result: { collections: Array<{ name: string }> } };
      const collections = data.result.collections.map((c) => c.name);

      const requiredCollection = config?.memory?.longTerm?.collection || 'agent_memory';
      if (collections.includes(requiredCollection)) {
        results.push({ name: 'Qdrant L3 collection', status: 'pass', message: `Collection found` });
      } else {
        results.push({
          name: 'Qdrant L3 collection',
          status: 'warn',
          message: `Collection '${requiredCollection}' not found`,
          fixable: true,
        });
      }

      const patternCollection = config?.memory?.patternRag?.collection || 'agent_patterns';
      if (collections.includes(patternCollection)) {
        // Check if it has points
        try {
          const colRes = await fetch(`${url}/collections/${patternCollection}`, {
            signal: AbortSignal.timeout(2000),
          });
          if (colRes.ok) {
            const colData = (await colRes.json()) as { result: { points_count: number } };
            if (colData.result.points_count > 0) {
              results.push({
                name: 'Pattern RAG collection',
                status: 'pass',
                message: `${colData.result.points_count} patterns indexed`,
              });
            } else {
              results.push({
                name: 'Pattern RAG collection',
                status: 'warn',
                message: 'Collection exists but is empty (run uap patterns index)',
                fixable: true,
              });
            }
          }
        } catch {
          results.push({
            name: 'Pattern RAG collection',
            status: 'warn',
            message: 'Could not check collection',
          });
        }
      } else {
        results.push({
          name: 'Pattern RAG collection',
          status: 'warn',
          message: `Collection '${patternCollection}' not found`,
        });
      }
    } else {
      results.push({ name: 'Qdrant', status: 'warn', message: 'Not responding' });
    }
  } catch {
    results.push({
      name: 'Qdrant',
      status: 'warn',
      message: 'Not reachable (optional for L3/Pattern RAG)',
    });
  }

  // Gate 11: Worktree compliance
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch === 'main' || branch === 'master') {
      results.push({
        name: 'Worktree compliance',
        status: 'warn',
        message: `On ${branch} branch — use a feature branch for changes`,
      });
    } else {
      results.push({
        name: 'Worktree compliance',
        status: 'pass',
        message: `On feature branch: ${branch}`,
      });
    }

    // Check for stale worktrees
    const worktreeOutput = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prunable = (worktreeOutput.match(/prunable/g) || []).length;
    if (prunable > 0) {
      results.push({
        name: 'Stale worktrees',
        status: 'warn',
        message: `${prunable} prunable worktrees (run git worktree prune)`,
        fixable: true,
      });
    } else {
      results.push({ name: 'Stale worktrees', status: 'pass', message: 'No stale worktrees' });
    }
  } catch {
    results.push({ name: 'Git', status: 'warn', message: 'Not a git repository' });
  }

  // Gate 12: No secrets in staged files
  try {
    const staged = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (staged) {
      const secretPatterns = execSync(
        'git diff --cached | grep -iE "(password|secret|api_key|token|private_key)" || true',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (secretPatterns) {
        results.push({
          name: 'Secret detection',
          status: 'fail',
          message: 'Potential secrets in staged files!',
        });
      } else {
        results.push({ name: 'Secret detection', status: 'pass', message: 'No secrets detected' });
      }
    } else {
      results.push({ name: 'Secret detection', status: 'pass', message: 'No staged files' });
    }
  } catch {
    results.push({ name: 'Secret detection', status: 'pass', message: 'No staged changes' });
  }

  // Print results
  const passes = results.filter((r) => r.status === 'pass').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const fails = results.filter((r) => r.status === 'fail').length;

  for (const r of results) {
    const icon =
      r.status === 'pass'
        ? chalk.green('✅')
        : r.status === 'warn'
          ? chalk.yellow('⚠️')
          : chalk.red('❌');
    console.log(`${icon} ${r.name}: ${r.message}`);
    if (options.verbose && r.status !== 'pass') {
      if (r.fixable) {
        console.log(chalk.dim(`     → Auto-fixable: run 'uap compliance fix'`));
      }
      if (r.status === 'fail') {
        console.log(chalk.dim(`     → This gate blocks compliance`));
      }
    }
  }

  console.log('');
  console.log(chalk.bold('========================================'));
  console.log(
    chalk.bold(
      `  COMPLIANCE: ${passes}/${results.length} passed, ${warns} warnings, ${fails} failures`
    )
  );
  console.log(chalk.bold('========================================'));

  if (fails > 0) {
    console.log(chalk.red('\n❌ UAP Protocol NON-COMPLIANT'));
    const fixable = results.filter((r) => r.fixable && r.status !== 'pass');
    if (fixable.length > 0) {
      console.log(
        chalk.yellow(`\n${fixable.length} issues are auto-fixable. Run: uap compliance fix`)
      );
    }
  } else if (warns > 0) {
    console.log(chalk.yellow('\n⚠️  UAP Protocol COMPLIANT with warnings'));
  } else {
    console.log(chalk.green('\n✅ UAP Protocol FULLY COMPLIANT'));
  }
  console.log('');
}

async function runComplianceAudit(cwd: string, _options: ComplianceOptions): Promise<void> {
  console.log(chalk.bold('\n=== UAP Protocol Deep Audit ===\n'));

  // Run check with verbose output
  await runComplianceCheck(cwd, { verbose: true });

  // Additional audit-only information
  const config = loadConfig(cwd);
  const dbPath = config?.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');

  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });

      console.log(chalk.bold('\n--- Memory Statistics ---'));
      const totalMemories = (
        db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }
      ).cnt;
      const totalSessions = (
        db.prepare('SELECT COUNT(*) as cnt FROM session_memories').get() as { cnt: number }
      ).cnt;
      const totalEntities = (
        db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }
      ).cnt;
      const totalRelationships = (
        db.prepare('SELECT COUNT(*) as cnt FROM relationships').get() as { cnt: number }
      ).cnt;

      console.log(`  Memories:      ${totalMemories}`);
      console.log(`  Sessions:      ${totalSessions}`);
      console.log(`  Entities:      ${totalEntities}`);
      console.log(`  Relationships: ${totalRelationships}`);

      // Memory type breakdown
      const types = db
        .prepare('SELECT type, COUNT(*) as cnt FROM memories GROUP BY type ORDER BY cnt DESC')
        .all() as Array<{ type: string; cnt: number }>;
      if (types.length > 0) {
        console.log(chalk.bold('\n--- Memory Type Breakdown ---'));
        for (const t of types) {
          console.log(`  ${t.type}: ${t.cnt}`);
        }
      }

      // Oldest and newest memory
      const oldest = db.prepare('SELECT timestamp FROM memories ORDER BY id ASC LIMIT 1').get() as
        | { timestamp: string }
        | undefined;
      const newest = db.prepare('SELECT timestamp FROM memories ORDER BY id DESC LIMIT 1').get() as
        | { timestamp: string }
        | undefined;
      if (oldest && newest) {
        console.log(chalk.bold('\n--- Memory Timeline ---'));
        console.log(`  Oldest: ${oldest.timestamp}`);
        console.log(`  Newest: ${newest.timestamp}`);
      }

      db.close();
    } catch {
      // ignore audit stats errors
    }
  }

  console.log('');
}

async function runComplianceFix(cwd: string, _options: ComplianceOptions): Promise<void> {
  console.log(chalk.bold('\n=== UAP Protocol Compliance Fix ===\n'));

  const config = loadConfig(cwd);
  const dbPath = config?.memory?.shortTerm?.path || join(cwd, 'agents/data/memory/short_term.db');

  // Fix 1: Initialize database if missing
  if (!existsSync(dbPath)) {
    console.log(chalk.cyan('Creating memory database...'));
    initializeMemoryDatabase(dbPath);
    console.log(chalk.green('✅ Memory database created'));
  }

  // Fix 2: Run schema migrations (adds missing columns, widens CHECK constraints)
  console.log(chalk.cyan('Running schema migrations...'));
  try {
    const db = new Database(dbPath);
    ensureShortTermSchema(db);
    ensureSessionSchema(db);
    ensureKnowledgeSchema(db);
    db.close();
    console.log(chalk.green('✅ Schema migrations applied'));
  } catch (err) {
    console.log(chalk.red(`❌ Schema migration failed: ${err}`));
  }

  // Fix 3: Create Qdrant collections if missing
  try {
    const endpoint = config?.memory?.longTerm?.endpoint || 'localhost:6333';
    const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
    const res = await fetch(`${url}/collections`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as { result: { collections: Array<{ name: string }> } };
      const existing = data.result.collections.map((c) => c.name);

      // Create agent_memory if missing
      const ltCollection = config?.memory?.longTerm?.collection || 'agent_memory';
      if (!existing.includes(ltCollection)) {
        console.log(chalk.cyan(`Creating Qdrant collection '${ltCollection}'...`));
        const createRes = await fetch(`${url}/collections/${ltCollection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
          signal: AbortSignal.timeout(5000),
        });
        if (createRes.ok) {
          console.log(chalk.green(`✅ Created Qdrant collection '${ltCollection}'`));
        } else {
          console.log(chalk.yellow(`⚠️  Could not create collection: ${await createRes.text()}`));
        }
      }

      // Create agent_patterns if missing
      const patternCollection = config?.memory?.patternRag?.collection || 'agent_patterns';
      if (!existing.includes(patternCollection)) {
        console.log(chalk.cyan(`Creating Qdrant collection '${patternCollection}'...`));
        const createRes = await fetch(`${url}/collections/${patternCollection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
          signal: AbortSignal.timeout(5000),
        });
        if (createRes.ok) {
          console.log(chalk.green(`✅ Created Qdrant collection '${patternCollection}'`));
        } else {
          console.log(chalk.yellow(`⚠️  Could not create collection: ${await createRes.text()}`));
        }
      }
    }
  } catch {
    console.log(chalk.yellow('⚠️  Qdrant not reachable — skipping collection creation'));
  }

  // Fix 4: Prune stale worktrees
  try {
    const worktreeOutput = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prunable = (worktreeOutput.match(/prunable/g) || []).length;
    if (prunable > 0) {
      console.log(chalk.cyan(`Pruning ${prunable} stale worktrees...`));
      execSync('git worktree prune', { stdio: 'pipe' });
      console.log(chalk.green(`✅ Pruned ${prunable} stale worktrees`));
    }
  } catch {
    // Not a git repo or no worktrees
  }

  console.log(
    chalk.green('\n✅ Compliance fixes applied. Run `uap compliance check` to verify.\n')
  );
}

function loadConfig(cwd: string): AgentContextConfig | null {
  const configPath = join(cwd, '.uap.json');
  if (!existsSync(configPath)) return null;
  try {
    return AgentContextConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
  } catch {
    return null;
  }
}
