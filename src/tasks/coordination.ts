import { TaskService } from './service.js';
import { CoordinationService } from '../coordination/service.js';
import type { Task, TaskWithRelations } from './types.js';
import type { WorkAnnouncement, WorkOverlap, CollaborationSuggestion } from '../types/coordination.js';

export interface TaskCoordinationConfig {
  taskService: TaskService;
  coordinationService: CoordinationService;
  agentId: string;
  agentName: string;
  worktreeBranch?: string;
}

export interface ClaimResult {
  task: TaskWithRelations;
  announcement: WorkAnnouncement;
  overlaps: WorkOverlap[];
  suggestions: CollaborationSuggestion[];
  worktreeBranch?: string;
}

export interface ReleaseResult {
  task: Task;
  completedAnnouncements: number;
}

/**
 * Coordinates task operations with the agent coordination system.
 * Handles claiming/releasing tasks, overlap detection, and multi-agent awareness.
 */
export class TaskCoordinator {
  private taskService: TaskService;
  private coordService: CoordinationService;
  private agentId: string;
  private worktreeBranch?: string;

  constructor(config: TaskCoordinationConfig) {
    this.taskService = config.taskService;
    this.coordService = config.coordinationService;
    this.agentId = config.agentId;
    this.worktreeBranch = config.worktreeBranch;
  }

  /**
   * Claim a task for this agent.
   * - Assigns the task to this agent
   * - Creates worktree branch if needed
   * - Announces work to coordination system
   * - Detects overlaps with other agents
   */
  async claim(taskId: string, worktreeBranch?: string): Promise<ClaimResult | null> {
    const task = this.taskService.getWithRelations(taskId);
    if (!task) {
      return null;
    }

    // Check if already assigned to another agent
    if (task.assignee && task.assignee !== this.agentId) {
      throw new Error(`Task already assigned to agent: ${task.assignee}`);
    }

    // Check if task is blocked
    if (task.isBlocked) {
      throw new Error(`Task is blocked by: ${task.blockedBy.join(', ')}`);
    }

    const branch = worktreeBranch || this.worktreeBranch || `feature/task-${taskId}`;

    // Update task
    this.taskService.update(taskId, {
      status: 'in_progress',
      assignee: this.agentId,
      worktreeBranch: branch,
    });

    // Determine files/resources affected by this task
    const resource = this.taskToResource(task);

    // Announce work
    const { announcement, overlaps, suggestions } = this.coordService.announceWork(
      this.agentId,
      resource,
      'editing',
      {
        description: `Working on task: ${task.title}`,
        estimatedMinutes: this.estimateMinutes(task),
      }
    );

    // Get updated task
    const updatedTask = this.taskService.getWithRelations(taskId)!;

    return {
      task: updatedTask,
      announcement,
      overlaps,
      suggestions,
      worktreeBranch: branch,
    };
  }

  /**
   * Release a task (mark complete, announce completion).
   */
  async release(taskId: string, reason?: string): Promise<ReleaseResult | null> {
    const task = this.taskService.get(taskId);
    if (!task) {
      return null;
    }

    // Close the task
    const closedTask = this.taskService.close(taskId, reason);
    if (!closedTask) {
      return null;
    }

    // Complete work announcement
    const resource = this.taskToResource(task);
    this.coordService.completeWork(this.agentId, resource);

    // Broadcast task completion
    this.coordService.broadcast(this.agentId, 'coordination', {
      action: 'task_completed',
      resource: taskId,
      data: {
        title: task.title,
        reason,
      },
    });

    return {
      task: closedTask,
      completedAnnouncements: 1,
    };
  }

  /**
   * Check for overlaps before working on a task.
   */
  checkOverlaps(taskId: string): WorkOverlap[] {
    const task = this.taskService.get(taskId);
    if (!task) {
      return [];
    }

    const resource = this.taskToResource(task);
    return this.coordService.detectOverlaps(resource, this.agentId);
  }

  /**
   * Find tasks that other agents are working on in the same area.
   */
  findRelatedActiveWork(taskId: string): Array<{ task: Task; agent: string; overlap: WorkOverlap }> {
    const task = this.taskService.get(taskId);
    if (!task) {
      return [];
    }

    const activeWork = this.coordService.getActiveWork();
    const results: Array<{ task: Task; agent: string; overlap: WorkOverlap }> = [];

    for (const work of activeWork) {
      if (work.agentId === this.agentId) continue;

      // Check if this work overlaps with our task
      const overlaps = this.coordService.detectOverlaps(this.taskToResource(task));
      for (const overlap of overlaps) {
        if (overlap.agents.some(a => a.id === work.agentId)) {
          // Find the task this agent is working on
          const agentTasks = this.taskService.list({ assignee: work.agentId, status: 'in_progress' });
          for (const agentTask of agentTasks) {
            results.push({
              task: agentTask,
              agent: work.agentName || work.agentId,
              overlap,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Suggest optimal task assignment based on current work distribution.
   */
  suggestNextTask(): TaskWithRelations | null {
    const readyTasks = this.taskService.ready();
    if (readyTasks.length === 0) {
      return null;
    }

    // Get currently active work to avoid conflicts
    const activeWork = this.coordService.getActiveWork();
    const activeResources = new Set(activeWork.map(w => w.resource));

    // Score each task
    const scored = readyTasks.map(task => {
      let score = 0;

      // Priority score (P0 = 40, P4 = 0)
      score += (4 - task.priority) * 10;

      // Prefer tasks without overlaps
      const resource = this.taskToResource(task);
      if (!activeResources.has(resource)) {
        score += 20;
      }

      // Prefer tasks with no dependencies (simpler)
      if (task.blockedBy.length === 0) {
        score += 5;
      }

      // Prefer tasks that unblock others
      if (task.blocks.length > 0) {
        score += task.blocks.length * 3;
      }

      return { task, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored[0]?.task || null;
  }

  /**
   * Get merge order suggestions for tasks with overlapping work.
   */
  getMergeOrderSuggestion(taskIds: string[]): string[] {
    const tasks = taskIds
      .map(id => this.taskService.get(id))
      .filter((t): t is Task => t !== null);

    if (tasks.length === 0) {
      return [];
    }

    // Order by: P0 first, then by type (bugs before features), then by creation date
    const typeOrder: Record<string, number> = {
      bug: 0,
      task: 1,
      chore: 2,
      feature: 3,
      story: 4,
      epic: 5,
    };

    tasks.sort((a, b) => {
      // Priority first
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Then type
      const aTypeOrder = typeOrder[a.type] ?? 10;
      const bTypeOrder = typeOrder[b.type] ?? 10;
      if (aTypeOrder !== bTypeOrder) {
        return aTypeOrder - bTypeOrder;
      }
      // Then creation date
      return a.createdAt.localeCompare(b.createdAt);
    });

    return tasks.map(t => t.id);
  }

  /**
   * Convert a task to a resource identifier for the coordination system.
   */
  private taskToResource(task: Task): string {
    // Use labels to infer affected area, or fall back to task type
    if (task.labels.length > 0) {
      return `task:${task.labels[0]}/${task.id}`;
    }
    return `task:${task.type}/${task.id}`;
  }

  /**
   * Estimate time to complete a task based on type and complexity.
   */
  private estimateMinutes(task: Task | TaskWithRelations): number {
    // Base estimate by type
    const baseMinutes: Record<string, number> = {
      bug: 30,
      task: 60,
      chore: 45,
      feature: 120,
      story: 180,
      epic: 480,
    };

    let estimate = baseMinutes[task.type] || 60;

    // Adjust by priority (P0 often needs more focus)
    if (task.priority === 0) {
      estimate *= 1.5;
    }

    // Adjust if it has children (epic/story)
    if ('children' in task && task.children.length > 0) {
      estimate += task.children.length * 30;
    }

    return Math.round(estimate);
  }
}
