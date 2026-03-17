// UAP Hooks for Oh-My-Pi (omp)
// Provides session lifecycle hooks with memory injection and context preservation

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * UAP Integration Hooks for Oh-My-Pi
 *
 * These hooks provide deep integration between oh-my-pi and UAP:
 * - Pre-session: Inject memory context, clean stale agents, check task readiness
 * - Post-session: Save lessons, update memory, cleanup agent registrations
 * - Tool execution: Enforce UAP patterns via policy gate
 */

const PROJECT_DIR = process.env.UAP_PROJECT_DIR || process.cwd();
const DB_PATH = join(PROJECT_DIR, 'agents/data/memory/short_term.db');
const COORD_DB = join(PROJECT_DIR, 'agents/data/coordination/coordination.db');

function runSql(dbPath: string, sql: string): string {
  try {
    return execSync(`sqlite3 "${dbPath}" "${sql}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export function preSession(): string {
  if (!existsSync(DB_PATH)) return '';

  const output: string[] = [];

  // Clean stale agents (>24h heartbeat)
  if (existsSync(COORD_DB)) {
    runSql(
      COORD_DB,
      `
      DELETE FROM work_claims WHERE agent_id IN (
        SELECT id FROM agent_registry
        WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours')
      );
      UPDATE agent_registry SET status='failed'
        WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours');
    `
    );
  }

  // Load recent memories
  const memories = runSql(
    DB_PATH,
    `
    SELECT type || ': ' || content FROM memories
    WHERE timestamp >= datetime('now', '-1 day')
    ORDER BY id DESC LIMIT 10;
  `
  );

  if (memories) {
    output.push('<uap-context>');
    output.push('## Recent UAP Memories');
    output.push(memories);
    output.push('</uap-context>');
  }

  // Load open loops
  const openLoops = runSql(
    DB_PATH,
    `
    SELECT content FROM session_memories
    WHERE importance >= 7
    ORDER BY timestamp DESC LIMIT 5;
  `
  );

  if (openLoops) {
    output.push('<uap-context>');
    output.push('## Open Loops');
    output.push(openLoops);
    output.push('</uap-context>');
  }

  return output.join('\n');
}

export function postSession(): void {
  if (!existsSync(DB_PATH)) return;

  const timestamp = new Date().toISOString();

  // Record session end
  runSql(
    DB_PATH,
    `
    INSERT OR IGNORE INTO memories (timestamp, type, content)
    VALUES ('${timestamp}', 'action', '[post-session] Session completed at ${timestamp}');
  `
  );

  // Clean up active agents from this session
  if (existsSync(COORD_DB)) {
    runSql(
      COORD_DB,
      `
      UPDATE agent_registry SET status='completed'
        WHERE status='active' AND last_heartbeat >= datetime('now','-10 minutes');
    `
    );
  }
}

export function getModelConfig(): {
  planner: string;
  executor: string;
  fallback: string;
  strategy: string;
} {
  return {
    planner: 'opus-4.6',
    executor: 'qwen35',
    fallback: 'qwen35',
    strategy: 'balanced',
  };
}

export default function uapHooks(): void {
  console.log('[UAP-Hooks] Oh-My-Pi integration loaded');
  console.log(`[UAP-Hooks] Model routing: planner=opus-4.6, executor=qwen35`);
  console.log(`[UAP-Hooks] Memory DB: ${existsSync(DB_PATH) ? 'found' : 'not found'}`);
  console.log(`[UAP-Hooks] Coordination DB: ${existsSync(COORD_DB) ? 'found' : 'not found'}`);
}
