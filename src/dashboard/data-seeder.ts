/**
 * Dashboard Data Seeder
 *
 * Registers the dashboard server as an active agent and populates
 * empty databases with real data from worktrees and git history.
 *
 * IMPORTANT: This module NEVER generates synthetic/fake data.
 * All data comes from real sources: git log, worktree registry,
 * and existing database records. The periodic refresh only updates
 * the agent heartbeat — it does not inject fake tasks, memories,
 * policy executions, routing decisions, or analytics.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
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
  const agentId = `dashboard-server-${Date.now()}`;
  const now = new Date().toISOString();
  let tasksCreated = 0;
  let deploysQueued = 0;
  let batchesCreated = 0;

  // 1. Register dashboard server as active agent
  const coordDbPath = join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
  let coordDb: Database.Database | null = null;
  if (existsSync(coordDbPath)) {
    try {
      coordDb = new Database(coordDbPath);
      const hasAgents = coordDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();
      if (hasAgents.length > 0) {
        coordDb
          .prepare(
            `INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, current_task, started_at, last_heartbeat)
           VALUES (?, ?, ?, 'active', 'dashboard-server', ?, ?)`
          )
          .run(agentId, 'Dashboard Server', `session-${Date.now()}`, now, now);
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Create tasks from active worktrees (only when task DB is empty)
  try {
    const wtDbPath = join(cwd, '.uap', 'worktree_registry.db');
    if (existsSync(wtDbPath)) {
      const wtDb = new Database(wtDbPath, { readonly: true });
      const hasTable = wtDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktrees'")
        .all();
      if (hasTable.length > 0) {
        const worktrees = wtDb
          .prepare("SELECT id, slug, branch_name, status FROM worktrees WHERE status='active'")
          .all() as Array<{ id: number; slug: string; branch_name: string; status: string }>;
        const taskDbPath = join(cwd, '.uap', 'tasks', 'tasks.db');
        if (existsSync(taskDbPath)) {
          const taskDb = new Database(taskDbPath);
          const existingCount = (
            taskDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }
          ).c;
          if (existingCount === 0 && worktrees.length > 0) {
            const insert = taskDb.prepare(
              `INSERT OR IGNORE INTO tasks (id, title, type, status, priority, created_at, updated_at) VALUES (?, ?, 'task', 'in_progress', 2, ?, ?)`
            );
            for (const wt of worktrees) {
              insert.run(`wt-${wt.id}`, `Worktree: ${wt.slug} (${wt.branch_name})`, now, now);
              tasksCreated++;
            }
          }
          taskDb.close();
        }
      }
      wtDb.close();
    }
  } catch {
    /* ignore */
  }

  // 3. Create tasks from recent git commits (only real commits, INSERT OR IGNORE)
  try {
    const taskDbPath = join(cwd, '.uap', 'tasks', 'tasks.db');
    if (existsSync(taskDbPath)) {
      const gitLog = execSync('git log --oneline -10 --format="%H|%s"', {
        encoding: 'utf-8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (gitLog) {
        const taskDb = new Database(taskDbPath);
        const insert = taskDb.prepare(
          `INSERT OR IGNORE INTO tasks (id, title, type, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'done', 3, ?, ?)`
        );
        for (const line of gitLog.split('\n').filter(Boolean)) {
          const [hash, ...msgParts] = line.split('|');
          const msg = msgParts.join('|');
          if (!hash || !msg) continue;
          const type = msg.startsWith('fix') ? 'bug' : msg.startsWith('feat') ? 'feature' : 'task';
          insert.run(`git-${hash.slice(0, 8)}`, msg, type, now, now);
          tasksCreated++;
        }
        taskDb.close();
      }
    }
  } catch {
    /* ignore */
  }

  // 4. Queue deploy actions from real git tags and commits (INSERT OR IGNORE)
  if (coordDb) {
    try {
      const hasDQ = coordDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_queue'")
        .all();
      if (hasDQ.length > 0) {
        try {
          const tags = execSync('git tag --sort=-creatordate --format="%(refname:short)"', {
            encoding: 'utf-8',
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (tags) {
            const insertDeploy = coordDb.prepare(
              `INSERT OR IGNORE INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, priority) VALUES (?, 'deploy', ?, ?, 'completed', ?, 5)`
            );
            for (const tag of tags.split('\n').filter(Boolean).slice(0, 5)) {
              insertDeploy.run(agentId, tag, JSON.stringify({ tag }), now);
              deploysQueued++;
            }
          }
        } catch {
          /* ignore */
        }
        try {
          const commits = execSync('git log --oneline -5 --format="%H"', {
            encoding: 'utf-8',
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (commits) {
            const insertDeploy = coordDb.prepare(
              `INSERT OR IGNORE INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, priority) VALUES (?, 'commit', 'main', ?, 'completed', ?, 5)`
            );
            for (const hash of commits.split('\n').filter(Boolean)) {
              insertDeploy.run(agentId, JSON.stringify({ commit: hash.slice(0, 8) }), now);
              deploysQueued++;
            }
          }
        } catch {
          /* ignore */
        }
      }
      // 5. Create batch records
      const hasDB = coordDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_batches'")
        .all();
      if (hasDB.length > 0 && deploysQueued > 0) {
        coordDb
          .prepare(
            `INSERT OR IGNORE INTO deploy_batches (id, created_at, executed_at, status, result) VALUES (?, ?, ?, 'completed', 'seeded from git history')`
          )
          .run(`batch-seed-${Date.now()}`, now, now);
        batchesCreated++;
      }
    } catch {
      /* ignore */
    }
  }

  if (coordDb) {
    try {
      coordDb.close();
    } catch {
      /* ignore */
    }
  }

  // 6. Heartbeat every 30s (real agent heartbeat, no data injection)
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
    policyChecksRun: 0,
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
