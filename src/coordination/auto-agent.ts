import { CoordinationService } from './service.js';
import type { AgentRegistryEntry } from '../types/coordination.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auto-agent');

export interface AutoAgentConfig {
  sessionId?: string;
  heartbeatIntervalMs?: number;
  name?: string;
  capabilities?: string[];
  worktreeBranch?: string;
}

export interface AutoAgentResult {
  agent: AgentRegistryEntry;
  service: CoordinationService;
  cleanup: () => void;
}

/**
 * Manages automatic agent registration and lifecycle.
 * Registers the agent on initialization and handles heartbeat/exit cleanup.
 */
export class AutoAgentCoordinator {
  private service: CoordinationService;
  private agentId!: string;
  private heartbeatInterval?: NodeJS.Timeout;
  private config: AutoAgentConfig;
  private cleanedUp = false;
  private exitHandlers: { signal: string; handler: () => void }[] = [];

  constructor(config: AutoAgentConfig) {
    this.config = {
      name: config.name || `agent-${Date.now()}`,
      capabilities: config.capabilities || ['default'],
      worktreeBranch: config.worktreeBranch,
      sessionId: config.sessionId,
      heartbeatIntervalMs: config.heartbeatIntervalMs || 30000,
    };

    this.service = new CoordinationService({
      sessionId: this.config.sessionId,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
    });
  }

  /**
   * Register agent and start heartbeat.
   */
  async start(): Promise<AutoAgentResult> {
    const name = this.config.name ?? `agent-${Date.now()}`;

    // Register agent
    this.agentId = this.service.register(
      name,
      this.config.capabilities,
      this.config.worktreeBranch ?? undefined
    );

    // Update status to active
    this.service.updateStatus(this.agentId, 'active', undefined);

    // Start heartbeat
    this.startHeartbeat();

    // Register exit handlers
    this.registerExitHandlers();

    return {
      agent: this.service.getAgent(this.agentId)!,
      service: this.service,
      cleanup: () => this.cleanup(),
    };
  }

  /**
   * Start periodic heartbeat.
   */
  startHeartbeat(): void {
    // Heartbeat immediately
    this.service.heartbeat(this.agentId);

    // Then every interval (unref to prevent blocking process exit)
    this.heartbeatInterval = setInterval(() => {
      this.service.heartbeat(this.agentId);
    }, this.config.heartbeatIntervalMs);

    // Allow process to exit even if heartbeat is running
    if (this.heartbeatInterval) {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * Register cleanup handlers for graceful shutdown.
   * Uses tracked handlers to prevent listener leaks on repeated start/cleanup cycles.
   */
  private registerExitHandlers(): void {
    const cleanup = () => {
      this.cleanup();
    };

    // Track handlers so we can remove them on cleanup
    for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
      const handler = cleanup;
      this.exitHandlers.push({ signal, handler });
      process.on(signal, handler);
    }
  }

  /**
   * Cleanup: stop heartbeat, mark agent as completed, remove exit handlers.
   * Safe to call multiple times (idempotent).
   */
  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Remove exit handlers to prevent listener leaks
    for (const { signal, handler } of this.exitHandlers) {
      process.removeListener(signal, handler);
    }
    this.exitHandlers = [];

    // Mark agent as completed
    try {
      this.service.updateStatus(this.agentId, 'completed', undefined);
    } catch (error) {
      // Agent may already be deregistered
      log.warn('Failed to update agent status:', error);
    }
  }

  /**
   * Update agent status.
   */
  updateStatus(status: 'active' | 'idle' | 'completed' | 'failed', currentTask?: string): void {
    this.service.updateStatus(this.agentId, status, currentTask ?? undefined);
  }

  /**
   * Announce work on a resource.
   */
  announceWork(
    resource: string,
    intentType: 'editing' | 'reviewing' | 'refactoring' | 'testing' | 'documenting',
    options: {
      description?: string;
      filesAffected?: string[];
      estimatedMinutes?: number;
    } = {}
  ) {
    return this.service.announceWork(this.agentId, resource, intentType, options);
  }

  /**
   * Complete work on a resource.
   */
  completeWork(resource: string): void {
    this.service.completeWork(this.agentId, resource);
  }

  /**
   * Check for overlaps on a resource.
   */
  checkOverlaps(resource: string): import('../types/coordination.js').WorkOverlap[] {
    return this.service.detectOverlaps(resource, this.agentId);
  }

  /**
   * Get the agent ID.
   */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Get the coordination service.
   */
  getService(): CoordinationService {
    return this.service;
  }
}

/**
 * Factory function for creating auto agents.
 */
export function createAutoAgent(config: AutoAgentConfig): AutoAgentCoordinator {
  return new AutoAgentCoordinator(config);
}
