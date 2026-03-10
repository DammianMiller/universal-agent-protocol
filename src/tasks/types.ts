import { z } from 'zod';

// Task types
export type TaskType = 'task' | 'bug' | 'feature' | 'epic' | 'chore' | 'story';

// Task status
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'wont_do';

// Priority levels (P0 = critical, P4 = backlog)
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

// Dependency types
export type DependencyType = 'blocks' | 'related' | 'discovered_from';

// Activity types
export type TaskActivityType = 'claimed' | 'released' | 'commented' | 'updated' | 'created' | 'closed';

// Core task interface
export interface Task {
  id: string;                    // Hash ID: uap-xxxx
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;             // Agent ID
  worktreeBranch?: string;       // Associated git worktree
  labels: string[];
  notes?: string;                // Markdown notes
  parentId?: string;             // For hierarchy (epic → story → task)
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  closedReason?: string;
}

// Task dependency edge
export interface TaskDependency {
  id: number;
  fromTask: string;              // The dependent task
  toTask: string;                // The blocking task
  depType: DependencyType;
  createdAt: string;
}

// Task history entry (audit trail)
export interface TaskHistoryEntry {
  id: number;
  taskId: string;
  field: string;
  oldValue?: string;
  newValue?: string;
  changedBy?: string;            // Agent ID
  changedAt: string;
}

// Task activity (for coordination)
export interface TaskActivity {
  id: number;
  taskId: string;
  agentId: string;
  activity: TaskActivityType;
  details?: string;
  timestamp: string;
}

// Compacted task summary
export interface TaskSummary {
  id: number;
  originalIds: string[];
  summary: string;
  labels: string[];
  closedPeriod: string;          // e.g., "2025-Q4"
  createdAt: string;
}

// Task with computed fields
export interface TaskWithRelations extends Task {
  blockedBy: string[];           // IDs of tasks blocking this one
  blocks: string[];              // IDs of tasks this one blocks
  relatedTo: string[];           // IDs of related tasks
  children: string[];            // IDs of child tasks
  parent?: Task;                 // Parent task (if any)
  isBlocked: boolean;            // Computed: has unresolved blockers
  isReady: boolean;              // Computed: open + not blocked
}

// Task creation input
export interface CreateTaskInput {
  title: string;
  description?: string;
  type?: TaskType;
  priority?: TaskPriority;
  labels?: string[];
  parentId?: string;
  assignee?: string;
  notes?: string;
}

// Task update input
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  type?: TaskType;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  worktreeBranch?: string;
  labels?: string[];
  notes?: string;
}

// Task filter for queries
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  type?: TaskType | TaskType[];
  priority?: TaskPriority | TaskPriority[];
  assignee?: string;
  labels?: string[];
  parentId?: string;
  isBlocked?: boolean;
  isReady?: boolean;
  search?: string;               // Search in title/description
}

// Task statistics
export interface TaskStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byType: Record<TaskType, number>;
  byPriority: Record<TaskPriority, number>;
  blocked: number;
  ready: number;
  overdue: number;
}

// JSONL export format (git-tracked)
export interface TaskJSONL {
  id: string;
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  worktreeBranch?: string;
  labels: string[];
  notes?: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  closedReason?: string;
  dependencies: Array<{
    toTask: string;
    depType: DependencyType;
  }>;
}

// Zod schemas for validation
export const TaskTypeSchema = z.enum(['task', 'bug', 'feature', 'epic', 'chore', 'story']);
export const TaskStatusSchema = z.enum(['open', 'in_progress', 'blocked', 'done', 'wont_do']);
export const TaskPrioritySchema = z.number().int().min(0).max(4);
export const DependencyTypeSchema = z.enum(['blocks', 'related', 'discovered_from']);

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  type: TaskTypeSchema.default('task'),
  priority: TaskPrioritySchema.default(2),
  labels: z.array(z.string()).default([]),
  parentId: z.string().optional(),
  assignee: z.string().optional(),
  notes: z.string().optional(),
});

export const UpdateTaskInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  type: TaskTypeSchema.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: z.string().nullable().optional(),
  worktreeBranch: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});

export const TaskFilterSchema = z.object({
  status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
  type: z.union([TaskTypeSchema, z.array(TaskTypeSchema)]).optional(),
  priority: z.union([TaskPrioritySchema, z.array(TaskPrioritySchema)]).optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  isBlocked: z.boolean().optional(),
  isReady: z.boolean().optional(),
  search: z.string().optional(),
});

// Priority labels for display
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  0: 'P0 (Critical)',
  1: 'P1 (High)',
  2: 'P2 (Medium)',
  3: 'P3 (Low)',
  4: 'P4 (Backlog)',
};

// Status icons for display
export const STATUS_ICONS: Record<TaskStatus, string> = {
  open: '○',
  in_progress: '◐',
  blocked: '❄',
  done: '✓',
  wont_do: '✗',
};

// Type icons for display
export const TYPE_ICONS: Record<TaskType, string> = {
  task: '◆',
  bug: '🐛',
  feature: '✨',
  epic: '🎯',
  chore: '🔧',
  story: '📖',
};
