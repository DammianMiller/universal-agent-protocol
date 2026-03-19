/**
 * Dashboard Data Service
 *
 * Extracts structured data from all UAP subsystems for consumption
 * by both the CLI dashboard and the web overlay.
 *
 * FIX: Wires session telemetry (agents, skills, patterns, deploys, memory
 * hits/misses, cost savings) into getDashboardData() so the web dashboard
 * receives live session data instead of only static DB reads.
 *
 * FEAT: Adds time-series history ring buffer for graphing Tasks, Coordination,
 * Deploy Buckets, Context Compression, Memory Hits/Misses, and Compliance
 * Failures (with defeated mechanism tracking).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { globalSessionStats } from '../mcp-router/session-stats.js';
import { getSessionSnapshot } from '../telemetry/session-telemetry.js';
import { getPerformanceMonitor, type PerformanceMetrics } from '../utils/performance-monitor.js';

// ── TTL Cache for subprocess calls (git/docker don't change faster than 30s) ──
interface CachedSubprocessResult<T> {
  data: T;
  expiresAt: number;
}

const SUBPROCESS_CACHE_TTL = 30_000; // 30 seconds
let cachedGitData: CachedSubprocessResult<{ branch: string; dirty: number }> | null = null;
let cachedQdrantStatus: CachedSubprocessResult<{ status: string; uptime: string }> | null = null;

// ── DB Connection Pool for memory database ──
const MEMORY_DB_CACHE_TTL = 5_000; // 5 seconds
let cachedMemoryDb: { db: Database.Database; expiresAt: number } | null = null;

// ── Time-Series History Ring Buffer ──
const MAX_HISTORY_POINTS = 120; // 2 minutes at 1s intervals, or 4 minutes at 2s

export interface TimeSeriesPoint {
  timestamp: string;
  tasks: TaskData;
  coordination: CoordData;
  deployBuckets: DeployBucketData;
  compression: CompressionData;
  memoryHitsMisses: MemoryHitMissData;
  compliance: ComplianceData;
}

export interface DeployBucketData {
  queued: number;
  batched: number;
  executing: number;
  done: number;
  failed: number;
  batchCount: number;
  savedOps: number;
}

export interface CompressionData {
  rawBytes: number;
  contextBytes: number;
  savingsPercent: string;
  totalCalls: number;
}

export interface MemoryHitMissData {
  hits: number;
  misses: number;
  hitRate: string;
}

export interface ComplianceFailure {
  policyId: string;
  policyName: string;
  operation: string;
  reason: string;
  executedAt: string;
  defeatedMechanism: string; // which compliance mechanism was defeated
}

export interface ComplianceData {
  totalChecks: number;
  totalBlocks: number;
  blockRate: string;
  recentFailures: ComplianceFailure[];
  failuresByMechanism: Record<string, number>;
}

const _timeSeriesHistory: TimeSeriesPoint[] = [];

export function getTimeSeriesHistory(): TimeSeriesPoint[] {
  return _timeSeriesHistory;
}

function pushTimeSeriesPoint(point: TimeSeriesPoint): void {
  _timeSeriesHistory.push(point);
  if (_timeSeriesHistory.length > MAX_HISTORY_POINTS) {
    _timeSeriesHistory.splice(0, _timeSeriesHistory.length - MAX_HISTORY_POINTS);
  }
}

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
  compression: CompressionData;
  hitsMisses: MemoryHitMissData;
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

// ── Enhanced dashboard types for session telemetry ──

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
  session?: SessionTelemetryData;
  timeSeries: TimeSeriesPoint[];
  compliance: ComplianceData;
  deployBuckets: DeployBucketData;
}

// ── Data Gathering ──

export async function getDashboardData(): Promise<DashboardData> {
  const cwd = process.cwd();

  const tasks = getTaskData(cwd);
  const coordination = getCoordData(cwd);
  const memory = getMemoryData(cwd);
  const session = getSessionTelemetryData();
  const compliance = getComplianceData(cwd);
  const deployBuckets = getDeployBucketData(session);

  // Record time-series point for graphs
  pushTimeSeriesPoint({
    timestamp: new Date().toISOString(),
    tasks,
    coordination,
    deployBuckets,
    compression: memory.compression,
    memoryHitsMisses: memory.hitsMisses,
    compliance,
  });

  return {
    timestamp: new Date().toISOString(),
    system: getSystemData(cwd),
    policies: getPolicyData(cwd),
    auditTrail: getAuditData(cwd),
    memory,
    models: getModelData(cwd),
    tasks,
    coordination,
    performance: getPerformanceData(),
    session: session || undefined,
    timeSeries: getTimeSeriesHistory(),
    compliance,
    deployBuckets,
  };
}

// ── Session Telemetry Bridge ──

function getSessionTelemetryData(): SessionTelemetryData | null {
  const snapshot = getSessionSnapshot();
  if (!snapshot) return null;

  const now = Date.now();
  const uptimeMs = now - snapshot.startTime;
  const uptimeStr =
    uptimeMs < 60000
      ? `${(uptimeMs / 1000).toFixed(1)}s`
      : `${Math.floor(uptimeMs / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`;

  // Convert agents Map to array
  const agents: AgentDetail[] = [...snapshot.agents.values()].map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    task: a.task,
    tokensUsed: a.tokensUsed,
    durationMs: (a.endTime || now) - a.startTime,
  }));

  // Convert skills Map to array
  const skills: SkillDetail[] = [...snapshot.skills.values()].map((s) => ({
    name: s.name,
    source: s.source,
    active: s.active,
    reason: s.reason,
  }));

  // Convert patterns Map to array
  const patterns: PatternDetail[] = [...snapshot.patterns.values()].map((p) => ({
    id: p.id,
    name: p.name,
    weight: p.weight,
    active: p.active,
    category: p.category,
  }));

  // Convert deploys Map to array
  const deploys: DeployDetail[] = [...snapshot.deploys.values()].map((d) => ({
    id: d.id,
    type: d.type,
    target: d.target,
    status: d.status,
    message: d.message,
    batchId: d.batchId,
    queuedAt: d.queuedAt,
    executedAt: d.executedAt,
  }));

  // Compute deploy batch summary
  const deployValues = [...snapshot.deploys.values()];
  const batchIds = new Set(deployValues.map((a) => a.batchId).filter(Boolean));
  const deployBatchSummary: DeployBatchSummary = {
    totalActions: deployValues.length,
    queued: deployValues.filter((a) => a.status === 'queued').length,
    batched: deployValues.filter((a) => a.status === 'batched').length,
    executing: deployValues.filter((a) => a.status === 'executing').length,
    done: deployValues.filter((a) => a.status === 'done').length,
    failed: deployValues.filter((a) => a.status === 'failed').length,
    batchCount: batchIds.size,
    savedOps: Math.max(0, deployValues.length - batchIds.size),
  };

  // Cost savings
  const savedUsd = snapshot.estimatedCostWithoutUap - snapshot.totalCostUsd;
  const costSavingsPercent =
    snapshot.estimatedCostWithoutUap > 0
      ? Math.round((savedUsd / snapshot.estimatedCostWithoutUap) * 100)
      : 0;

  return {
    sessionId: snapshot.sessionId,
    uptime: uptimeStr,
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
    deployBatchSummary,
    stepsCompleted: snapshot.stepsCompleted,
    stepsTotal: snapshot.stepsTotal,
    currentStep: snapshot.currentStep,
  };
}

// ── Deploy Bucket Data ──

function getDeployBucketData(session: SessionTelemetryData | null): DeployBucketData {
  if (!session) {
    return { queued: 0, batched: 0, executing: 0, done: 0, failed: 0, batchCount: 0, savedOps: 0 };
  }
  return {
    queued: session.deployBatchSummary.queued,
    batched: session.deployBatchSummary.batched,
    executing: session.deployBatchSummary.executing,
    done: session.deployBatchSummary.done,
    failed: session.deployBatchSummary.failed,
    batchCount: session.deployBatchSummary.batchCount,
    savedOps: session.deployBatchSummary.savedOps,
  };
}

// ── Compliance Data ──

/**
 * Categorize which compliance mechanism a policy failure defeated.
 * Maps policy IDs/names to the mechanism they enforce.
 */
function categorizeMechanism(policyId: string, policyName: string, operation: string): string {
  const id = policyId.toLowerCase();
  const name = policyName.toLowerCase();
  const op = operation.toLowerCase();

  if (id.includes('worktree') || name.includes('worktree') || op.includes('worktree'))
    return 'Worktree Gate';
  if (id.includes('build') || name.includes('build') || op.includes('build'))
    return 'Build Gate';
  if (id.includes('test') || name.includes('test') || op.includes('test'))
    return 'Test Gate';
  if (id.includes('schema') || name.includes('schema') || op.includes('schema'))
    return 'Schema Diff Gate';
  if (id.includes('backup') || name.includes('backup') || op.includes('backup'))
    return 'File Backup';
  if (id.includes('iac') || name.includes('iac') || op.includes('iac'))
    return 'IaC Parity';
  if (id.includes('kubectl') || name.includes('kubectl') || op.includes('kubectl'))
    return 'kubectl Verify';
  if (id.includes('version') || name.includes('version') || op.includes('version'))
    return 'Version Gate';
  if (id.includes('lint') || name.includes('lint') || op.includes('lint'))
    return 'Lint Gate';
  if (id.includes('deploy') || name.includes('deploy') || op.includes('deploy'))
    return 'Deploy Gate';
  if (id.includes('security') || name.includes('security') || op.includes('secret'))
    return 'Security Gate';
  return 'Policy Enforcement';
}

function getComplianceData(cwd: string): ComplianceData {
  const dbPath = join(cwd, 'agents', 'data', 'memory', 'policies.db');
  const result: ComplianceData = {
    totalChecks: 0,
    totalBlocks: 0,
    blockRate: '0%',
    recentFailures: [],
    failuresByMechanism: {},
  };

  // Get from session telemetry first (live data)
  const snapshot = getSessionSnapshot();
  if (snapshot) {
    result.totalChecks = snapshot.policyChecks;
    result.totalBlocks = snapshot.policyBlocks;
    result.blockRate =
      snapshot.policyChecks > 0
        ? `${Math.round((snapshot.policyBlocks / snapshot.policyChecks) * 100)}%`
        : '0%';
  }

  if (!existsSync(dbPath)) return result;

  try {
    const db = new Database(dbPath, { readonly: true });

    // Check if policy_executions table exists
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_executions'")
      .all();
    if (hasTable.length === 0) {
      db.close();
      return result;
    }

    // Get total counts from DB if session telemetry doesn't have them
    if (result.totalChecks === 0) {
      const totalRow = db.prepare('SELECT COUNT(*) as c FROM policy_executions').get() as {
        c: number;
      };
      result.totalChecks = totalRow.c;
      const blockRow = db
        .prepare('SELECT COUNT(*) as c FROM policy_executions WHERE allowed = 0')
        .get() as { c: number };
      result.totalBlocks = blockRow.c;
      result.blockRate =
        result.totalChecks > 0
          ? `${Math.round((result.totalBlocks / result.totalChecks) * 100)}%`
          : '0%';
    }

    // Get recent failures (blocks) with policy name lookup
    const hasPolicies = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policies'")
      .all();

    let failureRows: Array<Record<string, unknown>>;
    if (hasPolicies.length > 0) {
      failureRows = db
        .prepare(
          `SELECT pe.policyId, pe.operation, pe.reason, pe.executedAt,
                  COALESCE(p.name, pe.policyId) as policyName
           FROM policy_executions pe
           LEFT JOIN policies p ON pe.policyId = p.id
           WHERE pe.allowed = 0
           ORDER BY pe.executedAt DESC LIMIT 50`
        )
        .all() as Array<Record<string, unknown>>;
    } else {
      failureRows = db
        .prepare(
          `SELECT policyId, operation, reason, executedAt, policyId as policyName
           FROM policy_executions
           WHERE allowed = 0
           ORDER BY executedAt DESC LIMIT 50`
        )
        .all() as Array<Record<string, unknown>>;
    }

    const mechanismCounts: Record<string, number> = {};

    result.recentFailures = failureRows.map((r) => {
      const policyId = (r.policyId as string) || '';
      const policyName = (r.policyName as string) || policyId;
      const operation = (r.operation as string) || 'unknown';
      const mechanism = categorizeMechanism(policyId, policyName, operation);

      mechanismCounts[mechanism] = (mechanismCounts[mechanism] || 0) + 1;

      return {
        policyId,
        policyName,
        operation,
        reason: (r.reason as string) || '',
        executedAt: (r.executedAt as string) || '',
        defeatedMechanism: mechanism,
      };
    });

    result.failuresByMechanism = mechanismCounts;
    db.close();
  } catch {
    /* ignore */
  }

  return result;
}

// ── Existing Data Gathering Functions ──

function getSystemData(cwd: string): SystemData {
  let version = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    version = pkg.version || '?';
  } catch {
    /* ignore */
  }

  // Use TTL cache for git data
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
      const now = Date.now();

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
    } catch {
      /* ignore */
    }
  }

  // Get compression stats
  const stats = globalSessionStats.getSummary();

  // Get memory hits/misses from session telemetry
  const snapshot = getSessionSnapshot();
  const hits = snapshot?.memoryHits ?? 0;
  const misses = snapshot?.memoryMisses ?? 0;
  const total = hits + misses;
  const hitRate = total > 0 ? `${Math.round((hits / total) * 100)}%` : '0%';

  // Use TTL cache for Qdrant status
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
  let roles = {
    planner: 'opus-4.6',
    executor: 'qwen35',
    reviewer: 'opus-4.6',
    fallback: 'qwen35',
  };
  let strategy = 'balanced';

  const configPath = join(cwd, '.uap.json');
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
 */
function getPerformanceData(): PerformanceData {
  const monitor = getPerformanceMonitor();
  const allMetrics = monitor.exportMetrics();

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
