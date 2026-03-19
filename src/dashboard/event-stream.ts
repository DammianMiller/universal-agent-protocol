/**
 * Dashboard Event Stream
 *
 * Centralized event bus that captures live events from all UAP subsystems
 * and streams them to connected web dashboard clients via SSE.
 *
 * Events are categorized by type:
 *   - policy: enforcement checks, blocks, stage changes
 *   - memory: lookups, hits, misses, consolidation
 *   - deploy: queue, batch, execute, complete
 *   - agent: register, start, progress, complete, error
 *   - task: create, start, complete, fail
 *   - skill: match, activate, deactivate
 *   - pattern: match, activate
 *   - cost: token usage, cost tracking
 *   - system: errors, warnings, info
 */

export type DashboardEventCategory =
  | 'policy'
  | 'memory'
  | 'deploy'
  | 'agent'
  | 'task'
  | 'skill'
  | 'pattern'
  | 'cost'
  | 'system';

export interface DashboardEvent {
  id: number;
  timestamp: string;
  category: DashboardEventCategory;
  type: string;
  severity: 'info' | 'warn' | 'error' | 'success';
  title: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

type EventHandler = (event: DashboardEvent) => void;

const MAX_EVENT_HISTORY = 200;

class DashboardEventBus {
  private handlers: EventHandler[] = [];
  private history: DashboardEvent[] = [];
  private nextId = 1;

  /**
   * Subscribe to all dashboard events.
   * Returns an unsubscribe function.
   */
  subscribe(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Emit a new event to all subscribers.
   */
  emit(
    category: DashboardEventCategory,
    type: string,
    severity: DashboardEvent['severity'],
    title: string,
    detail?: string,
    metadata?: Record<string, unknown>
  ): void {
    const event: DashboardEvent = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      category,
      type,
      severity,
      title,
      detail,
      metadata,
    };

    this.history.push(event);
    if (this.history.length > MAX_EVENT_HISTORY) {
      this.history = this.history.slice(-MAX_EVENT_HISTORY);
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Handler errors are non-fatal
      }
    }
  }

  /**
   * Get recent event history.
   */
  getHistory(limit: number = 50): DashboardEvent[] {
    return this.history.slice(-limit);
  }

  /**
   * Get events since a specific event ID.
   */
  getEventsSince(lastId: number): DashboardEvent[] {
    return this.history.filter((e) => e.id > lastId);
  }

  /**
   * Get subscriber count.
   */
  subscriberCount(): number {
    return this.handlers.length;
  }

  /**
   * Clear all history and handlers.
   */
  clear(): void {
    this.handlers = [];
    this.history = [];
    this.nextId = 1;
  }
}

// ── Singleton ──

let _globalEventBus: DashboardEventBus | null = null;

export function getDashboardEventBus(): DashboardEventBus {
  if (!_globalEventBus) {
    _globalEventBus = new DashboardEventBus();
  }
  return _globalEventBus;
}

export function resetDashboardEventBus(): void {
  _globalEventBus?.clear();
  _globalEventBus = null;
}

// ── Convenience emitters for each subsystem ──

export function emitPolicyEvent(
  type: string,
  title: string,
  allowed: boolean,
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit(
    'policy',
    type,
    allowed ? 'success' : 'error',
    title,
    detail,
    metadata
  );
}

export function emitMemoryEvent(
  type: string,
  title: string,
  hit: boolean,
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit(
    'memory',
    type,
    hit ? 'success' : 'info',
    title,
    detail,
    metadata
  );
}

export function emitDeployEvent(
  type: string,
  title: string,
  severity: DashboardEvent['severity'] = 'info',
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit('deploy', type, severity, title, detail, metadata);
}

export function emitAgentEvent(
  type: string,
  title: string,
  severity: DashboardEvent['severity'] = 'info',
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit('agent', type, severity, title, detail, metadata);
}

export function emitTaskEvent(
  type: string,
  title: string,
  severity: DashboardEvent['severity'] = 'info',
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit('task', type, severity, title, detail, metadata);
}

export function emitSystemEvent(
  type: string,
  title: string,
  severity: DashboardEvent['severity'] = 'info',
  detail?: string,
  metadata?: Record<string, unknown>
): void {
  getDashboardEventBus().emit('system', type, severity, title, detail, metadata);
}
