import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadUapConfig } from '../utils/config-loader.js';
import type Database from 'better-sqlite3';
import { CoordinationDatabase, getDefaultCoordinationDbPath } from './database.js';
import type {
  DeployAction,
  DeployBatch,
  BatchResult,
  DeployActionType,
  DeployStatus,
} from '../types/coordination.js';
import { execFile as execFileCb } from 'child_process';
import { isParallelEnabled, getMaxParallel } from '../utils/system-resources.js';
import { concurrentMapSettled } from '../utils/concurrency-pool.js';

/**
 * Dynamic batch window configuration based on action type.
 * Optimizes for speed on time-sensitive operations while allowing
 * batching for operations that benefit from grouping.
 */
export interface DynamicBatchWindows {
  commit: number; // Default: 30000ms (30s) - allows squashing
  push: number; // Default: 5000ms (5s) - fast for PRs
  merge: number; // Default: 10000ms (10s)
  workflow: number; // Default: 5000ms (5s) - fast triggers
  deploy: number; // Default: 60000ms (60s) - safety buffer
}

export interface DeployBatcherConfig {
  dbPath?: string;
  batchWindowMs?: number; // Legacy: single window for all types
  dynamicWindows?: Partial<DynamicBatchWindows>; // NEW: per-type windows
  maxBatchSize?: number;
  dryRun?: boolean;
  parallelExecution?: boolean; // NEW: execute independent actions in parallel
  maxParallelActions?: number; // NEW: limit parallel executions
  execTimeoutMs?: number; // NEW: timeout for external command execution (default: 300s)
}

const DEFAULT_DYNAMIC_WINDOWS: DynamicBatchWindows = {
  commit: 30000, // 30s - allows squashing multiple commits
  push: 5000, // 5s - fast for PR creation
  merge: 10000, // 10s - moderate safety
  workflow: 5000, // 5s - fast workflow triggers
  deploy: 60000, // 60s - safety buffer for deployments
};

export class DeployBatcher {
  private db: Database.Database;
  private dynamicWindows!: DynamicBatchWindows;
  private maxBatchSize: number;
  private dryRun: boolean;
  private parallelExecution: boolean;
  private maxParallelActions: number;
  private execTimeoutMs: number;

  constructor(config: DeployBatcherConfig = {}) {
    const dbPath = config.dbPath || getDefaultCoordinationDbPath();
    this.db = CoordinationDatabase.getInstance(dbPath).getDatabase();

    // Support both legacy single window and new dynamic windows
    // T7: Also check .uap.json timeOptimization.batchWindows for project-level config
    if (config.dynamicWindows) {
      this.dynamicWindows = { ...DEFAULT_DYNAMIC_WINDOWS, ...config.dynamicWindows };
    } else if (config.batchWindowMs) {
      // Legacy mode: use single window for all types
      this.dynamicWindows = {
        commit: config.batchWindowMs,
        push: config.batchWindowMs,
        merge: config.batchWindowMs,
        workflow: config.batchWindowMs,
        deploy: config.batchWindowMs,
      };
    } else {
      // Try loading from .uap.json timeOptimization config
      let loaded = false;
      try {
        const cfg = loadUapConfig();
        const bw = cfg?.timeOptimization?.batchWindows;
        if (bw && typeof bw === 'object') {
          this.dynamicWindows = { ...DEFAULT_DYNAMIC_WINDOWS, ...bw };
          loaded = true;
        }
      } catch {
        // Config load failure is non-fatal
      }
      if (!loaded) {
        this.dynamicWindows = DEFAULT_DYNAMIC_WINDOWS;
      }
    }

    this.maxBatchSize = config.maxBatchSize || 20;
    this.dryRun = config.dryRun || false;
    this.parallelExecution = config.parallelExecution ?? isParallelEnabled();
    this.maxParallelActions = config.maxParallelActions || getMaxParallel('io');
    this.execTimeoutMs = config.execTimeoutMs ?? 300000; // Default: 300s (5 minutes)

    // Validate window values
    const windowEntries = Object.entries(this.dynamicWindows) as Array<
      [keyof DynamicBatchWindows, number]
    >;
    for (const [key, value] of windowEntries) {
      if (value < 1000) {
        // Validation warning - below minimum recommended window
        void `DeployBatcher: window '${key}' is ${value}ms, below minimum 1000ms`;
      }
      if (value > 300000) {
        // Validation warning - exceeds maximum recommended window
        void `DeployBatcher: window '${key}' is ${value}ms, exceeds maximum 300000ms`;
      }
    }
  }

  /**
   * Get the batch window for a specific action type.
   */
  getBatchWindow(actionType: DeployActionType): number {
    return this.dynamicWindows[actionType] || DEFAULT_DYNAMIC_WINDOWS.commit;
  }

  /**
   * Update batch windows dynamically (useful for urgent operations).
   */
  setUrgentMode(urgent: boolean): void {
    if (urgent) {
      // Reduce all windows to minimum for urgent operations
      this.dynamicWindows = {
        commit: 2000,
        push: 1000,
        merge: 2000,
        workflow: 1000,
        deploy: 5000,
      };
    } else {
      // Restore defaults
      this.dynamicWindows = { ...DEFAULT_DYNAMIC_WINDOWS };
    }
  }

  /**
   * Queue a deploy action with type-specific batching delay.
   */
  async queue(
    agentId: string,
    actionType: DeployActionType,
    target: string,
    payload?: Record<string, unknown>,
    options: { priority?: number; dependencies?: string[]; urgent?: boolean } = {}
  ): Promise<number> {
    const now = new Date().toISOString();

    // Use type-specific window, or immediate for urgent
    const windowMs = options.urgent ? 1000 : this.getBatchWindow(actionType);
    const executeAfter = new Date(Date.now() + windowMs).toISOString();

    // Check for similar pending action to merge
    const existing = this.findSimilarAction(actionType, target);
    if (existing && this.canMerge(existing, { actionType, target, payload })) {
      await this.mergeActions(existing.id, payload);
      return existing.id;
    }

    const stmt = this.db.prepare(`
      INSERT INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, execute_after, priority, dependencies)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);

    const result = stmt.run(
      agentId,
      actionType,
      target,
      payload ? JSON.stringify(payload) : null,
      now,
      executeAfter,
      options.priority || 5,
      options.dependencies ? JSON.stringify(options.dependencies) : null
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Queue multiple actions atomically with optimized windows.
   */
  async queueBulk(
    agentId: string,
    actions: Array<{
      actionType: DeployActionType;
      target: string;
      payload?: Record<string, unknown>;
      priority?: number;
    }>
  ): Promise<number[]> {
    const ids: number[] = [];

    const transaction = this.db.transaction(() => {
      for (const action of actions) {
        const id = this.queueSync(agentId, action.actionType, action.target, action.payload, {
          priority: action.priority,
        });
        ids.push(id);
      }
    });

    transaction();
    return ids;
  }

  /**
   * Synchronous queue for use in transactions.
   */
  private queueSync(
    agentId: string,
    actionType: DeployActionType,
    target: string,
    payload?: Record<string, unknown>,
    options: { priority?: number; dependencies?: string[] } = {}
  ): number {
    const now = new Date().toISOString();
    const windowMs = this.getBatchWindow(actionType);
    const executeAfter = new Date(Date.now() + windowMs).toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, execute_after, priority, dependencies)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);

    const result = stmt.run(
      agentId,
      actionType,
      target,
      payload ? JSON.stringify(payload) : null,
      now,
      executeAfter,
      options.priority || 5,
      options.dependencies ? JSON.stringify(options.dependencies) : null
    );

    return result.lastInsertRowid as number;
  }

  private findSimilarAction(actionType: DeployActionType, target: string): DeployAction | null {
    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE action_type = ? AND target = ? AND status = 'pending'
      ORDER BY queued_at DESC
      LIMIT 1
    `);
    const row = stmt.get(actionType, target) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    } as DeployAction;
  }

  private canMerge(
    existing: DeployAction,
    incoming: { actionType: DeployActionType; target: string; payload?: Record<string, unknown> }
  ): boolean {
    if (existing.actionType !== incoming.actionType || existing.target !== incoming.target) {
      return false;
    }

    // Commits can be squashed
    if (existing.actionType === 'commit') {
      return true;
    }

    // Pushes to same branch can be merged
    if (existing.actionType === 'push') {
      return true;
    }

    // Workflow triggers can be deduplicated
    if (existing.actionType === 'workflow') {
      return true;
    }

    return false;
  }

  private async mergeActions(
    existingId: number,
    newPayload?: Record<string, unknown>
  ): Promise<void> {
    if (!newPayload) return;

    const stmt = this.db.prepare(`
      SELECT payload FROM deploy_queue WHERE id = ?
    `);
    const row = stmt.get(existingId) as { payload: string } | undefined;
    if (!row) return;

    const parsed = row.payload ? JSON.parse(row.payload) : {};
    const existingPayload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const merged = this.mergePayloads(existingPayload, newPayload);

    const updateStmt = this.db.prepare(`
      UPDATE deploy_queue SET payload = ? WHERE id = ?
    `);
    updateStmt.run(JSON.stringify(merged), existingId);
  }

  private mergePayloads(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
      if (Array.isArray(value) && Array.isArray(result[key])) {
        result[key] = [...(result[key] as unknown[]), ...value];
      } else if (key === 'messages' && Array.isArray(value)) {
        result[key] = [...((result[key] as string[]) || []), ...value];
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Create a batch from ready actions.
   */
  async createBatch(): Promise<DeployBatch | null> {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE status = 'pending' AND execute_after <= ?
      ORDER BY priority DESC, queued_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(now, this.maxBatchSize) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;

    const actions = rows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    })) as DeployAction[];

    const grouped = this.groupByTarget(actions);
    const squashed = this.squashActions(grouped);

    const batchId = randomUUID();

    const updateStmt = this.db.prepare(`
      UPDATE deploy_queue SET status = 'batched', batch_id = ? WHERE id = ?
    `);

    const transaction = this.db.transaction(() => {
      for (const action of actions) {
        updateStmt.run(batchId, action.id);
      }

      this.db
        .prepare(
          `
        INSERT INTO deploy_batches (id, created_at, status)
        VALUES (?, ?, 'pending')
      `
        )
        .run(batchId, now);
    });

    transaction();

    return {
      id: batchId,
      actions: squashed,
      createdAt: now,
      status: 'pending',
    };
  }

  private groupByTarget(actions: DeployAction[]): Map<string, DeployAction[]> {
    const groups = new Map<string, DeployAction[]>();

    for (const action of actions) {
      const key = `${action.actionType}:${action.target}`;
      const existing = groups.get(key) || [];
      existing.push(action);
      groups.set(key, existing);
    }

    return groups;
  }

  private squashActions(grouped: Map<string, DeployAction[]>): DeployAction[] {
    const result: DeployAction[] = [];

    for (const [, actions] of grouped) {
      if (actions.length === 0) continue;

      if (actions.length === 1) {
        result.push(actions[0]);
        continue;
      }

      const first = actions[0];

      if (first.actionType === 'commit') {
        const squashed = this.squashCommits(actions);
        result.push(squashed);
        continue;
      }

      if (first.actionType === 'push') {
        result.push(first);
        continue;
      }

      if (first.actionType === 'workflow') {
        result.push(first);
        continue;
      }

      result.push(...actions);
    }

    return result;
  }

  private squashCommits(commits: DeployAction[]): DeployAction {
    const messages: string[] = [];
    const allFiles: string[] = [];

    for (const commit of commits) {
      const payload = commit.payload as { message?: string; files?: string[] } | undefined;
      if (payload?.message) {
        messages.push(payload.message);
      }
      if (payload?.files) {
        allFiles.push(...payload.files);
      }
    }

    const squashedMessage =
      messages.length === 1
        ? messages[0]
        : `Squashed ${messages.length} commits:\n\n${messages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;

    return {
      ...commits[0],
      payload: {
        message: squashedMessage,
        files: [...new Set(allFiles)],
        squashedFrom: commits.map((c) => c.id),
      },
    };
  }

  /**
   * Execute a batch with optional parallel execution for independent actions.
   */
  async executeBatch(batchId: string): Promise<BatchResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let executed = 0;
    let failed = 0;

    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE batch_id = ? AND status = 'batched'
      ORDER BY priority DESC, queued_at ASC
    `);

    const rows = stmt.all(batchId) as Array<Record<string, unknown>>;
    const actions = rows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    })) as DeployAction[];

    this.db
      .prepare(
        `
      UPDATE deploy_batches SET status = 'executing', executed_at = ? WHERE id = ?
    `
      )
      .run(new Date().toISOString(), batchId);

    if (this.parallelExecution) {
      // Group independent actions for parallel execution
      const { sequential, parallel } = this.categorizeActions(actions);

      // Execute parallel-safe actions concurrently
      if (parallel.length > 0) {
        const parallelResults = await this.executeParallel(parallel);
        for (const result of parallelResults) {
          if (result.success) {
            executed++;
          } else {
            failed++;
            if (result.error) errors.push(result.error);
          }
        }
      }

      // Execute sequential actions in order
      for (const action of sequential) {
        try {
          await this.executeAction(action);
          this.updateActionStatus(action.id, 'completed');
          executed++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`Action ${action.id} (${action.actionType}): ${errorMsg}`);
          this.updateActionStatus(action.id, 'failed');
          failed++;
        }
      }
    } else {
      // Original sequential execution
      for (const action of actions) {
        try {
          await this.executeAction(action);
          this.updateActionStatus(action.id, 'completed');
          executed++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`Action ${action.id} (${action.actionType}): ${errorMsg}`);
          this.updateActionStatus(action.id, 'failed');
          failed++;
        }
      }
    }

    const batchStatus: DeployStatus =
      failed === 0 ? 'completed' : executed > 0 ? 'completed' : 'failed';
    this.db
      .prepare(
        `
      UPDATE deploy_batches SET status = ?, result = ? WHERE id = ?
    `
      )
      .run(batchStatus, JSON.stringify({ executed, failed, errors }), batchId);

    return {
      batchId,
      success: failed === 0,
      executedActions: executed,
      failedActions: failed,
      errors: errors.length > 0 ? errors : undefined,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Categorize actions into parallel-safe and sequential groups.
   */
  private categorizeActions(actions: DeployAction[]): {
    sequential: DeployAction[];
    parallel: DeployAction[];
  } {
    const sequential: DeployAction[] = [];
    const parallel: DeployAction[] = [];

    // Actions that can run in parallel (no state dependencies)
    const parallelSafeTypes: DeployActionType[] = ['workflow'];

    // Actions that must be sequential (state-dependent)
    const sequentialTypes: DeployActionType[] = ['commit', 'push', 'merge', 'deploy'];

    for (const action of actions) {
      if (parallelSafeTypes.includes(action.actionType)) {
        parallel.push(action);
      } else if (sequentialTypes.includes(action.actionType)) {
        sequential.push(action);
      } else {
        // Unknown types go sequential for safety
        sequential.push(action);
      }
    }

    return { sequential, parallel };
  }

  /**
   * Execute actions in parallel with concurrency limit.
   * Uses shared concurrentMapSettled utility.
   */
  private async executeParallel(
    actions: DeployAction[]
  ): Promise<Array<{ action: DeployAction; success: boolean; error?: string }>> {
    const results: Array<{ action: DeployAction; success: boolean; error?: string }> = [];

    const settled = await concurrentMapSettled(
      actions,
      async (action) => {
        await this.executeAction(action);
        return action;
      },
      { maxConcurrent: this.maxParallelActions }
    );

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      const action = actions[j];

      if (result.status === 'fulfilled') {
        this.updateActionStatus(action.id, 'completed');
        results.push({ action, success: true });
      } else {
        const errorMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.updateActionStatus(action.id, 'failed');
        results.push({
          action,
          success: false,
          error: `Action ${action.id} (${action.actionType}): ${errorMsg}`,
        });
      }
    }

    return results;
  }

  private async executeAction(action: DeployAction): Promise<void> {
    if (this.dryRun) {
      console.log(`[DRY RUN] Would execute: ${action.actionType} on ${action.target}`);
      return;
    }

    const payload = action.payload || {};

    switch (action.actionType) {
      case 'commit':
        await this.executeCommit(action.target, payload);
        break;
      case 'push':
        await this.executePush(action.target, payload);
        break;
      case 'merge':
        await this.executeMerge(action.target, payload);
        break;
      case 'workflow':
        await this.executeWorkflow(action.target, payload);
        break;
      case 'deploy':
        await this.executeDeploy(action.target, payload);
        break;
      default:
        throw new Error(`Unknown action type: ${action.actionType}`);
    }
  }

  private async executeCommit(_target: string, payload: Record<string, unknown>): Promise<void> {
    const message = (payload.message as string) || 'Automated commit';
    const files = Array.isArray(payload.files) ? (payload.files as string[]) : [];

    if (files.length > 0) {
      await this.execFileWithTimeout('git', ['add', ...files]);
    } else {
      await this.execFileWithTimeout('git', ['add', '-A']);
    }

    await this.execFileWithTimeout('git', ['commit', '-m', message]);
  }

  private async executePush(target: string, payload: Record<string, unknown>): Promise<void> {
    const remote = (payload.remote as string) || 'origin';
    const force = (payload.force as boolean) || false;

    const args = ['push'];
    if (force) args.push('--force-with-lease');
    args.push(remote, target);
    await this.execFileWithTimeout('git', args);
  }

  private async executeMerge(_target: string, payload: Record<string, unknown>): Promise<void> {
    const source = (payload.source as string) || 'HEAD';
    const squash = (payload.squash as boolean) || false;

    const args = ['merge'];
    if (squash) args.push('--squash');
    args.push(source);
    await this.execFileWithTimeout('git', args);
  }

  private async executeWorkflow(target: string, payload: Record<string, unknown>): Promise<void> {
    const workflow = target;
    const ref = (payload.ref as string) || 'main';
    const inputs = payload.inputs as Record<string, string> | undefined;

    const args = ['workflow', 'run', workflow, '--ref', ref];
    if (inputs) {
      for (const [key, value] of Object.entries(inputs)) {
        args.push('-f', `${key}=${value}`);
      }
    }
    await this.execFileWithTimeout('gh', args);
  }

  private async executeDeploy(target: string, payload: Record<string, unknown>): Promise<void> {
    const environment = target;
    const command = (payload.command as string) || `deploy-${environment}`;

    // Split command into executable and args to avoid shell injection.
    // Only simple single-command strings are supported; complex shell
    // pipelines should be wrapped in a script file.
    const parts = command.split(/\s+/);
    const [executable, ...args] = parts;
    await this.execFileWithTimeout(executable, args);
  }

  private updateActionStatus(actionId: number, status: DeployStatus): void {
    const stmt = this.db.prepare(`
      UPDATE deploy_queue SET status = ? WHERE id = ?
    `);
    stmt.run(status, actionId);
  }

  getBatch(batchId: string): DeployBatch | null {
    const batchStmt = this.db.prepare(`
      SELECT id, created_at as createdAt, executed_at as executedAt, status, result
      FROM deploy_batches
      WHERE id = ?
    `);
    const batchRow = batchStmt.get(batchId) as Record<string, unknown> | undefined;
    if (!batchRow) return null;

    const actionsStmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE batch_id = ?
    `);
    const actionRows = actionsStmt.all(batchId) as Array<Record<string, unknown>>;

    const actions = actionRows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    })) as DeployAction[];

    return {
      id: batchId,
      actions,
      createdAt: batchRow.createdAt as string,
      status: batchRow.status as DeployStatus,
    };
  }

  getPendingBatches(): DeployBatch[] {
    const stmt = this.db.prepare(`
      SELECT id FROM deploy_batches WHERE status = 'pending'
    `);
    const rows = stmt.all() as Array<{ id: string }>;

    return rows.map((row) => this.getBatch(row.id)).filter((b): b is DeployBatch => b !== null);
  }

  /**
   * Force flush all pending deploys immediately.
   */
  async flushAll(): Promise<BatchResult[]> {
    const results: BatchResult[] = [];

    let batch = await this.createBatch();
    while (batch) {
      const result = await this.executeBatch(batch.id);
      results.push(result);
      batch = await this.createBatch();
    }

    return results;
  }

  /**
   * Get current batch window configuration.
   */
  getWindowConfig(): DynamicBatchWindows {
    return { ...this.dynamicWindows };
  }

  /**
   * Load configuration from `.uap.json` in the project root,
   * falling back to environment variables for each window.
   */
  static loadFromConfig(projectRoot: string): DeployBatcherConfig {
    const configPath = join(projectRoot, '.uap.json');
    let fileWindows: Partial<DynamicBatchWindows> = {};

    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        // Note: 'deploy.batchWindows' is a non-schema field (not in AgentContextConfigSchema).
        // Using raw JSON.parse intentionally to read this legacy config path.
        if (raw?.deploy?.batchWindows) {
          const bw = raw.deploy.batchWindows;
          if (typeof bw.commit === 'number') fileWindows.commit = bw.commit;
          if (typeof bw.push === 'number') fileWindows.push = bw.push;
          if (typeof bw.merge === 'number') fileWindows.merge = bw.merge;
          if (typeof bw.workflow === 'number') fileWindows.workflow = bw.workflow;
          if (typeof bw.deploy === 'number') fileWindows.deploy = bw.deploy;
        }
      } catch {
        // Ignore malformed config; fall through to env vars
      }
    }

    // Environment variable fallbacks for any windows not set by the file
    const envMap: Record<keyof DynamicBatchWindows, string> = {
      commit: 'UAP_DEPLOY_COMMIT_WINDOW',
      push: 'UAP_DEPLOY_PUSH_WINDOW',
      merge: 'UAP_DEPLOY_MERGE_WINDOW',
      workflow: 'UAP_DEPLOY_WORKFLOW_WINDOW',
      deploy: 'UAP_DEPLOY_DEPLOY_WINDOW',
    };

    for (const [key, envVar] of Object.entries(envMap) as Array<
      [keyof DynamicBatchWindows, string]
    >) {
      if (fileWindows[key] === undefined) {
        const envVal = process.env[envVar];
        if (envVal !== undefined) {
          const parsed = parseInt(envVal, 10);
          if (!isNaN(parsed)) {
            fileWindows[key] = parsed;
          }
        }
      }
    }

    const dynamicWindows = Object.keys(fileWindows).length > 0 ? fileWindows : undefined;
    return { dynamicWindows };
  }

  /**
   * Save the current dynamic window configuration into `.uap.json`
   * under the `deploy.batchWindows` section, preserving existing content.
   */
  saveConfig(projectRoot: string): void {
    const configPath = join(projectRoot, '.uap.json');
    let config: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // Start fresh if the file is malformed
        config = {};
      }
    }

    if (!config.deploy || typeof config.deploy !== 'object') {
      config.deploy = {};
    }
    (config.deploy as Record<string, unknown>).batchWindows = { ...this.dynamicWindows };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  /**
   * Return a DeployBatcherConfig for a named profile.
   */
  static fromProfile(profile: 'fast' | 'safe' | 'default'): DeployBatcherConfig {
    switch (profile) {
      case 'fast':
        return {
          dynamicWindows: {
            commit: 5000,
            push: 1000,
            merge: 2000,
            workflow: 1000,
            deploy: 10000,
          },
        };
      case 'safe':
        return {
          dynamicWindows: {
            commit: 60000,
            push: 10000,
            merge: 30000,
            workflow: 10000,
            deploy: 120000,
          },
        };
      case 'default':
        return {
          dynamicWindows: { ...DEFAULT_DYNAMIC_WINDOWS },
        };
    }
  }

  /**
   * Execute a command with timeout protection.
   * Prevents hung processes from blocking the batch pipeline.
   */
  private execFileWithTimeout(
    command: string,
    args: string[],
    options: { timeout?: number; cwd?: string } = {}
  ): Promise<void> {
    const timeoutMs = options.timeout ?? this.execTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      execFileCb(
        command,
        args,
        { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }
}
