/**
 * Dashboard Data Seeder
 *
 * Seeds dashboard databases with real data from worktrees, git history,
 * and active policies. Registers the dashboard server as an active agent
 * with heartbeat for coordination visibility.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

export interface SeederState {
  agentId: string;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  seededAt: string;
  tasksCreated: number;
  deploysQueued: number;
  batchesCreated: number;
}

let seederState: SeederState | null = null;

/**
 * Seed dashboard data from real project state.
 *
 * - Registers dashboard server as active agent
 * - Creates tasks from active worktrees and git commits
 * - Generates deploy queue entries from git tags/commits
 * - Creates batch records
 */
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
      /* ignore - coordination DB may not exist yet */
    }
  }

  // 2. Create tasks from active worktrees
  try {
    const wtDbPath = join(cwd, '.uap', 'worktree_registry.db');
    if (existsSync(wtDbPath)) {
      const wtDb = new Database(wtDbPath, { readonly: true });
      const hasTable = wtDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktrees'")
        .all();

      if (hasTable.length > 0) {
        const worktrees = wtDb
          .prepare("SELECT id, slug, branch, status FROM worktrees WHERE status='active'")
          .all() as Array<{ id: string; slug: string; branch: string; status: string }>;

        const taskDbPath = join(cwd, '.uap', 'tasks', 'tasks.db');
        if (existsSync(taskDbPath)) {
          const taskDb = new Database(taskDbPath);

          // Check existing count to avoid duplicates
          const existingCount = (
            taskDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }
          ).c;

          if (existingCount === 0 && worktrees.length > 0) {
            const insert = taskDb.prepare(
              `INSERT OR IGNORE INTO tasks (id, title, type, status, priority, created_at, updated_at)
               VALUES (?, ?, 'task', 'open', 2, ?, ?)`
            );
            for (const wt of worktrees) {
              const taskId = `wt-${wt.id}`;
              insert.run(taskId, `Worktree: ${wt.slug} (${wt.branch})`, now, now);
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

  // 3. Create tasks from recent git commits
  try {
    const taskDbPath = join(cwd, '.uap', 'tasks', 'tasks.db');
    if (existsSync(taskDbPath)) {
      const gitLog = execSync('git log --oneline -10 --format="%H|%s" 2>/dev/null || true', {
        encoding: 'utf-8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (gitLog) {
        const taskDb = new Database(taskDbPath);
        const insert = taskDb.prepare(
          `INSERT OR IGNORE INTO tasks (id, title, type, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, 'done', 3, ?, ?)`
        );

        for (const line of gitLog.split('\n').filter(Boolean)) {
          const [hash, ...msgParts] = line.split('|');
          const msg = msgParts.join('|');
          if (!hash || !msg) continue;

          const taskId = `git-${hash.slice(0, 8)}`;
          const type = msg.startsWith('fix') ? 'bug' : msg.startsWith('feat') ? 'feature' : 'task';
          insert.run(taskId, msg, type, now, now);
          tasksCreated++;
        }

        taskDb.close();
      }
    }
  } catch {
    /* ignore */
  }

  // 4. Queue deploy actions from git tags and commits
  if (coordDb) {
    try {
      const hasDQ = coordDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_queue'")
        .all();

      if (hasDQ.length > 0) {
        // Deploy actions from git tags
        try {
          const tags = execSync('git tag --sort=-creatordate 2>/dev/null | head -5 || true', {
            encoding: 'utf-8',
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          if (tags) {
            const insertDeploy = coordDb.prepare(
              `INSERT OR IGNORE INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, priority)
               VALUES (?, 'deploy', ?, ?, 'completed', ?, 5)`
            );

            for (const tag of tags.split('\n').filter(Boolean)) {
              insertDeploy.run(agentId, tag, JSON.stringify({ tag }), now);
              deploysQueued++;
            }
          }
        } catch {
          /* ignore */
        }

        // Deploy actions from recent commits
        try {
          const commits = execSync('git log --oneline -5 --format="%H" 2>/dev/null || true', {
            encoding: 'utf-8',
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          if (commits) {
            const insertDeploy = coordDb.prepare(
              `INSERT OR IGNORE INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, priority)
               VALUES (?, 'commit', 'main', ?, 'completed', ?, 5)`
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
        const batchId = `batch-seed-${Date.now()}`;
        coordDb
          .prepare(
            `INSERT OR IGNORE INTO deploy_batches (id, created_at, executed_at, status, result)
             VALUES (?, ?, ?, 'completed', 'seeded from git history')`
          )
          .run(batchId, now, now);
        batchesCreated++;
      }
    } catch {
      /* ignore */
    }
  }

  // Set up heartbeat interval (30s)
  const heartbeatInterval = setInterval(() => {
    if (!existsSync(coordDbPath)) return;
    try {
      const db = new Database(coordDbPath);
      const hasAgents = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();
      if (hasAgents.length > 0) {
        db.prepare(`UPDATE agent_registry SET last_heartbeat = ? WHERE id = ?`).run(
          new Date().toISOString(),
          agentId
        );
      }
      db.close();
    } catch {
      /* ignore */
    }
  }, 30_000);

  if (coordDb) {
    try {
      coordDb.close();
    } catch {
      /* ignore */
    }
  }

  seederState = {
    agentId,
    heartbeatInterval,
    seededAt: now,
    tasksCreated,
    deploysQueued,
    batchesCreated,
  };

  return seederState;
}

/**
 * Cleanup seeder: clear heartbeat, mark agent as completed.
 */
export function cleanupSeeder(cwd: string): void {
  if (!seederState) return;

  // Clear heartbeat
  if (seederState.heartbeatInterval) {
    clearInterval(seederState.heartbeatInterval);
    seederState.heartbeatInterval = null;
  }

  // Mark agent as completed
  const coordDbPath = join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath);
      const hasAgents = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();
      if (hasAgents.length > 0) {
        db.prepare(`UPDATE agent_registry SET status = 'completed' WHERE id = ?`).run(
          seederState.agentId
        );
      }
      db.close();
    } catch {
      /* ignore */
    }
  }

  seederState = null;
}

/**
 * Get the current seeder state, or null if not running.
 */
export function getSeederState(): SeederState | null {
  return seederState;
}
