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
import { getPerformanceMonitor, type PerformanceMetrics } from '../utils/performance-monitor.js';

// ── TTL Cache for subprocess calls (git/docker don't change faster than 30s) ──
interface CachedSubprocessResult<T> {
  data: T;
  expiresAt: number;
}

const SUBPROCESS_CACHE_TTL = 30_000; // 30 seconds
let cachedGitData: CachedSubprocessResult<{ branch: string; dirty: number }> | null = null;
let cachedQdrantStatus: CachedSubprocessResult<{ status: string; uptime: string }> | null = null;

// ── DB Connection Pool for memory database (prevents opening/closing on every refresh) ──
const MEMORY_DB_CACHE_TTL = 5_000; // 5 seconds
let cachedMemoryDb: { db: Database.Database; expiresAt: number } | null = null;

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
  hitsMisses: {
    hits: number;
    misses: number;
    hitRate: string;
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

export interface PerformanceData {
  metrics: Record<string, PerformanceMetrics>;
  hotPaths: Array<{ name: string; avgMs: number; p95Ms: number; count: number }>;
}

// ── New types for enhanced dashboard ──

export interface AgentDetail {
  id: string;
  name: string;
  type: 'droid' | 'subagent' | 'main';
  status: string;
  task: string;
  tokensUsed: number;
  durationMs: number;
}

export interface SkillDetail {
  name: string;
  source: string;
  active: boolean;
  reason: string;
}

export interface PatternDetail {
  id: string;
  name: string;
  weight: number;
  active: boolean;
  category: string;
}

export interface DeployDetail {
  id: string;
  type: string;
  target: string;
  status: string;
  message: string;
  batchId: string | null;
  queuedAt: number;
  executedAt: number | null;
}

export interface DeployBatchSummary {
  totalActions: number;
  queued: number;
  batched: number;
  executing: number;
  done: number;
  failed: number;
  batchCount: number;
  savedOps: number;
}

export interface SessionTelemetryData {
  sessionId: string;
  uptime: string;
  tokensUsed: number;
  tokensSaved: number;
  toolCalls: number;
  policyChecks: number;
  policyBlocks: number;
  filesBackedUp: number;
  errors: number;
  totalCostUsd: number;
  estimatedCostWithoutUap: number;
  costSavingsPercent: number;
  agents: AgentDetail[];
  skills: SkillDetail[];
  patterns: PatternDetail[];
  deploys: DeployDetail[];
  deployBatchSummary: DeployBatchSummary;
  stepsCompleted: number;
  stepsTotal: number;
  currentStep: string;
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
  performance: PerformanceData;
  session: SessionTelemetryData;
}

// ── Session Telemetry Access ──
// We import the getStats function indirectly by accessing the module's internal state
// through the exported functions. We need a way to read the session stats.

interface SessionStatsSnapshot {
  sessionId: string;
  startTime: number;
  tokensUsed: number;
  tokensSaved: number;
  memoryHits: number;
  memoryMisses: number;
  toolCalls: number;
  policyChecks: number;
  policyBlocks: number;
  filesBackedUp: number;
  stepsCompleted: number;
  stepsTotal: number;
  currentStep: string;
  errors: number;
  totalCostUsd: number;
  estimatedCostWithoutUap: number;
  agents: Map<string, {
    id: string;
    name: string;
    type: 'droid' | 'subagent' | 'main';
    status: string;
    task: string;
    startTime: number;
    endTime: number | null;
    tokensUsed: number;
  }>;
  tasks: Map<string, {
    id: string;
    title: string;
    status: string;
    assignedTo: string | null;
    children: string[];
    parentId: string | null;
    startTime: number | null;
    endTime: number | null;
    depth: number;
  }>;
  skills: Map<string, {
    name: string;
    source: string;
    active: boolean;
    matchedAt: number;
    reason: string;
  }>;
  patterns: Map<string, {
    id: string;
    name: string;
    weight: number;
    active: boolean;
    matchedAt: number;
    category: string;
  }>;
  deploys: Map<string, {
    id: string;
    type: string;
    target: string;
    status: string;
    queuedAt: number;
    executedAt: number | null;
    batchId: string | null;
    message: string;
  }>;
}

// We'll dynamically import the telemetry module to access its internal state
let _sessionStatsGetter: (() => SessionStatsSnapshot | null) | null = null;

async function getSessionStats(): Promise<SessionStatsSnapshot | null> {
  if (!_sessionStatsGetter) {
    try {
      // Dynamic import to avoid circular dependencies
      const telemetry = await import('../telemetry/session-telemetry.js');
      if (typeof telemetry.getSessionSnapshot === 'function') {
        _sessionStatsGetter = telemetry.getSessionSnapshot as () => SessionStatsSnapshot | null;
      } else {
        _sessionStatsGetter = () => null;
      }
    } catch {
      _sessionStatsGetter = () => null;
    }
  }
  return _sessionStatsGetter();
}

// ── Data Gathering ──

export async function getDashboardData(): Promise<DashboardData> {
  const cwd = process.cwd();

  // Gather session telemetry in parallel with other data
  const sessionSnapshot = await getSessionStats();

  return {
    timestamp: new Date().toISOString(),
    system: getSystemData(cwd),
    policies: getPolicyData(cwd),
    auditTrail: getAuditData(cwd),
    memory: getMemoryData(cwd, sessionSnapshot),
    models: getModelData(cwd),
    tasks: getTaskData(cwd),
    coordination: getCoordData(cwd),
    performance: getPerformanceData(),
    session: getSessionTelemetryData(sessionSnapshot),
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

  // Use TTL cache for git data (doesn't change faster than 30s during normal operation)
  let branch = '?';
  let dirty = 0;
  const now = Date.now();
  if (cachedGitData && cachedGitData.expiresAt > now) {
    return { version, branch: cachedGitData.data.branch, dirty: cachedGitData.data.dirty };
  }

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

    cachedGitData = { data: { branch, dirty }, expiresAt: now + SUBPROCESS_CACHE_TTL };
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
      tags: (() => {
        if (typeof r.tags === 'string') {
          const parsed = JSON.parse(r.tags);
          return Array.isArray(parsed) ? parsed : [];
        }
        return Array.isArray(r.tags) ? (r.tags as string[]) : [];
      })(),
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

function getMemoryData(cwd: string, sessionSnapshot: SessionStatsSnapshot | null): MemoryData {
  const memDbPath = join(cwd, 'agents/data/memory/short_term.db');
  let l1Entries = 0;
  let l1SizeKB = 0;
  let l2Entries = 0;
  let l4Entities = 0;
  let l4Relationships = 0;

  if (existsSync(memDbPath)) {
    try {
      l1SizeKB = Math.round(statSync(memDbPath).size / 1024);
      const now = Date.now();

      // Reuse DB connection if still valid (prevents open/close overhead on rapid refreshes)
      let db: Database.Database | null = null;
      if (cachedMemoryDb && cachedMemoryDb.expiresAt > now) {
        db = cachedMemoryDb.db;
      } else {
        db = new Database(memDbPath, { readonly: true });
        cachedMemoryDb = { db, expiresAt: now + MEMORY_DB_CACHE_TTL };
      }

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
      // Don't close - keep connection cached for next refresh
    } catch {
      /* ignore */
    }
  }

  // Get compression stats first (needed for both cached and fresh paths)
  const stats = globalSessionStats.getSummary();

  // Memory hits/misses from session telemetry
  const hits = sessionSnapshot?.memoryHits ?? 0;
  const misses = sessionSnapshot?.memoryMisses ?? 0;
  const total = hits + misses;
  const hitRate = total > 0 ? `${Math.round((hits / total) * 100)}%` : '0%';

  // Use TTL cache for Qdrant status (Docker doesn't change faster than 30s)
  let l3Status = 'Stopped';
  let l3Uptime = '';
  const now = Date.now();
  if (cachedQdrantStatus && cachedQdrantStatus.expiresAt > now) {
    return {
      l1: { entries: l1Entries, sizeKB: l1SizeKB },
      l2: { entries: l2Entries },
      l3: { status: cachedQdrantStatus.data.status, uptime: cachedQdrantStatus.data.uptime },
      l4: { entities: l4Entities, relationships: l4Relationships },
      compression: {
        rawBytes: stats.totalRawBytes,
        contextBytes: stats.totalContextBytes,
        savingsPercent: stats.savingsPercent,
        totalCalls: stats.totalCalls,
      },
      hitsMisses: { hits, misses, hitRate },
    };
  }

  try {
    const out = execSync('docker ps --filter name=qdrant --format "{{.Status}}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (out) {
      l3Status = 'Running';
      l3Uptime = out;
      cachedQdrantStatus = {
        data: { status: l3Status, uptime: l3Uptime },
        expiresAt: now + SUBPROCESS_CACHE_TTL,
      };
    }
  } catch {
    /* ignore */
  }

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
    hitsMisses: { hits, misses, hitRate },
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

/**
 * Get performance metrics from the global PerformanceMonitor.
 * Surfaces p50/p95/p99 latency data for all monitored operations.
 */
function getPerformanceData(): PerformanceData {
  const monitor = getPerformanceMonitor();
  const allMetrics = monitor.exportMetrics();

  // Build hot paths list sorted by call count (most active first)
  const hotPaths = Object.entries(allMetrics)
    .map(([name, stats]) => ({
      name,
      avgMs: Math.round(stats.avg * 100) / 100,
      p95Ms: Math.round(stats.p95 * 100) / 100,
      count: stats.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    metrics: allMetrics,
    hotPaths,
  };
}

/**
 * Build session telemetry data from the in-memory session stats.
 */
function getSessionTelemetryData(snapshot: SessionStatsSnapshot | null): SessionTelemetryData {
  if (!snapshot) {
    return {
      sessionId: '',
      uptime: '0s',
      tokensUsed: 0,
      tokensSaved: 0,
      toolCalls: 0,
      policyChecks: 0,
      policyBlocks: 0,
      filesBackedUp: 0,
      errors: 0,
      totalCostUsd: 0,
      estimatedCostWithoutUap: 0,
      costSavingsPercent: 0,
      agents: [],
      skills: [],
      patterns: [],
      deploys: [],
      deployBatchSummary: {
        totalActions: 0,
        queued: 0,
        batched: 0,
        executing: 0,
        done: 0,
        failed: 0,
        batchCount: 0,
        savedOps: 0,
      },
      stepsCompleted: 0,
      stepsTotal: 0,
      currentStep: '',
    };
  }

  const uptimeMs = Date.now() - snapshot.startTime;
  const uptime = formatUptime(uptimeMs);

  // Agents
  const agents: AgentDetail[] = [...snapshot.agents.values()].map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    task: a.task,
    tokensUsed: a.tokensUsed,
    durationMs: a.endTime ? a.endTime - a.startTime : Date.now() - a.startTime,
  }));

  // Skills
  const skills: SkillDetail[] = [...snapshot.skills.values()].map((s) => ({
    name: s.name,
    source: s.source,
    active: s.active,
    reason: s.reason,
  }));

  // Patterns
  const patterns: PatternDetail[] = [...snapshot.patterns.values()].map((p) => ({
    id: p.id,
    name: p.name,
    weight: p.weight,
    active: p.active,
    category: p.category,
  }));

  // Deploys
  const deployValues = [...snapshot.deploys.values()];
  const deploys: DeployDetail[] = deployValues.map((d) => ({
    id: d.id,
    type: d.type,
    target: d.target,
    status: d.status,
    message: d.message,
    batchId: d.batchId,
    queuedAt: d.queuedAt,
    executedAt: d.executedAt,
  }));

  // Deploy batch summary
  const queued = deployValues.filter((a) => a.status === 'queued').length;
  const batched = deployValues.filter((a) => a.status === 'batched').length;
  const executing = deployValues.filter((a) => a.status === 'executing').length;
  const done = deployValues.filter((a) => a.status === 'done').length;
  const failed = deployValues.filter((a) => a.status === 'failed').length;
  const batchIds = new Set(deployValues.map((a) => a.batchId).filter(Boolean));
  const savedOps = deployValues.length > 0 ? deployValues.length - batchIds.size : 0;

  // Cost savings
  const savedUsd = snapshot.estimatedCostWithoutUap - snapshot.totalCostUsd;
  const costSavingsPercent =
    snapshot.estimatedCostWithoutUap > 0
      ? Math.round((savedUsd / snapshot.estimatedCostWithoutUap) * 100)
      : 0;

  return {
    sessionId: snapshot.sessionId,
    uptime,
    tokensUsed: snapshot.tokensUsed,
    tokensSaved: snapshot.tokensSaved,
    toolCalls: snapshot.toolCalls,
    policyChecks: snapshot.policyChecks,
    policyBlocks: snapshot.policyBlocks,
    filesBackedUp: snapshot.filesBackedUp,
    errors: snapshot.errors,
    totalCostUsd: snapshot.totalCostUsd,
    estimatedCostWithoutUap: snapshot.estimatedCostWithoutUap,
    costSavingsPercent,
    agents,
    skills,
    patterns,
    deploys,
    deployBatchSummary: {
      totalActions: deployValues.length,
      queued,
      batched,
      executing,
      done,
      failed,
      batchCount: batchIds.size,
      savedOps,
    },
    stepsCompleted: snapshot.stepsCompleted,
    stepsTotal: snapshot.stepsTotal,
    currentStep: snapshot.currentStep,
  };
}

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
