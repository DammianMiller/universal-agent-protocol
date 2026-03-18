/**
 * Dashboard Data Service
 *
 * Extracts structured data from all UAP subsystems for consumption
 * by both the CLI dashboard and the web overlay.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { globalSessionStats } from '../mcp-router/session-stats.js';

// ── Types ──

export interface PolicyData {
  id: string;
  name: string;
  category: string;
  level: string;
  enforcementStage: string;
  isActive: boolean;
  tags: string[];
  priority: number;
}

export interface AuditEntry {
  policyId: string;
  operation: string;
  allowed: boolean;
  reason: string;
  executedAt: string;
  taskId?: string;
}

export interface MemoryData {
  l1: { entries: number; sizeKB: number };
  l2: { entries: number };
  l3: { status: string; uptime: string };
  l4: { entities: number; relationships: number };
  compression: {
    rawBytes: number;
    contextBytes: number;
    savingsPercent: string;
    totalCalls: number;
  };
}

export interface ModelData {
  roles: {
    planner: string;
    executor: string;
    reviewer: string;
    fallback: string;
  };
  strategy: string;
  sessionUsage: Array<{
    modelId: string;
    taskCount: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
    successRate: number;
  }>;
  totalCost: number;
}

export interface TaskData {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  open: number;
}

export interface CoordData {
  activeAgents: number;
  activeClaims: number;
  pendingDeploys: number;
}

export interface SystemData {
  version: string;
  branch: string;
  dirty: number;
}

export interface DashboardData {
  timestamp: string;
  system: SystemData;
  policies: PolicyData[];
  auditTrail: AuditEntry[];
  memory: MemoryData;
  models: ModelData;
  tasks: TaskData;
  coordination: CoordData;
}

// ── Data Gathering ──

export async function getDashboardData(): Promise<DashboardData> {
  const cwd = process.cwd();

  return {
    timestamp: new Date().toISOString(),
    system: getSystemData(cwd),
    policies: getPolicyData(cwd),
    auditTrail: getAuditData(cwd),
    memory: getMemoryData(cwd),
    models: getModelData(cwd),
    tasks: getTaskData(cwd),
    coordination: getCoordData(cwd),
  };
}

function getSystemData(cwd: string): SystemData {
  let version = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    version = pkg.version || '?';
  } catch {
    /* ignore */
  }

  let branch = '?';
  let dirty = 0;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    dirty = execSync('git status --porcelain', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean).length;
  } catch {
    /* ignore */
  }

  return { version, branch, dirty };
}

function getPolicyData(cwd: string): PolicyData[] {
  const dbPath = join(cwd, 'agents', 'data', 'memory', 'policies.db');
  if (!existsSync(dbPath)) return [];

  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT * FROM policies WHERE isActive = 1 ORDER BY priority DESC')
      .all() as Array<Record<string, unknown>>;
    db.close();
    return rows.map((r) => ({
      id: (r.id as string) || '',
      name: (r.name as string) || 'unnamed',
      category: (r.category as string) || 'general',
      level: (r.level as string) || 'info',
      enforcementStage: (r.enforcementStage as string) || 'pre-exec',
      isActive: r.isActive === 1,
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags as string[]) || [],
      priority: (r.priority as number) || 0,
    }));
  } catch {
    return [];
  }
}

function getAuditData(cwd: string): AuditEntry[] {
  const dbPath = join(cwd, 'agents', 'data', 'memory', 'policies.db');
  if (!existsSync(dbPath)) return [];

  try {
    const db = new Database(dbPath, { readonly: true });
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_executions'")
      .all();
    if (hasTable.length === 0) {
      db.close();
      return [];
    }
    const rows = db
      .prepare('SELECT * FROM policy_executions ORDER BY executedAt DESC LIMIT 20')
      .all() as Array<Record<string, unknown>>;
    db.close();
    return rows.map((r) => ({
      policyId: (r.policyId as string) || '',
      operation: (r.operation as string) || 'unknown',
      allowed: r.allowed === 1,
      reason: (r.reason as string) || '',
      executedAt: (r.executedAt as string) || '',
      taskId: (r.taskId as string) || undefined,
    }));
  } catch {
    return [];
  }
}

function getMemoryData(cwd: string): MemoryData {
  const memDbPath = join(cwd, 'agents/data/memory/short_term.db');
  let l1Entries = 0;
  let l1SizeKB = 0;
  let l2Entries = 0;
  let l4Entities = 0;
  let l4Relationships = 0;

  if (existsSync(memDbPath)) {
    try {
      l1SizeKB = Math.round(statSync(memDbPath).size / 1024);
      const db = new Database(memDbPath, { readonly: true });
      const hasMem = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
        .all();
      if (hasMem.length > 0) {
        l1Entries = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
      }
      const hasSess = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'")
        .all();
      if (hasSess.length > 0) {
        l2Entries = (
          db.prepare('SELECT COUNT(*) as c FROM session_memories').get() as { c: number }
        ).c;
      }
      const hasEnt = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'")
        .all();
      if (hasEnt.length > 0) {
        l4Entities = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
      }
      const hasRel = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationships'")
        .all();
      if (hasRel.length > 0) {
        l4Relationships = (
          db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number }
        ).c;
      }
      db.close();
    } catch {
      /* ignore */
    }
  }

  let l3Status = 'Stopped';
  let l3Uptime = '';
  try {
    const out = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (out) {
      l3Status = 'Running';
      l3Uptime = out;
    }
  } catch {
    /* ignore */
  }

  const stats = globalSessionStats.getSummary();

  return {
    l1: { entries: l1Entries, sizeKB: l1SizeKB },
    l2: { entries: l2Entries },
    l3: { status: l3Status, uptime: l3Uptime },
    l4: { entities: l4Entities, relationships: l4Relationships },
    compression: {
      rawBytes: stats.totalRawBytes,
      contextBytes: stats.totalContextBytes,
      savingsPercent: stats.savingsPercent,
      totalCalls: stats.totalCalls,
    },
  };
}

function getModelData(cwd: string): ModelData {
  const configPath = join(cwd, '.uap.json');
  let roles = { planner: 'opus-4.6', executor: 'qwen35', reviewer: 'opus-4.6', fallback: 'qwen35' };
  let strategy = 'balanced';

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (raw.multiModel?.roles) {
        roles = { ...roles, ...raw.multiModel.roles };
      }
      if (raw.multiModel?.routingStrategy) {
        strategy = raw.multiModel.routingStrategy;
      }
    } catch {
      /* ignore */
    }
  }

  // Session usage from analytics DB
  const analyticsDbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
  let sessionUsage: ModelData['sessionUsage'] = [];
  let totalCost = 0;

  if (existsSync(analyticsDbPath)) {
    try {
      const db = new Database(analyticsDbPath, { readonly: true });
      const rows = db
        .prepare(
          `
        SELECT modelId, COUNT(*) as taskCount, SUM(tokensIn) as totalTokensIn,
               SUM(tokensOut) as totalTokensOut, SUM(cost) as totalCost,
               CAST(SUM(success) AS REAL) / COUNT(*) as successRate
        FROM task_outcomes GROUP BY modelId ORDER BY taskCount DESC
      `
        )
        .all() as Array<Record<string, unknown>>;
      sessionUsage = rows.map((r) => ({
        modelId: (r.modelId as string) || 'unknown',
        taskCount: (r.taskCount as number) || 0,
        totalTokensIn: (r.totalTokensIn as number) || 0,
        totalTokensOut: (r.totalTokensOut as number) || 0,
        totalCost: (r.totalCost as number) || 0,
        successRate: (r.successRate as number) || 0,
      }));
      const costRow = db.prepare('SELECT SUM(cost) as total FROM task_outcomes').get() as
        | { total: number | null }
        | undefined;
      totalCost = costRow?.total || 0;
      db.close();
    } catch {
      /* ignore */
    }
  }

  return { roles, strategy, sessionUsage, totalCost };
}

function getTaskData(cwd: string): TaskData {
  const taskDbPath = join(cwd, '.uap/tasks/tasks.db');
  const result: TaskData = { total: 0, done: 0, inProgress: 0, blocked: 0, open: 0 };

  if (existsSync(taskDbPath)) {
    try {
      const db = new Database(taskDbPath, { readonly: true });
      result.total = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
      result.done = (
        db
          .prepare("SELECT COUNT(*) as c FROM tasks WHERE status='done' OR status='wont_do'")
          .get() as { c: number }
      ).c;
      result.inProgress = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='in_progress'").get() as {
          c: number;
        }
      ).c;
      result.blocked = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='blocked'").get() as { c: number }
      ).c;
      result.open = (
        db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='open'").get() as { c: number }
      ).c;
      db.close();
    } catch {
      /* ignore */
    }
  }

  return result;
}

function getCoordData(cwd: string): CoordData {
  const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
  const result: CoordData = { activeAgents: 0, activeClaims: 0, pendingDeploys: 0 };

  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath, { readonly: true });
      const hasAgents = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();
      if (hasAgents.length > 0) {
        result.activeAgents = (
          db.prepare("SELECT COUNT(*) as c FROM agent_registry WHERE status='active'").get() as {
            c: number;
          }
        ).c;
      }
      const hasClaims = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'")
        .all();
      if (hasClaims.length > 0) {
        result.activeClaims = (
          db.prepare("SELECT COUNT(*) as c FROM work_claims WHERE status='active'").get() as {
            c: number;
          }
        ).c;
      }
      const hasDQ = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_queue'")
        .all();
      if (hasDQ.length > 0) {
        result.pendingDeploys = (
          db.prepare("SELECT COUNT(*) as c FROM deploy_queue WHERE status='pending'").get() as {
            c: number;
          }
        ).c;
      }
      db.close();
    } catch {
      /* ignore */
    }
  }

  return result;
}
