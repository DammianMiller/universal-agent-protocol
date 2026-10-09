/**
 * Dashboard Data Seeder
 *
 * Registers the dashboard server as an agent (status 'idle' — it is not doing
 * agent WORK, so it must not inflate the "Active Agents" counts) and seeds
 * policy files into an empty policies DB. Nothing else.
 *
 * IMPORTANT: This module NEVER generates synthetic/fake data. A git commit is
 * not a task and a worktree is not a task — earlier versions fabricated
 * `git-*` and `wt-*` task rows from them, which polluted task counts and the
 * kanban with entities no one created or manages (dash audit). Those paths
 * are gone. The periodic refresh only updates the agent heartbeat — it does
 * not inject tasks, memories, policy executions, routing decisions, or
 * analytics.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

export interface SeederState {
  agentId: string;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  refreshInterval: null; // kept for interface compat; no periodic data injection
  seededAt: string;
  tasksCreated: number;
  deploysQueued: number;
  batchesCreated: number;
  policyChecksRun: number;
}

let seederState: SeederState | null = null;

export function seedDashboardData(cwd: string): SeederState {
  const agentId = `dashboard-server-${process.pid}`;
  const now = new Date().toISOString();
  const tasksCreated = 0;
  const deploysQueued = 0;
  const batchesCreated = 0;

  // 1. Register dashboard server as an agent — status 'idle'. It is a real
  // coordination participant (it mutates tasks/policies via its routes), but
  // it is not doing agent WORK, so 'active' would inflate the "Active Agents"
  // tile and the agents panel.
  const coordDbPath = join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
  let coordDb: Database.Database | null = null;
  if (existsSync(coordDbPath)) {
    try {
      coordDb = new Database(coordDbPath);
      const hasAgents = coordDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();
      if (hasAgents.length > 0) {
        // Retire rows from previous dash processes (they are dead and their
        // heartbeats are frozen — leaving them 'idle' would pile up forever).
        coordDb
          .prepare(
            `UPDATE agent_registry SET status = 'completed' WHERE id LIKE 'dashboard-server-%' AND id != ?`
          )
          .run(agentId);
        coordDb
          .prepare(
            `INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, current_task, started_at, last_heartbeat)
           VALUES (?, ?, ?, 'idle', 'dashboard-server', ?, ?)`
          )
          .run(agentId, 'Dashboard Server', `session-dash-${process.pid}`, now, now);
      }
    } catch {
      /* ignore */
    }
  }

  // NOTE: tasks.db is intentionally NOT seeded — not from worktrees (a
  // worktree is not a task) and not from git log (a commit is not a task).
  // Fabricated `wt-*`/`git-*` rows polluted the task counts and the kanban
  // with entities no one created or manages. The Tasks tab is honestly
  // empty until real tasks are created (via `uap task create` or the UI).
  //
  // NOTE: deploy_queue / deploy_batches are intentionally NOT seeded from git.
  // A git tag or commit is not a deploy event; inserting them as status='completed'
  // deploys (timestamped at seed time) would be synthetic data — which this module
  // promises never to generate. The Deploy panel therefore reflects only real
  // deploy_queue rows written by the actual deploy path (honest-empty until then).

  if (coordDb) {
    try {
      coordDb.close();
    } catch {
      /* ignore */
    }
  }

  // 6. Seed policy files from policies/ directory into policies.db (INSERT OR IGNORE)
  let policiesSeeded = 0;
  try {
    const policiesDir = join(cwd, 'policies');
    const policyDbPath = join(cwd, 'agents', 'data', 'memory', 'policies.db');
    if (existsSync(policiesDir) && existsSync(policyDbPath)) {
      const policyDb = new Database(policyDbPath);
      const hasPolicies = policyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policies'")
        .all();
      if (hasPolicies.length > 0) {
        const existingCount = (
          policyDb.prepare('SELECT COUNT(*) as c FROM policies').get() as { c: number }
        ).c;
        if (existingCount === 0) {
          const files = readdirSync(policiesDir).filter(
            (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md'
          );
          const insertPolicy = policyDb.prepare(
            `INSERT OR IGNORE INTO policies (id, name, category, level, rawMarkdown, tags, createdAt, updatedAt, version, isActive, priority, enforcementStage)
             VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 1, 1, ?, ?)`
          );
          for (const file of files) {
            const nameWithoutExt = file.replace(/\.md$/, '');
            const name = nameWithoutExt
              .split('-')
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');

            let rawMarkdown = '';
            try {
              rawMarkdown = readFileSync(join(policiesDir, file), 'utf-8');
            } catch {
              /* ignore unreadable files */
            }

            // Derive category from filename
            let category = 'general';
            if (nameWithoutExt.includes('iac') || nameWithoutExt.includes('pipeline')) category = 'infrastructure';
            else if (nameWithoutExt.includes('worktree') || nameWithoutExt.includes('file')) category = 'workflow';
            else if (nameWithoutExt.includes('gate') || nameWithoutExt.includes('completion') || nameWithoutExt.includes('mandatory')) category = 'quality';
            else if (nameWithoutExt.includes('semver') || nameWithoutExt.includes('version')) category = 'versioning';
            else if (nameWithoutExt.includes('backup')) category = 'safety';
            else if (nameWithoutExt.includes('kubectl') || nameWithoutExt.includes('backport')) category = 'operations';

            // Extract level from markdown content
            let level = 'RECOMMENDED';
            const levelMatch = rawMarkdown.match(/\*\*Level\*\*:\s*(REQUIRED|RECOMMENDED|OPTIONAL)/i);
            if (levelMatch) level = levelMatch[1].toUpperCase();
            else if (nameWithoutExt.includes('gate') || nameWithoutExt.includes('mandatory')) level = 'REQUIRED';

            // Extract enforcement stage
            let stage = 'pre-exec';
            const stageMatch = rawMarkdown.match(/\*\*Enforcement Stage\*\*:\s*([\w-]+)/);
            if (stageMatch && ['pre-exec', 'post-exec', 'review', 'always'].includes(stageMatch[1])) {
              stage = stageMatch[1];
            }

            // Priority: quality/safety policies higher
            const priority = category === 'quality' ? 80 : category === 'safety' ? 70 : 50;

            insertPolicy.run(
              `policy-${nameWithoutExt}`,
              name,
              category,
              level,
              rawMarkdown,
              now, now,
              priority,
              stage
            );
            policiesSeeded++;
          }
        }
      }
      policyDb.close();
    }
  } catch {
    /* ignore */
  }

  // 7. Heartbeat every 30s (real agent heartbeat, no data injection)
  const heartbeatInterval = setInterval(() => {
    if (!existsSync(coordDbPath)) return;
    try {
      const db = new Database(coordDbPath);
      db.prepare(`UPDATE agent_registry SET last_heartbeat = ? WHERE id = ?`).run(
        new Date().toISOString(),
        agentId
      );
      db.close();
    } catch {
      /* ignore */
    }
  }, 30_000);

  seederState = {
    agentId,
    heartbeatInterval,
    refreshInterval: null,
    seededAt: now,
    tasksCreated,
    deploysQueued,
    batchesCreated,
    policyChecksRun: policiesSeeded,
  };
  return seederState;
}

export function cleanupSeeder(cwd: string): void {
  if (!seederState) return;
  if (seederState.heartbeatInterval) {
    clearInterval(seederState.heartbeatInterval);
    seederState.heartbeatInterval = null;
  }
  const coordDbPath = join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath);
      db.prepare(`UPDATE agent_registry SET status = 'completed' WHERE id = ?`).run(
        seederState.agentId
      );
      db.close();
    } catch {
      /* ignore */
    }
  }
  seederState = null;
}

export function getSeederState(): SeederState | null {
  return seederState;
}
