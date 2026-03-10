import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { CoordinationDatabase, getDefaultCoordinationDbPath } from './database.js';
import type { DeployAction, DeployBatch, BatchResult, DeployActionType, DeployStatus } from '../types/coordination.js';
import { execSync } from 'child_process';

/**
 * Dynamic batch window configuration based on action type.
 * Optimizes for speed on time-sensitive operations while allowing
 * batching for operations that benefit from grouping.
 */
export interface DynamicBatchWindows {
  commit: number;    // Default: 30000ms (30s) - allows squashing
  push: number;      // Default: 5000ms (5s) - fast for PRs
  merge: number;     // Default: 10000ms (10s)
  workflow: number;  // Default: 5000ms (5s) - fast triggers
  deploy: number;    // Default: 60000ms (60s) - safety buffer
}

export interface DeployBatcherConfig {
  dbPath?: string;
  batchWindowMs?: number;           // Legacy: single window for all types
  dynamicWindows?: Partial<DynamicBatchWindows>;  // NEW: per-type windows
  maxBatchSize?: number;
  dryRun?: boolean;
  parallelExecution?: boolean;      // NEW: execute independent actions in parallel
  maxParallelActions?: number;      // NEW: limit parallel executions
}

const DEFAULT_DYNAMIC_WINDOWS: DynamicBatchWindows = {
  commit: 30000,    // 30s - allows squashing multiple commits
  push: 5000,       // 5s - fast for PR creation
  merge: 10000,     // 10s - moderate safety
  workflow: 5000,   // 5s - fast workflow triggers
  deploy: 60000,    // 60s - safety buffer for deployments
};

export class DeployBatcher {
  private db: Database.Database;
  private dynamicWindows: DynamicBatchWindows;
  private maxBatchSize: number;
  private dryRun: boolean;
  private parallelExecution: boolean;
  private maxParallelActions: number;

  constructor(config: DeployBatcherConfig = {}) {
    const dbPath = config.dbPath || getDefaultCoordinationDbPath();
    this.db = CoordinationDatabase.getInstance(dbPath).getDatabase();
    
    // Support both legacy single window and new dynamic windows
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
      this.dynamicWindows = DEFAULT_DYNAMIC_WINDOWS;
    }
    
    this.maxBatchSize = config.maxBatchSize || 20;
    this.dryRun = config.dryRun || false;
    this.parallelExecution = config.parallelExecution ?? true;
    this.maxParallelActions = config.maxParallelActions || 5;
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

  private findSimilarAction(
    actionType: DeployActionType,
    target: string
  ): DeployAction | null {
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

  private async mergeActions(existingId: number, newPayload?: Record<string, unknown>): Promise<void> {
    if (!newPayload) return;

    const stmt = this.db.prepare(`
      SELECT payload FROM deploy_queue WHERE id = ?
    `);
    const row = stmt.get(existingId) as { payload: string } | undefined;
    if (!row) return;

    const existingPayload = row.payload ? JSON.parse(row.payload) : {};
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
      
      this.db.prepare(`
        INSERT INTO deploy_batches (id, created_at, status)
        VALUES (?, ?, 'pending')
      `).run(batchId, now);
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

    const squashedMessage = messages.length === 1
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

    this.db.prepare(`
      UPDATE deploy_batches SET status = 'executing', executed_at = ? WHERE id = ?
    `).run(new Date().toISOString(), batchId);

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

    const batchStatus: DeployStatus = failed === 0 ? 'completed' : (executed > 0 ? 'completed' : 'failed');
    this.db.prepare(`
      UPDATE deploy_batches SET status = ?, result = ? WHERE id = ?
    `).run(batchStatus, JSON.stringify({ executed, failed, errors }), batchId);

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
  private categorizeActions(actions: DeployAction[]): { sequential: DeployAction[]; parallel: DeployAction[] } {
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
   */
  private async executeParallel(
    actions: DeployAction[]
  ): Promise<Array<{ action: DeployAction; success: boolean; error?: string }>> {
    const results: Array<{ action: DeployAction; success: boolean; error?: string }> = [];
    
    // Process in chunks to respect maxParallelActions
    for (let i = 0; i < actions.length; i += this.maxParallelActions) {
      const chunk = actions.slice(i, i + this.maxParallelActions);
      
      const chunkResults = await Promise.allSettled(
        chunk.map(async (action) => {
          await this.executeAction(action);
          return action;
        })
      );

      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j];
        const action = chunk[j];
        
        if (result.status === 'fulfilled') {
          this.updateActionStatus(action.id, 'completed');
          results.push({ action, success: true });
        } else {
          const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.updateActionStatus(action.id, 'failed');
          results.push({ action, success: false, error: `Action ${action.id} (${action.actionType}): ${errorMsg}` });
        }
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
    const files = (payload.files as string[]) || [];

    if (files.length > 0) {
      execSync(`git add ${files.join(' ')}`, { stdio: 'pipe' });
    } else {
      execSync('git add -A', { stdio: 'pipe' });
    }

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });
  }

  private async executePush(target: string, payload: Record<string, unknown>): Promise<void> {
    const remote = (payload.remote as string) || 'origin';
    const force = (payload.force as boolean) || false;
    
    const forceFlag = force ? '--force-with-lease' : '';
    execSync(`git push ${forceFlag} ${remote} ${target}`, { stdio: 'pipe' });
  }

  private async executeMerge(_target: string, payload: Record<string, unknown>): Promise<void> {
    const source = (payload.source as string) || 'HEAD';
    const squash = (payload.squash as boolean) || false;

    if (squash) {
      execSync(`git merge --squash ${source}`, { stdio: 'pipe' });
    } else {
      execSync(`git merge ${source}`, { stdio: 'pipe' });
    }
  }

  private async executeWorkflow(target: string, payload: Record<string, unknown>): Promise<void> {
    const workflow = target;
    const ref = (payload.ref as string) || 'main';
    const inputs = payload.inputs as Record<string, string> | undefined;

    let inputsArg = '';
    if (inputs) {
      inputsArg = Object.entries(inputs)
        .map(([key, value]) => `-f ${key}=${value}`)
        .join(' ');
    }

    execSync(`gh workflow run ${workflow} --ref ${ref} ${inputsArg}`, { stdio: 'pipe' });
  }

  private async executeDeploy(target: string, payload: Record<string, unknown>): Promise<void> {
    const environment = target;
    const command = (payload.command as string) || `deploy-${environment}`;
    
    execSync(command, { stdio: 'pipe' });
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
    
    return rows
      .map((row) => this.getBatch(row.id))
      .filter((b): b is DeployBatch => b !== null);
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
}
