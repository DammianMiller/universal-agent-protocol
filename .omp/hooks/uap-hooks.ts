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
const POLICY_DB = join(PROJECT_DIR, 'agents/data/memory/policies.db');
const AGENT_ID = `omp-${Date.now().toString(36)}`;

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
      DELETE FROM work_announcements WHERE agent_id IN (
        SELECT id FROM agent_registry
        WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours')
      ) AND completed_at IS NULL;
      UPDATE agent_registry SET status='failed'
        WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours');
    `
    );

    // Register this agent
    runSql(
      COORD_DB,
      `INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, capabilities, started_at, last_heartbeat)
       VALUES ('${AGENT_ID}', 'omp', '${AGENT_ID}', 'active', '[]', datetime('now'), datetime('now'));`
    );

    // Auto-announce session
    runSql(
      COORD_DB,
      `INSERT INTO work_announcements (agent_id, agent_name, intent_type, resource, description, announced_at)
       VALUES ('${AGENT_ID}', 'omp', 'editing', 'session-scope', 'Session ${AGENT_ID} active', datetime('now'));`
    );

    // Detect overlaps
    const overlaps = runSql(
      COORD_DB,
      `SELECT agent_id || ' on ' || resource || ' (' || intent_type || ')'
       FROM work_announcements
       WHERE completed_at IS NULL AND agent_id != '${AGENT_ID}'
       ORDER BY announced_at DESC LIMIT 5;`
    );
    if (overlaps) {
      output.push('<uap-context>');
      output.push('## Agent Overlap Warning');
      output.push(overlaps);
      output.push('Run `uap agent overlaps` before editing shared files.');
      output.push('</uap-context>');
    }
  }

  // Policy summary
  if (existsSync(POLICY_DB)) {
    const activePolicies = runSql(POLICY_DB, `SELECT COUNT(*) FROM policies WHERE isActive=1;`);
    const requiredPolicies = runSql(POLICY_DB, `SELECT COUNT(*) FROM policies WHERE isActive=1 AND level='REQUIRED';`);
    if (activePolicies) {
      output.push(`<uap-context>Policies: ${activePolicies} active (${requiredPolicies} REQUIRED)</uap-context>`);
    }
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

  // Flush pending deploys before session ends
  if (existsSync(COORD_DB)) {
    const pending = runSql(COORD_DB, `SELECT COUNT(*) FROM deploy_queue WHERE status='pending';`);
    if (parseInt(pending, 10) > 0) {
      const cliPath = join(PROJECT_DIR, 'dist/bin/cli.js');
      if (existsSync(cliPath)) {
        try {
          execSync(`node "${cliPath}" deploy flush`, { stdio: 'pipe', encoding: 'utf-8' });
        } catch { /* best effort */ }
      }
    }

    // Close announcements and deregister agent
    runSql(
      COORD_DB,
      `UPDATE work_announcements SET completed_at=datetime('now')
         WHERE agent_id='${AGENT_ID}' AND completed_at IS NULL;
       UPDATE agent_registry SET status='completed' WHERE id='${AGENT_ID}';`
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
