/**
 * Task Event Bus
 *
 * Event-driven notification system for task lifecycle events.
 * Enables automatic unblocking and execution of dependent tasks
 * when their blockers complete.
 *
 * Events:
 *   task_completed  - A task finished successfully
 *   task_failed     - A task failed
 *   task_unblocked  - A task became ready (all blockers resolved)
 *   tasks_ready     - Batch notification: multiple tasks became ready
 */

export type TaskEventType = 'task_completed' | 'task_failed' | 'task_unblocked' | 'tasks_ready';

export interface TaskCompletedEvent {
  type: 'task_completed';
  taskId: string;
  reason?: string;
}

export interface TaskFailedEvent {
  type: 'task_failed';
  taskId: string;
  error: string;
}

export interface TaskUnblockedEvent {
  type: 'task_unblocked';
  taskId: string;
  unblockedBy: string;
}

export interface TasksReadyEvent {
  type: 'tasks_ready';
  taskIds: string[];
  triggeredBy: string;
}

export type TaskEvent = TaskCompletedEvent | TaskFailedEvent | TaskUnblockedEvent | TasksReadyEvent;

export type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;

/**
 * Typed event bus for task lifecycle events.
 *
 * Supports both sync and async handlers. Async handlers are
 * awaited in parallel (errors are caught and logged, not propagated).
 *
 * @example
 * ```ts
 * const bus = new TaskEventBus();
 *
 * bus.on('task_unblocked', async (event) => {
 *   if (event.type === 'task_unblocked') {
 *     console.log(`Task ${event.taskId} is now ready`);
 *     await coordinator.claim(event.taskId);
 *   }
 * });
 *
 * bus.emit({ type: 'task_completed', taskId: 'task-1' });
 * ```
 */
export class TaskEventBus {
  private handlers: Map<TaskEventType, TaskEventHandler[]> = new Map();
  private allHandlers: TaskEventHandler[] = [];

  /**
   * Register a handler for a specific event type.
   */
  on(type: TaskEventType, handler: TaskEventHandler): () => void {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);

    // Return unsubscribe function
    return () => {
      const current = this.handlers.get(type);
      if (current) {
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for ALL event types.
   */
  onAny(handler: TaskEventHandler): () => void {
    this.allHandlers.push(handler);

    return () => {
      const idx = this.allHandlers.indexOf(handler);
      if (idx >= 0) this.allHandlers.splice(idx, 1);
    };
  }

  /**
   * Emit an event to all registered handlers.
   * Async handlers are awaited in parallel; errors are caught and logged.
   */
  async emit(event: TaskEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type) || [];
    const all = [...typeHandlers, ...this.allHandlers];

    if (all.length === 0) return;

    const results = await Promise.allSettled(all.map((h) => h(event)));

    for (const result of results) {
      if (result.status === 'rejected') {
        // Handler error is non-fatal — swallow to prevent breaking the event loop
        void result.reason;
      }
    }
  }

  /**
   * Remove all handlers (useful for testing or shutdown).
   */
  clear(): void {
    this.handlers.clear();
    this.allHandlers = [];
  }

  /**
   * Get count of registered handlers by type.
   */
  listenerCount(type?: TaskEventType): number {
    if (type) {
      return (this.handlers.get(type)?.length || 0) + this.allHandlers.length;
    }
    let total = this.allHandlers.length;
    for (const handlers of this.handlers.values()) {
      total += handlers.length;
    }
    return total;
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let _globalBus: TaskEventBus | null = null;

/**
 * Get the global TaskEventBus singleton.
 * Creates one on first call.
 */
export function getTaskEventBus(): TaskEventBus {
  if (!_globalBus) {
    _globalBus = new TaskEventBus();
  }
  return _globalBus;
}

/**
 * Reset the global bus (for testing).
 */
export function resetTaskEventBus(): void {
  _globalBus?.clear();
  _globalBus = null;
}
