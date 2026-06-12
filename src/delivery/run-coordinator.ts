/**
 * Delivery Run Coordinator — `uap agent` + `uap deploy` integration
 *
 * Makes a delivery run a first-class citizen of the multi-agent coordination
 * layer:
 *
 *  - registers an ephemeral agent for the run (visible in `uap agent status`)
 *  - announces work intent on the project root (overlap detection warns
 *    other agents — and this run — about concurrent edits)
 *  - heartbeats every loop turn so the run never shows as stale
 *  - marks work complete and deregisters when the loop finishes
 *  - on success, can queue a commit of the applied files into the deploy
 *    batcher (`uap deploy status` / `uap deploy flush`)
 *
 * Everything is fail-soft via lazy imports: a missing/locked coordination DB
 * degrades to a no-op coordinator rather than blocking delivery.
 */

import type { DeliveryResult, IterationRecord } from './convergence-loop.js';

export interface RunCoordinator {
  /** Agent id registered for this run; null when coordination is degraded. */
  readonly agentId: string | null;
  /** Overlap warnings returned by the work announcement (may be empty). */
  readonly overlapWarnings: string[];
  /** Heartbeat + status update per loop turn (wire into onIteration). */
  onIteration(record: IterationRecord): void;
  /** Complete the announced work and deregister the agent. */
  finish(result: DeliveryResult): Promise<void>;
  /** Queue a commit of the run's applied files into the deploy batcher. */
  queueDeploy(result: DeliveryResult, message: string): Promise<number | null>;
}

export interface RunCoordinatorOptions {
  instruction: string;
  projectRoot: string;
  modelId: string;
  /** Estimated minutes for the announcement (default 15) */
  estimatedMinutes?: number;
  /** Coordination DB override (tests); defaults to the shared coordination DB */
  dbPath?: string;
}

const NOOP: RunCoordinator = {
  agentId: null,
  overlapWarnings: [],
  onIteration: () => undefined,
  finish: async () => undefined,
  queueDeploy: async () => null,
};

/** All files the loop applied across its iteration history, deduplicated. */
export function collectAppliedFiles(result: DeliveryResult): string[] {
  const files = new Set<string>();
  for (const record of result.history) {
    for (const f of record.filesApplied) files.add(f);
  }
  return [...files];
}

/**
 * Register this delivery run with the coordination service and announce its
 * work. Returns a no-op coordinator when the coordination layer is
 * unavailable — delivery must never fail because coordination did.
 */
export async function createRunCoordinator(
  options: RunCoordinatorOptions
): Promise<RunCoordinator> {
  let registeredId: string | null = null;
  let registeredService: { deregister(id: string): void } | null = null;
  try {
    const { CoordinationService } = await import('../coordination/service.js');
    const service = new CoordinationService(options.dbPath ? { dbPath: options.dbPath } : {});
    const agentId = service.register(`uap-deliver-${options.modelId}`, [
      'delivery',
      'convergence-loop',
    ]);
    registeredId = agentId;
    registeredService = service;
    service.updateStatus(agentId, 'active', options.instruction.slice(0, 200));

    const { overlaps } = service.announceWork(agentId, options.projectRoot, 'editing', {
      description: `uap deliver: ${options.instruction.slice(0, 200)}`,
      estimatedMinutes: options.estimatedMinutes ?? 15,
    });
    const overlapWarnings = overlaps.map((o) => {
      const who = o.agents.map((a) => `${a.name} (${a.intentType})`).join(', ');
      return `${o.resource}: ${who} — ${o.conflictRisk} risk. ${o.suggestion}`;
    });

    // A single loop turn (model call + full gate run) routinely exceeds the
    // stale-agent cutoff, so heartbeat on a timer too — not just per turn —
    // or concurrent cleanup would mark this run stale mid-turn. unref() so
    // the timer never keeps the process alive.
    const heartbeatTimer = setInterval(() => {
      try {
        service.heartbeat(agentId);
      } catch {
        // Heartbeat is best-effort
      }
    }, 30_000);
    heartbeatTimer.unref?.();

    return {
      agentId,
      overlapWarnings,
      onIteration(record: IterationRecord): void {
        try {
          service.heartbeat(agentId);
          service.updateStatus(
            agentId,
            'active',
            `turn ${record.turn}: ${Math.round(record.score * 100)}% of gates`
          );
        } catch {
          // Heartbeat is best-effort
        }
      },
      async finish(result: DeliveryResult): Promise<void> {
        clearInterval(heartbeatTimer);
        try {
          service.completeWork(agentId, options.projectRoot);
          service.updateStatus(
            agentId,
            'completed',
            result.success ? `delivered in ${result.turns} turn(s)` : 'not delivered'
          );
          service.deregister(agentId);
        } catch {
          // Cleanup is best-effort
        }
      },
      async queueDeploy(result: DeliveryResult, message: string): Promise<number | null> {
        if (!result.success) return null;
        try {
          const { DeployBatcher } = await import('../coordination/deploy-batcher.js');
          const batcher = new DeployBatcher(options.dbPath ? { dbPath: options.dbPath } : {});
          const files = collectAppliedFiles(result);
          if (files.length === 0) return null;
          return await batcher.queue(agentId, 'commit', options.projectRoot, {
            message,
            files,
            cwd: options.projectRoot,
            source: 'uap-deliver',
          });
        } catch {
          return null;
        }
      },
    };
  } catch {
    // If registration succeeded but a later step threw, don't leak an
    // 'active' phantom agent into the registry.
    if (registeredId && registeredService) {
      try {
        registeredService.deregister(registeredId);
      } catch {
        // best-effort
      }
    }
    return NOOP;
  }
}
