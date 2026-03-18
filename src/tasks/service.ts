import { createHash, randomBytes } from 'crypto';
import type Database from 'better-sqlite3';
import { TaskDatabase, getDefaultTaskDbPath } from './database.js';
import type {
  Task,
  TaskWithRelations,
  TaskDependency,
  TaskHistoryEntry,
  TaskActivity,
  TaskSummary,
  TaskStats,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  TaskType,
  TaskStatus,
  TaskPriority,
  DependencyType,
  TaskActivityType,
  TaskJSONL,
  AddDependencyResult,
} from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getTaskEventBus } from './event-bus.js';

export interface TaskServiceConfig {
  dbPath?: string;
  jsonlPath?: string;
  agentId?: string;
}

export class TaskService {
  private db: Database.Database;
  private jsonlPath: string;
  private agentId?: string;

  constructor(config: TaskServiceConfig = {}) {
    const dbPath = config.dbPath || getDefaultTaskDbPath();
    this.db = TaskDatabase.getInstance(dbPath).getDatabase();
    this.jsonlPath = config.jsonlPath || './.uap/tasks/tasks.jsonl';
    this.agentId = config.agentId;
  }

  // ==================== ID Generation ====================

  private generateId(): string {
    const bytes = randomBytes(4);
    const hash = createHash('md5').update(bytes).digest('hex').slice(0, 4);
    return `uap-${hash}`;
  }

  // ==================== CRUD Operations ====================

  create(input: CreateTaskInput): Task {
    const id = this.generateId();
    const now = new Date().toISOString();

    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      type: input.type || 'task',
      status: 'open',
      priority: (input.priority ?? 2) as TaskPriority,
      assignee: input.assignee,
      labels: input.labels || [],
      notes: input.notes,
      parentId: input.parentId,
      dueDate: input.dueDate,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, type, status, priority, assignee, labels, notes, parent_id, due_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.title,
      task.description || null,
      task.type,
      task.status,
      task.priority,
      task.assignee || null,
      JSON.stringify(task.labels),
      task.notes || null,
      task.parentId || null,
      task.dueDate || null,
      task.createdAt,
      task.updatedAt
    );

    // Record activity
    this.recordActivity(id, 'created', `Created task: ${task.title}`);

    // Record history
    this.recordHistory(id, 'created', null, task.title);

    return task;
  }

  get(id: string): Task | null {
    const stmt = this.db.prepare(`
      SELECT id, title, description, type, status, priority, assignee,
             worktree_branch as worktreeBranch, labels, notes, parent_id as parentId,
             due_date as dueDate, created_at as createdAt, updated_at as updatedAt,
             closed_at as closedAt, closed_reason as closedReason
      FROM tasks WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      ...row,
      labels: row.labels ? JSON.parse(row.labels as string) : [],
    } as Task;
  }

  getWithRelations(id: string): TaskWithRelations | null {
    const task = this.get(id);
    if (!task) return null;

    const deps = this.getDependencies(id);
    const blockedBy = deps
      .filter((d) => d.fromTask === id && d.depType === 'blocks')
      .map((d) => d.toTask);
    const blocks = deps
      .filter((d) => d.toTask === id && d.depType === 'blocks')
      .map((d) => d.fromTask);
    const relatedTo = deps
      .filter((d) => d.depType === 'related')
      .map((d) => (d.fromTask === id ? d.toTask : d.fromTask));
    const children = this.getChildren(id).map((t) => t.id);
    const parent = task.parentId ? this.get(task.parentId) || undefined : undefined;

    // Check if blocked (has unresolved blocking dependencies)
    const unresolvedBlockers = blockedBy.filter((blockerId) => {
      const blocker = this.get(blockerId);
      return blocker && blocker.status !== 'done' && blocker.status !== 'wont_do';
    });

    const isBlocked = unresolvedBlockers.length > 0;
    const isReady = task.status === 'open' && !isBlocked;

    return {
      ...task,
      blockedBy,
      blocks,
      relatedTo,
      children,
      parent,
      isBlocked,
      isReady,
    };
  }

  update(id: string, input: UpdateTaskInput): Task | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: string[] = [];
    const params: unknown[] = [];

    // Track changes for history
    const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

    if (input.title !== undefined && input.title !== existing.title) {
      updates.push('title = ?');
      params.push(input.title);
      changes.push({ field: 'title', oldValue: existing.title, newValue: input.title });
    }

    if (input.description !== undefined && input.description !== existing.description) {
      updates.push('description = ?');
      params.push(input.description || null);
      changes.push({
        field: 'description',
        oldValue: existing.description || null,
        newValue: input.description || null,
      });
    }

    if (input.type !== undefined && input.type !== existing.type) {
      updates.push('type = ?');
      params.push(input.type);
      changes.push({ field: 'type', oldValue: existing.type, newValue: input.type });
    }

    if (input.status !== undefined && input.status !== existing.status) {
      updates.push('status = ?');
      params.push(input.status);
      changes.push({ field: 'status', oldValue: existing.status, newValue: input.status });

      // Set closed_at if closing
      if (input.status === 'done' || input.status === 'wont_do') {
        updates.push('closed_at = ?');
        params.push(now);
      }
    }

    if (input.priority !== undefined && input.priority !== existing.priority) {
      updates.push('priority = ?');
      params.push(input.priority);
      changes.push({
        field: 'priority',
        oldValue: String(existing.priority),
        newValue: String(input.priority),
      });
    }

    if (input.assignee !== undefined && input.assignee !== existing.assignee) {
      updates.push('assignee = ?');
      params.push(input.assignee || null);
      changes.push({
        field: 'assignee',
        oldValue: existing.assignee || null,
        newValue: input.assignee || null,
      });
    }

    if (input.worktreeBranch !== undefined && input.worktreeBranch !== existing.worktreeBranch) {
      updates.push('worktree_branch = ?');
      params.push(input.worktreeBranch || null);
      changes.push({
        field: 'worktreeBranch',
        oldValue: existing.worktreeBranch || null,
        newValue: input.worktreeBranch || null,
      });
    }

    if (input.labels !== undefined) {
      const newLabels = JSON.stringify(input.labels);
      const oldLabels = JSON.stringify(existing.labels);
      if (newLabels !== oldLabels) {
        updates.push('labels = ?');
        params.push(newLabels);
        changes.push({ field: 'labels', oldValue: oldLabels, newValue: newLabels });
      }
    }

    if (input.notes !== undefined && input.notes !== existing.notes) {
      updates.push('notes = ?');
      params.push(input.notes || null);
      changes.push({
        field: 'notes',
        oldValue: existing.notes || null,
        newValue: input.notes || null,
      });
    }

    if (input.dueDate !== undefined && input.dueDate !== existing.dueDate) {
      updates.push('due_date = ?');
      params.push(input.dueDate || null);
      changes.push({
        field: 'dueDate',
        oldValue: existing.dueDate || null,
        newValue: input.dueDate || null,
      });
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updated_at = ?');
    params.push(now);
    params.push(id);

    const stmt = this.db.prepare(`
      UPDATE tasks SET ${updates.join(', ')} WHERE id = ?
    `);
    stmt.run(...params);

    // Record history for each change
    for (const change of changes) {
      this.recordHistory(id, change.field, change.oldValue, change.newValue);
    }

    // Record activity
    this.recordActivity(id, 'updated', `Updated: ${changes.map((c) => c.field).join(', ')}`);

    // Re-fetch the updated task; fall back to the pre-update snapshot if re-fetch fails
    return this.get(id) ?? existing;
  }

  close(id: string, reason?: string): Task | null {
    const task = this.get(id);
    if (!task) return null;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'done', closed_at = ?, closed_reason = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, reason || null, now, id);

    this.recordHistory(id, 'status', task.status, 'done');
    this.recordActivity(id, 'closed', reason || 'Task completed');

    // Notify dependents that may now be unblocked
    this.notifyUnblockedDependents(id);

    // Re-fetch the closed task; fall back to the pre-close snapshot with updated status
    return (
      this.get(id) ?? {
        ...task,
        status: 'done' as const,
        closedAt: now,
        closedReason: reason || undefined,
      }
    );
  }

  /**
   * Check for tasks that were blocked by the completed task and are now ready.
   * Transitions them from 'blocked' to 'open' and emits events.
   */
  private notifyUnblockedDependents(completedTaskId: string): void {
    // Find tasks that this task was blocking
    const dependents = this.db
      .prepare(
        `SELECT from_task FROM task_dependencies
       WHERE to_task = ? AND dep_type = 'blocks'`
      )
      .all(completedTaskId) as Array<{ from_task: string }>;

    if (dependents.length === 0) return;

    const bus = getTaskEventBus();
    const newlyReady: string[] = [];

    for (const dep of dependents) {
      const dependent = this.getWithRelations(dep.from_task);
      if (!dependent) continue;

      if (dependent.isReady) {
        // Task is now unblocked -- record activity
        this.recordActivity(
          dep.from_task,
          'updated',
          `Unblocked: dependency "${completedTaskId}" completed`
        );

        // If task was in 'blocked' status, move to 'open'
        const raw = this.get(dep.from_task);
        if (raw && raw.status === 'blocked') {
          const now = new Date().toISOString();
          this.db
            .prepare(`UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?`)
            .run(now, dep.from_task);
          this.recordHistory(dep.from_task, 'status', 'blocked', 'open');
        }

        newlyReady.push(dep.from_task);

        // Emit per-task unblocked event
        bus
          .emit({
            type: 'task_unblocked',
            taskId: dep.from_task,
            unblockedBy: completedTaskId,
          })
          .catch(() => {
            /* event handler errors are logged by the bus */
          });
      }
    }

    // Emit batch event if multiple tasks became ready
    if (newlyReady.length > 0) {
      bus
        .emit({
          type: 'tasks_ready',
          taskIds: newlyReady,
          triggeredBy: completedTaskId,
        })
        .catch(() => {
          /* event handler errors are logged by the bus */
        });
    }
  }

  delete(id: string): boolean {
    // Delete dependencies first
    this.db.prepare('DELETE FROM task_dependencies WHERE from_task = ? OR to_task = ?').run(id, id);

    // Delete history
    this.db.prepare('DELETE FROM task_history WHERE task_id = ?').run(id);

    // Delete activity
    this.db.prepare('DELETE FROM task_activity WHERE task_id = ?').run(id);

    // Delete task
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ==================== Query Operations ====================

  private hasDueDateColumn(): boolean {
    try {
      const columns = this.db.pragma('table_info(tasks)') as Array<{ name: string }>;
      return columns.some((c) => c.name === 'due_date');
    } catch {
      return false;
    }
  }

  list(filter: TaskFilter = {}): Task[] {
    const hasDueDate = this.hasDueDateColumn();
    let sql = `
      SELECT id, title, description, type, status, priority, assignee,
             worktree_branch as worktreeBranch, labels, notes, parent_id as parentId,
             ${hasDueDate ? 'due_date as dueDate,' : 'NULL as dueDate,'}
             created_at as createdAt, updated_at as updatedAt,
             closed_at as closedAt, closed_reason as closedReason
      FROM tasks WHERE 1=1
    `;
    const params: unknown[] = [];

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    if (filter.priority !== undefined) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
      sql += ` AND priority IN (${priorities.map(() => '?').join(',')})`;
      params.push(...priorities);
    }

    if (filter.assignee) {
      sql += ' AND assignee = ?';
      params.push(filter.assignee);
    }

    if (filter.parentId) {
      sql += ' AND parent_id = ?';
      params.push(filter.parentId);
    }

    if (filter.labels && filter.labels.length > 0) {
      // Match any of the specified labels
      const labelConditions = filter.labels.map(() => 'labels LIKE ?');
      sql += ` AND (${labelConditions.join(' OR ')})`;
      params.push(...filter.labels.map((l) => `%"${l}"%`));
    }

    if (filter.search) {
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      const searchPattern = `%${filter.search}%`;
      params.push(searchPattern, searchPattern);
    }

    if (filter.overdue && hasDueDate) {
      const today = new Date().toISOString().slice(0, 10);
      sql += ' AND due_date IS NOT NULL AND due_date < ? AND status NOT IN (?, ?)';
      params.push(today, 'done', 'wont_do');
    }

    sql += ' ORDER BY priority ASC, created_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    let tasks = rows.map((row) => ({
      ...row,
      labels: row.labels ? JSON.parse(row.labels as string) : [],
    })) as Task[];

    // Post-filter for blocked/ready (requires dependency check)
    if (filter.isBlocked !== undefined || filter.isReady !== undefined) {
      tasks = tasks.filter((task) => {
        const withRelations = this.getWithRelations(task.id);
        if (!withRelations) return false;

        if (filter.isBlocked !== undefined && withRelations.isBlocked !== filter.isBlocked) {
          return false;
        }
        if (filter.isReady !== undefined && withRelations.isReady !== filter.isReady) {
          return false;
        }
        return true;
      });
    }

    return tasks;
  }

  ready(): TaskWithRelations[] {
    const openTasks = this.list({ status: 'open' });
    return this.batchGetWithRelations(openTasks).filter((t) => t.isReady);
  }

  blocked(): TaskWithRelations[] {
    const tasks = this.list({ status: ['open', 'in_progress'] });
    return this.batchGetWithRelations(tasks).filter((t) => t.isBlocked);
  }

  /**
   * Batch version of getWithRelations that prefetches all dependencies in 2 queries
   * instead of N+1 individual queries. Used by ready(), blocked(), and stats().
   */
  batchGetWithRelations(tasks: Task[]): TaskWithRelations[] {
    if (tasks.length === 0) return [];

    // Prefetch ALL dependencies in a single query
    const allDeps = this.db.prepare('SELECT * FROM task_dependencies').all() as Array<{
      id: number;
      from_task: string;
      to_task: string;
      dep_type: string;
      created_at: string;
    }>;

    // Build lookup maps
    const depsByTask = new Map<string, typeof allDeps>();
    for (const dep of allDeps) {
      // Index by both from_task and to_task
      if (!depsByTask.has(dep.from_task)) depsByTask.set(dep.from_task, []);
      depsByTask.get(dep.from_task)!.push(dep);
      if (!depsByTask.has(dep.to_task)) depsByTask.set(dep.to_task, []);
      depsByTask.get(dep.to_task)!.push(dep);
    }

    // Prefetch ALL tasks for blocker status checks (single query)
    const allTaskRows = this.db.prepare('SELECT id, status FROM tasks').all() as Array<{
      id: string;
      status: string;
    }>;
    const taskStatusMap = new Map(allTaskRows.map((t) => [t.id, t.status]));

    // Prefetch children counts
    const childrenRows = this.db
      .prepare('SELECT parent_id, id FROM tasks WHERE parent_id IS NOT NULL')
      .all() as Array<{ parent_id: string; id: string }>;
    const childrenByParent = new Map<string, string[]>();
    for (const row of childrenRows) {
      if (!childrenByParent.has(row.parent_id)) childrenByParent.set(row.parent_id, []);
      childrenByParent.get(row.parent_id)!.push(row.id);
    }

    const results: TaskWithRelations[] = [];

    for (const task of tasks) {
      const deps = depsByTask.get(task.id) || [];
      const blockedBy = deps
        .filter((d) => d.from_task === task.id && d.dep_type === 'blocks')
        .map((d) => d.to_task);
      const blocks = deps
        .filter((d) => d.to_task === task.id && d.dep_type === 'blocks')
        .map((d) => d.from_task);
      const relatedTo = deps
        .filter((d) => d.dep_type === 'related')
        .map((d) => (d.from_task === task.id ? d.to_task : d.from_task));
      const children = childrenByParent.get(task.id) || [];
      const parent = task.parentId ? this.get(task.parentId) || undefined : undefined;

      const unresolvedBlockers = blockedBy.filter((blockerId) => {
        const status = taskStatusMap.get(blockerId);
        return status && status !== 'done' && status !== 'wont_do';
      });

      const isBlocked = unresolvedBlockers.length > 0;
      const isReady = task.status === 'open' && !isBlocked;

      results.push({
        ...task,
        blockedBy,
        blocks,
        relatedTo,
        children,
        parent,
        isBlocked,
        isReady,
      });
    }

    return results;
  }

  getChildren(parentId: string): Task[] {
    return this.list({ parentId });
  }

  // ==================== Dependencies ====================

  addDependency(
    fromTask: string,
    toTask: string,
    depType: DependencyType = 'blocks'
  ): AddDependencyResult {
    // Validate both tasks exist
    if (!this.get(fromTask) || !this.get(toTask)) {
      return { ok: false, reason: 'not_found' };
    }

    // Prevent self-dependency
    if (fromTask === toTask) {
      return { ok: false, reason: 'self_dependency' };
    }

    // Check for cycles (for blocking dependencies)
    if (depType === 'blocks' && this.wouldCreateCycle(fromTask, toTask)) {
      return { ok: false, reason: 'would_create_cycle' };
    }

    const now = new Date().toISOString();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO task_dependencies (from_task, to_task, dep_type, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(fromTask, toTask, depType, now);

      return {
        ok: true,
        dependency: {
          id: result.lastInsertRowid as number,
          fromTask,
          toTask,
          depType,
          createdAt: now,
        },
      };
    } catch {
      // Duplicate dependency (UNIQUE constraint violation)
      return { ok: false, reason: 'duplicate' };
    }
  }

  removeDependency(fromTask: string, toTask: string): boolean {
    const result = this.db
      .prepare(
        `
      DELETE FROM task_dependencies WHERE from_task = ? AND to_task = ?
    `
      )
      .run(fromTask, toTask);
    return result.changes > 0;
  }

  getDependencies(taskId: string): TaskDependency[] {
    const stmt = this.db.prepare(`
      SELECT id, from_task as fromTask, to_task as toTask, dep_type as depType, created_at as createdAt
      FROM task_dependencies
      WHERE from_task = ? OR to_task = ?
    `);
    return stmt.all(taskId, taskId) as TaskDependency[];
  }

  getBlockers(taskId: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT t.* FROM tasks t
      JOIN task_dependencies d ON t.id = d.to_task
      WHERE d.from_task = ? AND d.dep_type = 'blocks'
    `);
    const rows = stmt.all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      labels: row.labels ? JSON.parse(row.labels as string) : [],
    })) as Task[];
  }

  private wouldCreateCycle(fromTask: string, toTask: string): boolean {
    // BFS to check if toTask can reach fromTask
    const visited = new Set<string>();
    const queue = [toTask];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === fromTask) {
        return true; // Cycle detected
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      // Get tasks that current blocks
      const stmt = this.db.prepare(`
        SELECT to_task FROM task_dependencies
        WHERE from_task = ? AND dep_type = 'blocks'
      `);
      const deps = stmt.all(current) as Array<{ to_task: string }>;
      queue.push(...deps.map((d) => d.to_task));
    }

    return false;
  }

  // ==================== History & Activity ====================

  private recordHistory(
    taskId: string,
    field: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO task_history (task_id, field, old_value, new_value, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(taskId, field, oldValue, newValue, this.agentId || null, new Date().toISOString());
  }

  private recordActivity(taskId: string, activity: TaskActivityType, details?: string): void {
    if (!this.agentId) return;

    const stmt = this.db.prepare(`
      INSERT INTO task_activity (task_id, agent_id, activity, details, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(taskId, this.agentId, activity, details || null, new Date().toISOString());
  }

  getHistory(taskId: string): TaskHistoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, task_id as taskId, field, old_value as oldValue, new_value as newValue,
             changed_by as changedBy, changed_at as changedAt
      FROM task_history
      WHERE task_id = ?
      ORDER BY changed_at DESC
    `);
    return stmt.all(taskId) as TaskHistoryEntry[];
  }

  getActivity(taskId: string): TaskActivity[] {
    const stmt = this.db.prepare(`
      SELECT id, task_id as taskId, agent_id as agentId, activity, details, timestamp
      FROM task_activity
      WHERE task_id = ?
      ORDER BY timestamp DESC
    `);
    return stmt.all(taskId) as TaskActivity[];
  }

  // ==================== Statistics ====================

  getStats(): TaskStats {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }
    ).count;

    const byStatus: Record<TaskStatus, number> = {
      open: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      wont_do: 0,
    };
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status')
      .all() as Array<{ status: TaskStatus; count: number }>;
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    const byType: Record<TaskType, number> = {
      task: 0,
      bug: 0,
      feature: 0,
      epic: 0,
      chore: 0,
      story: 0,
    };
    const typeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM tasks GROUP BY type')
      .all() as Array<{ type: TaskType; count: number }>;
    for (const row of typeRows) {
      byType[row.type] = row.count;
    }

    const byPriority: Record<TaskPriority, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    const priorityRows = this.db
      .prepare('SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority')
      .all() as Array<{ priority: TaskPriority; count: number }>;
    for (const row of priorityRows) {
      byPriority[row.priority] = row.count;
    }

    const blocked = this.blocked().length;
    const ready = this.ready().length;

    const today = new Date().toISOString().slice(0, 10);
    let overdue = 0;
    try {
      overdue = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('done', 'wont_do')`
          )
          .get(today) as { count: number }
      ).count;
    } catch {
      // due_date column may not exist in older databases; degrade gracefully
    }

    return {
      total,
      byStatus,
      byType,
      byPriority,
      blocked,
      ready,
      overdue,
    };
  }

  // ==================== JSONL Sync ====================

  exportToJSONL(): string {
    const tasks = this.list({});
    const lines: string[] = [];

    for (const task of tasks) {
      const deps = this.getDependencies(task.id)
        .filter((d) => d.fromTask === task.id)
        .map((d) => ({ toTask: d.toTask, depType: d.depType }));

      const jsonl: TaskJSONL = {
        id: task.id,
        title: task.title,
        description: task.description,
        type: task.type,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee,
        worktreeBranch: task.worktreeBranch,
        labels: task.labels,
        notes: task.notes,
        parentId: task.parentId,
        dueDate: task.dueDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        closedAt: task.closedAt,
        closedReason: task.closedReason,
        dependencies: deps,
      };

      lines.push(JSON.stringify(jsonl));
    }

    return lines.join('\n');
  }

  saveToJSONL(): void {
    const dir = dirname(this.jsonlPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = this.exportToJSONL();
    writeFileSync(this.jsonlPath, content);
  }

  importFromJSONL(): number {
    if (!existsSync(this.jsonlPath)) {
      return 0;
    }

    const content = readFileSync(this.jsonlPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    let imported = 0;

    for (const line of lines) {
      try {
        const data = JSON.parse(line) as TaskJSONL;

        // Check if task exists
        const existing = this.get(data.id);
        if (existing) {
          // Update if JSONL is newer
          if (data.updatedAt > existing.updatedAt) {
            this.db
              .prepare(
                `
              UPDATE tasks SET title = ?, description = ?, type = ?, status = ?, priority = ?,
                assignee = ?, worktree_branch = ?, labels = ?, notes = ?, parent_id = ?,
                due_date = ?, updated_at = ?, closed_at = ?, closed_reason = ?
              WHERE id = ?
            `
              )
              .run(
                data.title,
                data.description || null,
                data.type,
                data.status,
                data.priority,
                data.assignee || null,
                data.worktreeBranch || null,
                JSON.stringify(data.labels),
                data.notes || null,
                data.parentId || null,
                data.dueDate || null,
                data.updatedAt,
                data.closedAt || null,
                data.closedReason || null,
                data.id
              );
          }
        } else {
          // Insert new task
          this.db
            .prepare(
              `
            INSERT INTO tasks (id, title, description, type, status, priority, assignee,
              worktree_branch, labels, notes, parent_id, due_date, created_at, updated_at, closed_at, closed_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
            )
            .run(
              data.id,
              data.title,
              data.description || null,
              data.type,
              data.status,
              data.priority,
              data.assignee || null,
              data.worktreeBranch || null,
              JSON.stringify(data.labels),
              data.notes || null,
              data.parentId || null,
              data.dueDate || null,
              data.createdAt,
              data.updatedAt,
              data.closedAt || null,
              data.closedReason || null
            );
          imported++;
        }

        // Sync dependencies
        for (const dep of data.dependencies || []) {
          this.addDependency(data.id, dep.toTask, dep.depType);
        }
      } catch {
        // Skip invalid lines
      }
    }

    return imported;
  }

  // ==================== Compaction ====================

  compact(olderThanDays = 90): TaskSummary | null {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();

    // Find old closed tasks
    const stmt = this.db.prepare(`
      SELECT id, title, type, labels, closed_at as closedAt
      FROM tasks
      WHERE status IN ('done', 'wont_do') AND closed_at < ?
      ORDER BY closed_at ASC
    `);
    const oldTasks = stmt.all(cutoff) as Array<{
      id: string;
      title: string;
      type: string;
      labels: string;
      closedAt: string;
    }>;

    if (oldTasks.length === 0) {
      return null;
    }

    // Group by quarter
    const quarters = new Map<string, typeof oldTasks>();
    for (const task of oldTasks) {
      const date = new Date(task.closedAt);
      const quarter = `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
      const existing = quarters.get(quarter) || [];
      existing.push(task);
      quarters.set(quarter, existing);
    }

    // Create summaries
    const summaries: TaskSummary[] = [];
    for (const [period, tasks] of quarters) {
      const allLabels = new Set<string>();
      for (const task of tasks) {
        const labels = task.labels ? (JSON.parse(task.labels) as string[]) : [];
        labels.forEach((l) => allLabels.add(l));
      }

      const summary = `Completed ${tasks.length} tasks: ${tasks
        .slice(0, 5)
        .map((t) => t.title)
        .join(', ')}${tasks.length > 5 ? '...' : ''}`;

      const insertStmt = this.db.prepare(`
        INSERT INTO task_summaries (original_ids, summary, labels, closed_period, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = insertStmt.run(
        JSON.stringify(tasks.map((t) => t.id)),
        summary,
        JSON.stringify([...allLabels]),
        period,
        new Date().toISOString()
      );

      summaries.push({
        id: result.lastInsertRowid as number,
        originalIds: tasks.map((t) => t.id),
        summary,
        labels: [...allLabels],
        closedPeriod: period,
        createdAt: new Date().toISOString(),
      });

      // Delete compacted tasks
      const ids = tasks.map((t) => t.id);
      this.db
        .prepare(`DELETE FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
    }

    return summaries[0] || null;
  }

  getSummaries(): TaskSummary[] {
    const stmt = this.db.prepare(`
      SELECT id, original_ids as originalIds, summary, labels, closed_period as closedPeriod, created_at as createdAt
      FROM task_summaries
      ORDER BY closed_period DESC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      originalIds: JSON.parse(row.originalIds as string),
      labels: row.labels ? JSON.parse(row.labels as string) : [],
    })) as TaskSummary[];
  }
}
