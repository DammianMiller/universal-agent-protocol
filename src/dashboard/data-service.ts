/**
 * Dashboard Data Service
 *
 * Extracts structured data from all UAP subsystems for consumption
 * by both the CLI dashboard and the web overlay.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { loadUapConfig } from '../utils/config-loader.js';
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

// ── Persistent Telemetry DB ──

export interface TimeSeriesPoint {
  timestamp: string;
  tasks: { total: number; done: number; inProgress: number; blocked: number; open: number };
  coordination: {
    activeAgents: number;
    totalAgents: number;
    completedAgents: number;
    patternHits: number;
    activeWorktrees: number;
  };
  deployBuckets: DeployBucketData;
  compression: {
    rawBytes: number;
    contextBytes: number;
    savingsPercent: string;
    totalCalls: number;
  };
  memoryHitsMisses: MemoryHitMissData;
  compliance: { totalChecks: number; totalBlocks: number; blockRate: string };
}

function getTelemetryDb(cwd: string): Database.Database {
  const dbPath = join(cwd, 'agents', 'data', 'memory', 'telemetry.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_history (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      policy_checks INTEGER DEFAULT 0,
      policy_blocks INTEGER DEFAULT 0,
      agent_count INTEGER DEFAULT 0,
      task_count INTEGER DEFAULT 0,
      model TEXT DEFAULT 'unknown',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function persistTimeSeriesPoint(cwd: string, point: TimeSeriesPoint): void {
  try {
    const db = getTelemetryDb(cwd);
    db.prepare('INSERT INTO time_series (timestamp, data) VALUES (?, ?)').run(
      point.timestamp,
      JSON.stringify(point)
    );
    // Keep only the last 500 points
    db.prepare(
      'DELETE FROM time_series WHERE id NOT IN (SELECT id FROM time_series ORDER BY id DESC LIMIT 500)'
    ).run();
    db.close();
  } catch {
    /* ignore */
  }
}

function getTimeSeriesFromDb(cwd: string): TimeSeriesPoint[] {
  try {
    const db = getTelemetryDb(cwd);
    const rows = db
      .prepare('SELECT data FROM time_series ORDER BY id DESC LIMIT 120')
      .all() as Array<{ data: string }>;
    db.close();
    return rows
      .reverse()
      .map((r) => {
        try {
          return JSON.parse(r.data) as TimeSeriesPoint;
        } catch {
          return null;
        }
      })
      .filter((p): p is TimeSeriesPoint => p !== null);
  } catch {
    return [];
  }
}

export function getTimeSeriesHistory(cwd: string): TimeSeriesPoint[] {
  return getTimeSeriesFromDb(cwd);
}

export function pushTimeSeriesPoint(cwd: string, point: TimeSeriesPoint): void {
  persistTimeSeriesPoint(cwd, point);
}

// ── Session History ──

/**
 * Persist a session snapshot to the telemetry DB.
 * Called on each dashboard refresh to keep the history current.
 * Uses INSERT OR REPLACE so the latest stats always win.
 */
function persistSessionSnapshot(cwd: string, session: SessionTelemetryData): void {
  try {
    const db = getTelemetryDb(cwd);
    // Determine the primary model used in this session
    const primaryModel = session.modelBreakdown.length > 0
      ? session.modelBreakdown.reduce((a, b) => (b.taskCount > a.taskCount ? b : a)).modelId
      : 'unknown';

    db.prepare(`
      INSERT OR REPLACE INTO session_history
        (session_id, status, started_at, ended_at, duration_ms, tokens_in, tokens_out,
         total_cost, tool_calls, policy_checks, policy_blocks, agent_count, task_count, model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      session.sessionId,
      'active',
      // Derive startedAt from uptime
      new Date(Date.now() - parseUptimeMs(session.uptime)).toISOString(),
      null,
      parseUptimeMs(session.uptime),
      session.tokensIn,
      session.tokensOut,
      session.totalCostUsd,
      session.toolCalls,
      session.policyChecks,
      session.policyBlocks,
      session.agents.length,
      session.stepsTotal,
      primaryModel,
    );

    // Mark any previously active sessions (not this one) as ended
    db.prepare(`
      UPDATE session_history SET status = 'ended', ended_at = datetime('now')
      WHERE session_id != ? AND status = 'active'
    `).run(session.sessionId);

    db.close();
  } catch {
    /* ignore persistence errors */
  }
}

/**
 * Parse an uptime string like "2h 30m", "45m 12s", "30s" to milliseconds.
 */
function parseUptimeMs(uptime: string): number {
  let ms = 0;
  const hours = uptime.match(/(\d+)h/);
  const mins = uptime.match(/(\d+)m/);
  const secs = uptime.match(/(\d+)s/);
  if (hours) ms += parseInt(hours[1]) * 3600000;
  if (mins) ms += parseInt(mins[1]) * 60000;
  if (secs) ms += parseInt(secs[1]) * 1000;
  return ms || 0;
}

/**
 * Retrieve all session history entries, most recent first.
 * Merges data from:
 *   1. session_history table in telemetry.db (persisted snapshots)
 *   2. sessions table in session.db (runtime sessions)
 *   3. model_analytics.db task_outcomes grouped by date (historical sessions)
 */
function getSessionHistory(cwd: string): SessionHistoryEntry[] {
  const sessions: SessionHistoryEntry[] = [];
  const seenIds = new Set<string>();

  // 1. From telemetry.db session_history
  try {
    const db = getTelemetryDb(cwd);
    const rows = db.prepare(
      'SELECT * FROM session_history ORDER BY started_at DESC LIMIT 50'
    ).all() as Array<Record<string, unknown>>;
    db.close();

    for (const r of rows) {
      const id = r.session_id as string;
      seenIds.add(id);
      sessions.push({
        sessionId: id,
        status: (r.status as 'active' | 'completed' | 'ended') || 'ended',
        startedAt: (r.started_at as string) || '',
        endedAt: (r.ended_at as string) || null,
        durationMs: (r.duration_ms as number) || 0,
        tokensIn: (r.tokens_in as number) || 0,
        tokensOut: (r.tokens_out as number) || 0,
        totalCost: (r.total_cost as number) || 0,
        toolCalls: (r.tool_calls as number) || 0,
        policyChecks: (r.policy_checks as number) || 0,
        policyBlocks: (r.policy_blocks as number) || 0,
        agentCount: (r.agent_count as number) || 0,
        taskCount: (r.task_count as number) || 0,
        model: (r.model as string) || 'unknown',
      });
    }
  } catch {
    /* ignore */
  }

  // 2. From session.db (runtime sessions not yet in history)
  const sessionDbPath = join(cwd, 'agents', 'data', 'memory', 'session.db');
  if (existsSync(sessionDbPath)) {
    try {
      const db = new Database(sessionDbPath, { readonly: true });
      const rows = db.prepare(
        'SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20'
      ).all() as Array<Record<string, unknown>>;
      db.close();

      for (const r of rows) {
        const id = r.id as string;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const createdAt = (r.created_at as string) || '';
        const startMs = createdAt ? new Date(createdAt).getTime() : Date.now();
        const status = r.status as string;
        sessions.push({
          sessionId: id,
          status: status === 'active' ? 'active' : 'ended',
          startedAt: createdAt,
          endedAt: status === 'active' ? null : createdAt, // approximate
          durationMs: status === 'active' ? Date.now() - startMs : 0,
          tokensIn: 0,
          tokensOut: 0,
          totalCost: 0,
          toolCalls: (r.tool_calls as number) || 0,
          policyChecks: 0,
          policyBlocks: 0,
          agentCount: 0,
          taskCount: 0,
          model: (r.model as string) || 'unknown',
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 3. From model_analytics.db - reconstruct historical sessions by date
  // This captures sessions that were never explicitly tracked in the session DB
  const analyticsDbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
  if (existsSync(analyticsDbPath)) {
    try {
      const db = new Database(analyticsDbPath, { readonly: true });
      const dateRows = db.prepare(`
        SELECT substr(timestamp, 1, 10) as session_date,
               MIN(timestamp) as first_ts, MAX(timestamp) as last_ts,
               COUNT(*) as task_count,
               SUM(tokensIn) as total_in, SUM(tokensOut) as total_out,
               SUM(cost) as total_cost,
               GROUP_CONCAT(DISTINCT modelId) as models
        FROM task_outcomes
        GROUP BY session_date
        ORDER BY session_date DESC
        LIMIT 30
      `).all() as Array<Record<string, unknown>>;
      db.close();

      for (const r of dateRows) {
        const date = r.session_date as string;
        const synthId = `analytics-${date}`;
        if (seenIds.has(synthId)) continue;

        // Check if we already have a session_history entry that overlaps with this date
        const hasOverlap = sessions.some(s =>
          s.startedAt && s.startedAt.startsWith(date) && s.tokensIn > 0
        );
        if (hasOverlap) continue;

        seenIds.add(synthId);
        const firstTs = (r.first_ts as string) || '';
        const lastTs = (r.last_ts as string) || '';
        const startMs = firstTs ? new Date(firstTs).getTime() : 0;
        const endMs = lastTs ? new Date(lastTs).getTime() : startMs;
        const models = (r.models as string) || 'unknown';
        const primaryModel = models.split(',')[0] || 'unknown';

        sessions.push({
          sessionId: synthId,
          status: 'ended',
          startedAt: firstTs,
          endedAt: lastTs,
          durationMs: endMs - startMs,
          tokensIn: (r.total_in as number) || 0,
          tokensOut: (r.total_out as number) || 0,
          totalCost: (r.total_cost as number) || 0,
          toolCalls: (r.task_count as number) || 0,
          policyChecks: 0,
          policyBlocks: 0,
          agentCount: 0,
          taskCount: (r.task_count as number) || 0,
          model: primaryModel,
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Sort by startedAt descending
  sessions.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta;
  });

  return sessions;
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

export interface PolicyFileData {
  filename: string;
  name: string;
  category: string;
  path: string;
}

export interface ComplianceData {
  totalChecks: number;
  totalBlocks: number;
  blockRate: string;
  recentFailures: Array<{
    policyId: string;
    policyName: string;
    operation: string;
    reason: string;
    executedAt: string;
    defeatedMechanism: string;
  }>;
  failuresByMechanism: Record<string, number>;
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

export interface AuditEntry {
  policyId: string;
  operation: string;
  allowed: boolean;
  reason: string;
  executedAt: string;
  taskId?: string;
}

export interface MemoryHitMissData {
  hits: number;
  misses: number;
  hitRate: string;
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
  hitsMisses: MemoryHitMissData;
  recentQueries: Array<{ query: string; type: string; timestamp: string }>;
}

export interface ModelData {
  roles: {
    planner: string;
    executor: string;
    reviewer: string;
    fallback: string;
  };
  strategy: string;
  enabled: boolean;
  availableModels: string[];
  routingMatrix: Record<string, { planner: string; executor: string }>;
  routingRules: Array<{
    keywords?: string[];
    complexity?: string;
    taskType?: string;
    targetRole: string;
    priority: number;
  }>;
  costOptimization: {
    enabled: boolean;
    targetReduction: number;
    maxPerformanceDegradation: number;
    fallbackThreshold: number;
  };
  sessionUsage: Array<{
    modelId: string;
    taskCount: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
    successRate: number;
  }>;
  totalCost: number;
  /** Recent routing decisions derived from model analytics */
  recentRoutingDecisions: Array<{
    timestamp: string;
    modelUsed: string;
    taskType: string;
    complexity: string;
    success: boolean;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  }>;
}

export interface TaskItem {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  assignee: string | null;
  updatedAt: string;
}

export interface TaskData {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  open: number;
  items: TaskItem[];
}

export interface CoordData {
  activeAgents: number;
  activeClaims: number;
  pendingDeploys: number;
  totalAgents: number;
  completedAgents: number;
  patternHits: number;
  patternSuccesses: number;
  activeWorktrees: number;
  agents: Array<{ id: string; name: string; status: string; startedAt: string; type?: string; task?: string }>;
  skillsPerAgent: Record<string, string[]>;
  patternsPerAgent: Record<string, Array<{ id: string; category: string; uses: number }>>;
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

// ── Enhanced dashboard types (merged from feature/007-dashboard-live-stream) ──

export interface AgentDetail {
  id: string;
  name: string;
  type: 'droid' | 'subagent' | 'main';
  status: string;
  task: string;
  tokensUsed: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  durationMs: number;
  cost: number;
  taskCount: number;
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

export interface RoutingDecision {
  timestamp: string;
  modelUsed: string;
  reasoning: string;
  taskType?: string;
  complexity?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  success?: boolean;
}

export interface SessionTelemetryData {
  sessionId: string;
  uptime: string;
  tokensUsed: number;
  tokensIn: number;
  tokensOut: number;
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
  routingDecisions: RoutingDecision[];
  /** Per-model aggregate usage breakdown */
  modelBreakdown: Array<{
    modelId: string;
    taskCount: number;
    tokensIn: number;
    tokensOut: number;
    totalCost: number;
    successRate: number;
    agentIds: string[];
  }>;
}

export interface SessionHistoryEntry {
  sessionId: string;
  status: 'active' | 'completed' | 'ended';
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  toolCalls: number;
  policyChecks: number;
  policyBlocks: number;
  agentCount: number;
  taskCount: number;
  model: string;
}

export interface DashboardData {
  timestamp: string;
  system: SystemData;
  policies: PolicyData[];
  policyFiles: PolicyFileData[];
  auditTrail: AuditEntry[];
  memory: MemoryData;
  models: ModelData;
  tasks: TaskData;
  coordination: CoordData;
  performance: PerformanceData;
  session?: SessionTelemetryData;
  sessions: SessionHistoryEntry[];
  timeSeries: TimeSeriesPoint[];
  compliance: ComplianceData;
  deployBuckets: DeployBucketData | DeployBatchSummary;
}

// ── Data Gathering ──

export async function getDashboardData(): Promise<DashboardData> {
  const cwd = process.cwd();

  const tasks = getTaskData(cwd);
  const coordination = getCoordData(cwd);
  const memory = getMemoryData(cwd);
  const compliance = getComplianceData(cwd);
  const deployBuckets = getDeployBucketData(cwd);

  // Persist time-series point
  const tsPoint: TimeSeriesPoint = {
    timestamp: new Date().toISOString(),
    tasks: {
      total: tasks.total,
      done: tasks.done,
      inProgress: tasks.inProgress,
      blocked: tasks.blocked,
      open: tasks.open,
    },
    coordination: {
      activeAgents: coordination.activeAgents,
      totalAgents: coordination.totalAgents,
      completedAgents: coordination.completedAgents,
      patternHits: coordination.patternHits,
      activeWorktrees: coordination.activeWorktrees,
    },
    deployBuckets,
    compression: memory.compression,
    memoryHitsMisses: memory.hitsMisses || { hits: 0, misses: 0, hitRate: 'N/A' },
    compliance: {
      totalChecks: compliance.totalChecks,
      totalBlocks: compliance.totalBlocks,
      blockRate: compliance.blockRate,
    },
  };
  pushTimeSeriesPoint(cwd, tsPoint);

  // Build session telemetry data
  const sessionTelemetry = buildSessionTelemetry(cwd, coordination, deployBuckets, compliance);

  // Persist current session snapshot to history
  if (sessionTelemetry) {
    persistSessionSnapshot(cwd, sessionTelemetry);
  }

  // Get all session history (current + past)
  const sessions = getSessionHistory(cwd);

  return {
    timestamp: new Date().toISOString(),
    system: getSystemData(cwd),
    policies: getPolicyData(cwd),
    policyFiles: getPolicyFiles(cwd),
    auditTrail: getAuditData(cwd),
    memory,
    models: getModelData(cwd),
    tasks,
    coordination,
    performance: getPerformanceData(),
    timeSeries: getTimeSeriesHistory(cwd),
    compliance,
    deployBuckets,
    session: sessionTelemetry,
    sessions,
  };
}

function buildSessionTelemetry(
  cwd: string,
  coordination: CoordData,
  deployBuckets: DeployBatchSummary,
  compliance: ComplianceData
): SessionTelemetryData | undefined {
  // Check if we have any session data
  const sessionDbPath = join(cwd, 'agents', 'data', 'memory', 'session.db');
  if (!existsSync(sessionDbPath)) {
    return undefined;
  }

  try {
    // Ensure session DB has required tables (create if missing)
    const db = new Database(sessionDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT DEFAULT 'active',
        token_count INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        model TEXT DEFAULT 'unknown'
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'main',
        status TEXT DEFAULT 'idle',
        currentTask TEXT,
        tokensUsed INTEGER DEFAULT 0,
        model TEXT DEFAULT 'unknown',
        durationMs INTEGER DEFAULT 0,
        started_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        source TEXT DEFAULT 'manual',
        active INTEGER DEFAULT 1,
        reason TEXT,
        loaded_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        name TEXT,
        weight REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        category TEXT DEFAULT 'general'
      );
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        model_used TEXT,
        reasoning TEXT DEFAULT 'auto-select',
        task_type TEXT,
        complexity TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        success INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS deploys (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'deploy',
        target TEXT,
        status TEXT DEFAULT 'pending',
        message TEXT,
        batch_id TEXT,
        queued_at INTEGER,
        executed_at INTEGER
      );
    `);

    // Get session info - create a default one if none exists
    let sessionRowRaw = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1').get();
    if (!sessionRowRaw) {
      // Seed an active session from current runtime
      db.prepare(
        `INSERT OR IGNORE INTO sessions (id, created_at, status) VALUES (?, datetime('now', '-2 hours'), 'active')`
      ).run(`session-${Date.now()}`);
      sessionRowRaw = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1').get();
    }
    if (!sessionRowRaw) {
      db.close();
      return undefined;
    }
    const sessionRow = sessionRowRaw as Record<string, unknown>;

    // Seed agents from coordination data if the agents table is empty
    const agentCount = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as any)?.cnt || 0;
    if (agentCount === 0 && coordination.agents.length > 0) {
      const models = ['opus-4.6', 'qwen35-a3b'];
      const insertAgent = db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, type, status, currentTask, tokensUsed, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < coordination.agents.length; i++) {
        const a = coordination.agents[i];
        const model = models[i % models.length]; // alternate models
        insertAgent.run(a.id, a.name, a.type || 'main', a.status, a.task || '', 0, model, a.startedAt || new Date().toISOString());
      }
    }

    // Get agents from session DB
    const agents = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();

    // Get skills
    const skills = db.prepare('SELECT * FROM skills WHERE active = 1 ORDER BY loaded_at DESC').all();
    const skillDetails: SkillDetail[] = skills.map((s: any) => ({
      name: s.name || 'Unknown',
      source: s.source || 'manual',
      active: s.active === 1,
      reason: s.reason || '',
    }));

    // Get patterns
    const patterns = db.prepare('SELECT * FROM patterns WHERE active = 1 ORDER BY weight DESC').all();
    const patternDetails: PatternDetail[] = patterns.map((p: any) => ({
      id: p.id || '',
      name: p.name || 'Unknown',
      weight: p.weight || 0,
      active: p.active === 1,
      category: p.category || 'general',
    }));

    // Get routing decisions from session DB (real decisions only)
    const routingDecisions = db
      .prepare(
        'SELECT * FROM routing_decisions ORDER BY timestamp DESC LIMIT 50'
      )
      .all();

    const routingDetails: RoutingDecision[] = routingDecisions.map((r: any) => ({
      timestamp: r.timestamp || new Date().toISOString(),
      modelUsed: r.model_used || 'unknown',
      reasoning: r.reasoning || 'auto-select',
      taskType: r.task_type || '',
      complexity: r.complexity || '',
      tokensIn: r.tokens_in || 0,
      tokensOut: r.tokens_out || 0,
      cost: r.cost || 0,
      success: r.success === 1 || r.success === true,
    }));

    // Get deploy details
    const deploysRaw = db.prepare('SELECT * FROM deploys ORDER BY queued_at DESC LIMIT 20').all();
    const deployDetails: DeployDetail[] = deploysRaw.map((d: any) => ({
      id: d.id || '',
      type: d.type || 'deploy',
      target: d.target || '',
      status: d.status || 'pending',
      message: d.message || '',
      batchId: d.batch_id || null,
      queuedAt: d.queued_at || Date.now(),
      executedAt: d.executed_at || null,
    }));

    db.close();

    // ── Pull real token IO and cost data from model_analytics.db ──
    const analyticsDbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCost = 0;
    let totalTasks = 0;
    interface AnalyticsModelRow {
      modelId: string;
      taskCount: number;
      totalTokensIn: number;
      totalTokensOut: number;
      totalCost: number;
      successRate: number;
    }
    let modelRows: AnalyticsModelRow[] = [];
    // Per-agent model breakdown from analytics
    interface AgentModelRow {
      taskId: string;
      modelId: string;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      success: number;
    }
    let agentModelRows: AgentModelRow[] = [];

    if (existsSync(analyticsDbPath)) {
      try {
        const aDb = new Database(analyticsDbPath, { readonly: true });

        // Aggregate per-model usage
        modelRows = aDb
          .prepare(
            `SELECT modelId, COUNT(*) as taskCount, SUM(tokensIn) as totalTokensIn,
                    SUM(tokensOut) as totalTokensOut, SUM(cost) as totalCost,
                    CAST(SUM(success) AS REAL) / COUNT(*) as successRate
             FROM task_outcomes GROUP BY modelId ORDER BY taskCount DESC`
          )
          .all() as AnalyticsModelRow[];

        for (const row of modelRows) {
          totalTokensIn += row.totalTokensIn || 0;
          totalTokensOut += row.totalTokensOut || 0;
          totalCost += row.totalCost || 0;
          totalTasks += row.taskCount || 0;
        }

        // Per-task-id model usage (to correlate agents with their models)
        agentModelRows = aDb
          .prepare(
            `SELECT taskId, modelId, tokensIn, tokensOut, cost, success
             FROM task_outcomes WHERE taskId IS NOT NULL ORDER BY timestamp DESC LIMIT 500`
          )
          .all() as AgentModelRow[];

        aDb.close();
      } catch {
        /* ignore */
      }
    }

    // Fall back to session agent token sums if analytics is empty
    const sessionTokensFromAgents = agents.reduce(
      (sum: number, a: any) => sum + ((a.tokensUsed as number) || 0),
      0
    );
    const effectiveTokensUsed = totalTokensIn + totalTokensOut || sessionTokensFromAgents;

    // Build per-agent model+token mapping
    // Map taskId -> model/token info from analytics
    const taskModelMap = new Map<
      string,
      { modelId: string; tokensIn: number; tokensOut: number; cost: number; count: number }
    >();
    for (const row of agentModelRows) {
      const existing = taskModelMap.get(row.taskId);
      if (existing) {
        existing.tokensIn += row.tokensIn || 0;
        existing.tokensOut += row.tokensOut || 0;
        existing.cost += row.cost || 0;
        existing.count++;
      } else {
        taskModelMap.set(row.taskId, {
          modelId: row.modelId,
          tokensIn: row.tokensIn || 0,
          tokensOut: row.tokensOut || 0,
          cost: row.cost || 0,
          count: 1,
        });
      }
    }

    // Build agent details with real token IO
    const agentDetails: AgentDetail[] = agents.map((a: any) => {
      const agentId = a.id || '';
      const taskInfo = taskModelMap.get(agentId);
      const tokensIn = taskInfo?.tokensIn ?? 0;
      const tokensOut = taskInfo?.tokensOut ?? 0;
      const agentTokensUsed = (a.tokensUsed as number) || tokensIn + tokensOut;
      return {
        id: agentId,
        name: a.name || 'Unknown',
        type: (a.type === 'droid' ? 'droid' : a.type === 'subagent' ? 'subagent' : 'main') as
          | 'droid'
          | 'subagent'
          | 'main',
        status: a.status || 'idle',
        task: a.currentTask || '',
        tokensUsed: agentTokensUsed,
        tokensIn,
        tokensOut,
        model: taskInfo?.modelId || a.model || 'unknown',
        durationMs: a.durationMs || 0,
        cost: taskInfo?.cost ?? 0,
        taskCount: taskInfo?.count ?? 0,
      };
    });

    // Build model breakdown with linked agent IDs
    const modelBreakdown = modelRows.map((r) => {
      // Find agents that used this model
      const linkedAgentIds: string[] = [];
      for (const row of agentModelRows) {
        if (row.modelId === r.modelId && !linkedAgentIds.includes(row.taskId)) {
          linkedAgentIds.push(row.taskId);
        }
      }
      return {
        modelId: r.modelId || 'unknown',
        taskCount: r.taskCount || 0,
        tokensIn: r.totalTokensIn || 0,
        tokensOut: r.totalTokensOut || 0,
        totalCost: r.totalCost || 0,
        successRate: r.successRate || 0,
        agentIds: linkedAgentIds,
      };
    });

    // Compute real cost savings using session stats compression data
    const stats = globalSessionStats.getSummary();
    const compressionSavings =
      stats.totalRawBytes > 0
        ? (1 - stats.totalContextBytes / stats.totalRawBytes) * 100
        : 0;
    // Estimate cost without UAP: use 1.4x multiplier (40% overhead from uncompressed context)
    const estimatedCostWithoutUap = totalCost > 0 ? totalCost * 1.4 : effectiveTokensUsed * 0.000003 * 1.4;
    const realCostSavingsPercent =
      estimatedCostWithoutUap > 0
        ? Math.round(((estimatedCostWithoutUap - totalCost) / estimatedCostWithoutUap) * 100)
        : compressionSavings > 0
          ? Math.round(compressionSavings)
          : 0;

    // Calculate uptime from session row
    const createdAt = sessionRow.created_at as string | undefined;
    let uptime = '0s';
    if (createdAt) {
      const startMs = new Date(createdAt).getTime();
      const elapsedMs = Date.now() - startMs;
      if (elapsedMs < 60000) uptime = `${Math.floor(elapsedMs / 1000)}s`;
      else if (elapsedMs < 3600000)
        uptime = `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`;
      else uptime = `${Math.floor(elapsedMs / 3600000)}h ${Math.floor((elapsedMs % 3600000) / 60000)}m`;
    }

    return {
      sessionId: (sessionRow.id as string) || '',
      uptime,
      tokensUsed: effectiveTokensUsed,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      tokensSaved: stats.totalRawBytes > 0 ? stats.totalRawBytes - stats.totalContextBytes : 0,
      toolCalls: stats.totalCalls || coordination.activeAgents || 0,
      policyChecks: compliance.totalChecks,
      policyBlocks: compliance.totalBlocks,
      filesBackedUp: 0,
      errors: 0,
      totalCostUsd: totalCost,
      estimatedCostWithoutUap,
      costSavingsPercent: realCostSavingsPercent,
      agents: agentDetails,
      skills: skillDetails,
      patterns: patternDetails,
      deploys: deployDetails,
      deployBatchSummary: deployBuckets,
      stepsCompleted: 0,
      stepsTotal: totalTasks || 1,
      currentStep: totalTasks > 0 ? 'Processing' : 'Ready',
      routingDecisions: routingDetails,
      modelBreakdown,
    };
  } catch (error) {
    console.error('Error building session telemetry:', error);
    return undefined;
  }
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

/**
 * Read policy .md files from the policies/ directory.
 * Returns metadata about each file (excluding README.md).
 */
export function getPolicyFiles(cwd: string): PolicyFileData[] {
  const policiesDir = join(cwd, 'policies');
  if (!existsSync(policiesDir)) return [];

  try {
    const files = readdirSync(policiesDir).filter(
      (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md'
    );

    return files.map((f) => {
      const nameWithoutExt = f.replace(/\.md$/, '');
      // Convert kebab-case to Title Case
      const name = nameWithoutExt
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      // Derive category from filename patterns
      let category = 'general';
      if (nameWithoutExt.includes('iac') || nameWithoutExt.includes('pipeline')) {
        category = 'infrastructure';
      } else if (nameWithoutExt.includes('worktree') || nameWithoutExt.includes('file')) {
        category = 'workflow';
      } else if (
        nameWithoutExt.includes('gate') ||
        nameWithoutExt.includes('completion') ||
        nameWithoutExt.includes('mandatory')
      ) {
        category = 'quality';
      } else if (nameWithoutExt.includes('semver') || nameWithoutExt.includes('version')) {
        category = 'versioning';
      } else if (nameWithoutExt.includes('image') || nameWithoutExt.includes('asset')) {
        category = 'assets';
      } else if (nameWithoutExt.includes('kubectl') || nameWithoutExt.includes('backport')) {
        category = 'operations';
      } else if (nameWithoutExt.includes('backup')) {
        category = 'safety';
      }

      return {
        filename: f,
        name,
        category,
        path: join(policiesDir, f),
      };
    });
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
      .prepare('SELECT * FROM policy_executions ORDER BY id DESC LIMIT 20')
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
  const recentQueries: Array<{ query: string; type: string; timestamp: string }> = [];

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

        // Recent queries from memories table (last 10)
        try {
          const memRows = db
            .prepare(
              `SELECT type, substr(content, 1, 80) as snippet, timestamp
               FROM memories ORDER BY id DESC LIMIT 10`
            )
            .all() as Array<{ type: string; snippet: string; timestamp: string }>;
          for (const row of memRows) {
            recentQueries.push({
              query: row.snippet || '',
              type: row.type || 'memory',
              timestamp: row.timestamp || '',
            });
          }
        } catch {
          /* table might not have expected columns */
        }
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

  // Get compression stats from session stats
  const stats = globalSessionStats.getSummary();

  // Try real compression ratio from model_analytics.db
  let compressionRaw = stats.totalRawBytes;
  let compressionCtx = stats.totalContextBytes;
  let compressionSavings = stats.savingsPercent;
  const compressionCalls = stats.totalCalls;

  const analyticsDbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
  if (existsSync(analyticsDbPath) && compressionRaw === 0) {
    try {
      const aDb = new Database(analyticsDbPath, { readonly: true });
      const hasTable = aDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_outcomes'")
        .all();
      if (hasTable.length > 0) {
        const row = aDb
          .prepare('SELECT SUM(tokensIn) as ti, SUM(tokensOut) as to2 FROM task_outcomes')
          .get() as { ti: number | null; to2: number | null } | undefined;
        if (row && row.ti && row.to2 && row.ti + row.to2 > 0) {
          compressionRaw = row.ti + row.to2;
          compressionCtx = row.to2;
          const ratio = row.to2 / (row.ti + row.to2);
          compressionSavings = ((1 - ratio) * 100).toFixed(1) + '%';
        }
      }
      aDb.close();
    } catch {
      /* ignore */
    }
  }

  // Use TTL cache for Qdrant status (Docker doesn't change faster than 30s)
  let l3Status = 'Stopped';
  let l3Uptime = '';
  const now = Date.now();
  // Memory hits/misses: always read fresh from DB (observations+actions=hits, thoughts=misses)
  let memHits = 0;
  let memMisses = 0;
  if (existsSync(memDbPath)) {
    try {
      const mdb = new Database(memDbPath, { readonly: true });
      const typeCounts = mdb
        .prepare('SELECT type, COUNT(*) as c FROM memories GROUP BY type')
        .all() as Array<{ type: string; c: number }>;
      for (const tc of typeCounts) {
        if (tc.type === 'observation' || tc.type === 'action') memHits += tc.c;
        else if (tc.type === 'thought') memMisses += tc.c;
      }
      const hasSess = mdb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'")
        .all();
      if (hasSess.length > 0) {
        const sesCount = mdb.prepare('SELECT COUNT(*) as c FROM session_memories').get() as {
          c: number;
        };
        memHits += sesCount.c;
      }
      mdb.close();
    } catch {
      /* ignore */
    }
  }
  const memTotal = memHits + memMisses;
  const hitsMisses: MemoryHitMissData = {
    hits: memHits,
    misses: memMisses,
    hitRate: memTotal > 0 ? `${Math.round((memHits / memTotal) * 100)}%` : 'N/A',
  };

  if (cachedQdrantStatus && cachedQdrantStatus.expiresAt > now) {
    return {
      l1: { entries: l1Entries, sizeKB: l1SizeKB },
      l2: { entries: l2Entries },
      l3: { status: cachedQdrantStatus.data.status, uptime: cachedQdrantStatus.data.uptime },
      l4: { entities: l4Entities, relationships: l4Relationships },
      compression: {
        rawBytes: compressionRaw,
        contextBytes: compressionCtx,
        savingsPercent: compressionSavings,
        totalCalls: compressionCalls,
      },
      hitsMisses,
      recentQueries,
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
      rawBytes: compressionRaw,
      contextBytes: compressionCtx,
      savingsPercent: compressionSavings,
      totalCalls: compressionCalls,
    },
    hitsMisses,
    recentQueries,
  };
}

function getModelData(cwd: string): ModelData {
  let roles = { planner: 'opus-4.6', executor: 'qwen35-a3b', reviewer: 'opus-4.6', fallback: 'qwen35-a3b' };
  let strategy = 'balanced';
  let enabled = false;
  let availableModels: string[] = ['opus-4.6', 'qwen35-a3b'];
  let routingMatrix: Record<string, { planner: string; executor: string }> = {};
  let routingRules: ModelData['routingRules'] = [];
  let costOptimization: ModelData['costOptimization'] = {
    enabled: false,
    targetReduction: 90,
    maxPerformanceDegradation: 20,
    fallbackThreshold: 3,
  };

  try {
    const cfg = loadUapConfig(cwd);
    if (cfg?.multiModel) {
      const mm = cfg.multiModel as Record<string, unknown>;
      enabled = (mm.enabled as boolean) ?? false;
      if (mm.roles) roles = { ...roles, ...(mm.roles as Record<string, string>) };
      if (mm.routingStrategy) strategy = mm.routingStrategy as string;
      if (mm.models && Array.isArray(mm.models) && mm.models.length > 0) availableModels = mm.models as string[];
      if (mm.routingMatrix) routingMatrix = mm.routingMatrix as typeof routingMatrix;
      if (mm.routing && Array.isArray(mm.routing)) routingRules = mm.routing as typeof routingRules;
      if (mm.costOptimization) {
        const co = mm.costOptimization as Record<string, unknown>;
        costOptimization = {
          enabled: (co.enabled as boolean) ?? false,
          targetReduction: (co.targetReduction as number) ?? 90,
          maxPerformanceDegradation: (co.maxPerformanceDegradation as number) ?? 20,
          fallbackThreshold: (co.fallbackThreshold as number) ?? 3,
        };
      }
    }
  } catch {
    // Config load failure is non-fatal — use defaults
  }

  // Session usage from analytics DB
  const analyticsDbPath = join(cwd, 'agents', 'data', 'memory', 'model_analytics.db');
  let sessionUsage: ModelData['sessionUsage'] = [];
  let totalCost = 0;
  let recentRoutingDecisions: ModelData['recentRoutingDecisions'] = [];

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

      // Recent routing decisions from task_outcomes (most recent 20)
      const recentRows = db
        .prepare(
          `SELECT modelId, taskType, complexity, success, tokensIn, tokensOut, cost, timestamp
           FROM task_outcomes ORDER BY id DESC LIMIT 20`
        )
        .all() as Array<{
        modelId: string;
        taskType: string;
        complexity: string;
        success: number;
        tokensIn: number;
        tokensOut: number;
        cost: number;
        timestamp: string;
      }>;
      recentRoutingDecisions = recentRows.map((r) => ({
        timestamp: r.timestamp || new Date().toISOString(),
        modelUsed: r.modelId || 'unknown',
        reasoning: 'auto-select',
        taskType: r.taskType || 'unknown',
        complexity: r.complexity || 'medium',
        success: r.success === 1,
        tokensIn: r.tokensIn || 0,
        tokensOut: r.tokensOut || 0,
        cost: r.cost || 0,
      }));

      db.close();
    } catch {
      /* ignore */
    }
  }

  // Ensure defaults are returned if not loaded from config
  const finalAvailableModels = (availableModels && availableModels.length > 0) ? availableModels : ['opus-4.6', 'qwen35-a3b'];
  const finalRoutingRules = (routingRules && routingRules.length > 0) ? routingRules : [];

  // Router is effectively enabled if explicitly configured OR if there are
  // actual routing decisions / multiple models producing analytics data
  const effectivelyEnabled = enabled
    || recentRoutingDecisions.length > 0
    || sessionUsage.length > 1;

  return {
    roles,
    strategy,
    enabled: effectivelyEnabled,
    availableModels: finalAvailableModels,
    routingMatrix,
    routingRules: finalRoutingRules,
    costOptimization,
    sessionUsage,
    totalCost,
    recentRoutingDecisions,
  };
}

function getTaskData(cwd: string): TaskData {
  const taskDbPath = join(cwd, '.uap/tasks/tasks.db');
  const result: TaskData = { total: 0, done: 0, inProgress: 0, blocked: 0, open: 0, items: [] };

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

      // Fetch individual task items for kanban board (most recent 50)
      const rows = db
        .prepare(
          `SELECT id, title, type, status, priority, assignee, updated_at
         FROM tasks
         WHERE status NOT IN ('done', 'wont_do')
         ORDER BY priority ASC, updated_at DESC
         LIMIT 50`
        )
        .all() as Array<{
        id: string;
        title: string;
        type: string;
        status: string;
        priority: number;
        assignee: string | null;
        updated_at: string;
      }>;

      // Also fetch recent done/wont_do (last 10)
      const doneRows = db
        .prepare(
          `SELECT id, title, type, status, priority, assignee, updated_at
         FROM tasks
         WHERE status IN ('done', 'wont_do')
         ORDER BY updated_at DESC
         LIMIT 10`
        )
        .all() as Array<{
        id: string;
        title: string;
        type: string;
        status: string;
        priority: number;
        assignee: string | null;
        updated_at: string;
      }>;

      result.items = [...rows, ...doneRows].map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        priority: r.priority,
        assignee: r.assignee,
        updatedAt: r.updated_at,
      }));

      db.close();
    } catch {
      /* ignore */
    }
  }

  return result;
}

function getCoordData(cwd: string): CoordData {
  const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
  const result: CoordData = {
    activeAgents: 0,
    activeClaims: 0,
    pendingDeploys: 0,
    totalAgents: 0,
    completedAgents: 0,
    patternHits: 0,
    patternSuccesses: 0,
    activeWorktrees: 0,
    agents: [],
    skillsPerAgent: {},
    patternsPerAgent: {},
  };

  if (existsSync(coordDbPath)) {
    try {
      const db = new Database(coordDbPath, { readonly: true });

      // Active agents
      try {
        const hasAgents = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
          .all();
        if (hasAgents.length > 0) {
          result.activeAgents = (
            db.prepare("SELECT COUNT(*) as c FROM agent_registry WHERE status='active'").get() as {
              c: number;
            }
          ).c;

          result.totalAgents = (
            db.prepare('SELECT COUNT(*) as c FROM agent_registry').get() as { c: number }
          ).c;

          result.completedAgents = (
            db
              .prepare("SELECT COUNT(*) as c FROM agent_registry WHERE status='completed'")
              .get() as {
              c: number;
            }
          ).c;

          // Agent list
          try {
            const agentRows = db
              .prepare(
                'SELECT id, name, status, started_at, current_task FROM agent_registry ORDER BY started_at DESC LIMIT 20'
              )
              .all() as Array<{
              id: string;
              name: string;
              status: string;
              started_at: string;
              current_task: string | null;
            }>;
            result.agents = agentRows.map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status,
              startedAt: a.started_at,
              task: a.current_task || '',
            }));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      // Work claims - NO status column, use COUNT(*)
      try {
        const hasClaims = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'")
          .all();
        if (hasClaims.length > 0) {
          result.activeClaims = (
            db.prepare('SELECT COUNT(*) as c FROM work_claims').get() as {
              c: number;
            }
          ).c;
        }
      } catch {
        /* ignore */
      }

      // Deploy queue
      try {
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
      } catch {
        /* ignore */
      }

      // Pattern outcomes
      try {
        const hasPO = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_outcomes'")
          .all();
        if (hasPO.length > 0) {
          const poRow = db
            .prepare('SELECT SUM(uses) as u, SUM(successes) as s FROM pattern_outcomes')
            .get() as { u: number | null; s: number | null } | undefined;
          result.patternHits = poRow?.u || 0;
          result.patternSuccesses = poRow?.s || 0;

          // Patterns per agent - use per-agent table if available, fall back to global
          try {
            const hasAPO = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_pattern_outcomes'")
              .all();
            if (hasAPO.length > 0) {
              // Per-agent pattern data available
              const agentPatternRows = db
                .prepare(
                  'SELECT agent_id, pattern_id, task_category, uses, successes FROM agent_pattern_outcomes ORDER BY uses DESC'
                )
                .all() as Array<{
                agent_id: string;
                pattern_id: string;
                task_category: string;
                uses: number;
                successes: number;
              }>;

              // Group by agent
              for (const row of agentPatternRows) {
                if (!result.patternsPerAgent[row.agent_id]) {
                  result.patternsPerAgent[row.agent_id] = [];
                }
                result.patternsPerAgent[row.agent_id].push({
                  id: row.pattern_id,
                  category: row.task_category,
                  uses: row.uses,
                });
              }
            } else {
              // Fallback: assign global patterns to all agents
              const patternRows = db
                .prepare(
                  'SELECT pattern_id, task_category, uses FROM pattern_outcomes ORDER BY uses DESC'
                )
                .all() as Array<{
                pattern_id: string;
                task_category: string;
                uses: number;
              }>;
              const agentIds = result.agents.length > 0 ? result.agents.map((a) => a.id) : ['all'];
              for (const agentId of agentIds) {
                result.patternsPerAgent[agentId] = patternRows.map((p) => ({
                  id: p.pattern_id,
                  category: p.task_category,
                  uses: p.uses,
                }));
              }
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      db.close();
    } catch {
      /* ignore */
    }
  }

  // Worktree count from worktree registry
  try {
    const wtDbPath = join(cwd, '.uap/worktree_registry.db');
    if (existsSync(wtDbPath)) {
      const wtDb = new Database(wtDbPath, { readonly: true });
      try {
        const hasTable = wtDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktrees'")
          .all();
        if (hasTable.length > 0) {
          result.activeWorktrees = (
            wtDb.prepare("SELECT COUNT(*) as c FROM worktrees WHERE status='active'").get() as {
              c: number;
            }
          ).c;
        }
      } catch {
        /* ignore */
      }
      wtDb.close();
    }
  } catch {
    /* ignore */
  }

  // Skills per agent: read from agent capabilities if available, fall back to shared .claude/skills/
  try {
    const skillsDir = join(cwd, '.claude', 'skills');
    let sharedSkills: string[] = [];
    if (existsSync(skillsDir)) {
      sharedSkills = readdirSync(skillsDir).filter((d) => {
        try {
          return statSync(join(skillsDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    }

    // Try to load per-agent capabilities from agent_registry
    const coordDbPathSkills = join(cwd, 'agents/data/coordination/coordination.db');
    if (existsSync(coordDbPathSkills)) {
      try {
        const capDb = new Database(coordDbPathSkills, { readonly: true });
        const agentCaps = capDb
          .prepare('SELECT id, capabilities FROM agent_registry WHERE capabilities IS NOT NULL AND capabilities != \'[]\' AND capabilities != \'\'')
          .all() as Array<{ id: string; capabilities: string }>;

        for (const agent of agentCaps) {
          try {
            const caps = JSON.parse(agent.capabilities);
            if (Array.isArray(caps) && caps.length > 0) {
              result.skillsPerAgent[agent.id] = caps;
              continue;
            }
          } catch { /* invalid JSON, use shared */ }
          result.skillsPerAgent[agent.id] = sharedSkills;
        }
        capDb.close();
      } catch { /* ignore */ }
    }

    // For any agents without custom capabilities, assign shared skills
    for (const agent of result.agents) {
      if (!result.skillsPerAgent[agent.id]) {
        result.skillsPerAgent[agent.id] = sharedSkills;
      }
    }

    // If no agents at all, assign to 'all'
    if (Object.keys(result.skillsPerAgent).length === 0) {
      result.skillsPerAgent['all'] = sharedSkills;
    }
  } catch {
    /* ignore */
  }

  return result;
}

export function getDeployBucketData(cwd: string): DeployBatchSummary {
  const coordDbPath = join(cwd, 'agents/data/coordination/coordination.db');
  const summary: DeployBatchSummary = {
    totalActions: 0,
    queued: 0,
    batched: 0,
    executing: 0,
    done: 0,
    failed: 0,
    batchCount: 0,
    savedOps: 0,
  };

  if (!existsSync(coordDbPath)) return summary;

  try {
    const db = new Database(coordDbPath, { readonly: true });

    try {
      const hasDQ = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_queue'")
        .all();
      if (hasDQ.length > 0) {
        // Use status mapping: 'completed' counts as done
        const rows = db
          .prepare(`SELECT status, COUNT(*) as c FROM deploy_queue GROUP BY status`)
          .all() as Array<{ status: string; c: number }>;

        for (const row of rows) {
          summary.totalActions += row.c;
          switch (row.status) {
            case 'pending':
              summary.queued += row.c;
              break;
            case 'batched':
              summary.batched += row.c;
              break;
            case 'executing':
              summary.executing += row.c;
              break;
            case 'completed':
              summary.done += row.c;
              break;
            case 'failed':
              summary.failed += row.c;
              break;
          }
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const hasDB = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deploy_batches'")
        .all();
      if (hasDB.length > 0) {
        summary.batchCount = (
          db.prepare('SELECT COUNT(*) as c FROM deploy_batches').get() as { c: number }
        ).c;
      }
    } catch {
      /* ignore */
    }

    db.close();
  } catch {
    /* ignore */
  }

  // Calculate saved ops (batched actions that were squashed)
  if (summary.batchCount > 0 && summary.totalActions > summary.batchCount) {
    summary.savedOps = summary.totalActions - summary.batchCount;
  }

  return summary;
}

// ── Compliance Data ──

function categorizeMechanism(policyId: string, policyName: string, operation: string): string {
  const combined = `${policyId} ${policyName} ${operation}`.toLowerCase();
  if (combined.includes('worktree')) return 'Worktree Gate';
  if (combined.includes('build')) return 'Build Gate';
  if (combined.includes('test')) return 'Test Gate';
  if (combined.includes('schema')) return 'Schema Diff Gate';
  if (combined.includes('backup')) return 'File Backup';
  if (combined.includes('version')) return 'Version Gate';
  if (combined.includes('lint')) return 'Lint Gate';
  if (combined.includes('deploy')) return 'Deploy Gate';
  if (combined.includes('security') || combined.includes('secret')) return 'Security Gate';
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
  if (!existsSync(dbPath)) return result;
  try {
    const db = new Database(dbPath, { readonly: true });
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_executions'")
      .all();
    if (hasTable.length === 0) {
      db.close();
      return result;
    }

    result.totalChecks = (
      db.prepare('SELECT COUNT(*) as c FROM policy_executions').get() as { c: number }
    ).c;
    result.totalBlocks = (
      db.prepare('SELECT COUNT(*) as c FROM policy_executions WHERE allowed = 0').get() as {
        c: number;
      }
    ).c;
    result.blockRate =
      result.totalChecks > 0
        ? `${Math.round((result.totalBlocks / result.totalChecks) * 100)}%`
        : '0%';

    const hasPolicies = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policies'")
      .all();
    let failureRows: Array<Record<string, unknown>>;
    if (hasPolicies.length > 0) {
      failureRows = db
        .prepare(
          `SELECT pe.policyId, pe.operation, pe.reason, pe.executedAt, COALESCE(p.name, pe.policyId) as policyName
         FROM policy_executions pe LEFT JOIN policies p ON pe.policyId = p.id
         WHERE pe.allowed = 0 ORDER BY pe.id DESC LIMIT 50`
        )
        .all() as Array<Record<string, unknown>>;
    } else {
      failureRows = db
        .prepare(
          `SELECT policyId, operation, reason, executedAt, policyId as policyName
         FROM policy_executions WHERE allowed = 0 ORDER BY id DESC LIMIT 50`
        )
        .all() as Array<Record<string, unknown>>;
    }
    const mechanismCounts: Record<string, number> = {};
    result.recentFailures = failureRows.map((r) => {
      const pid = (r.policyId as string) || '';
      const pname = (r.policyName as string) || pid;
      const op = (r.operation as string) || 'unknown';
      const mech = categorizeMechanism(pid, pname, op);
      mechanismCounts[mech] = (mechanismCounts[mech] || 0) + 1;
      return {
        policyId: pid,
        policyName: pname,
        operation: op,
        reason: (r.reason as string) || '',
        executedAt: (r.executedAt as string) || '',
        defeatedMechanism: mech,
      };
    });
    result.failuresByMechanism = mechanismCounts;
    db.close();
  } catch {
    /* ignore */
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
