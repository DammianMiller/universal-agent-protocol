/**
 * S1 · ETA instrumentation — per-attempt wall-clock telemetry for orchestrated
 * missions, written to the model-analytics store keyed by (model, task type,
 * complexity).
 *
 * After Lynch's "the agent maintains an ETA for task completion" (mtlynch.io,
 * "Why Are Coding Agents So Dumb?"): estimates a human can trust are built
 * from the agent's own measured history, tuned per task shape and model.
 * S1a (this module) records the samples; the EWMA estimator and its surfaces
 * (dashboard, handsfree status, reactor banner) consume them in S1b.
 *
 * Contract: the recorder is FAIL-SOFT by design — analytics must never break
 * a delivery run. The first failure (missing dir, locked DB, corrupt file)
 * disables the sink for the rest of the process so a broken store costs one
 * attempt's try/catch, not per-task error noise. `UAP_ETA_OFF=1` installs a
 * no-op.
 */
import { ModelAnalytics } from '../models/analytics.js';
import type { TaskComplexity } from '../models/types.js';

/** What the orchestrator knows about one task attempt — the seam type. */
export interface TaskTiming {
  taskId: string;
  success: boolean;
  durationMs: number;
  turns: number;
}

export interface EtaRecorderOptions {
  /** Analytics DB path (default: the store's own project-relative default). */
  dbPath?: string;
  modelId: string;
  /** Free-form task-type key. Default 'orchestrated'. */
  taskType?: string;
  /** Complexity tier key. Default 'medium' (per-task classification is C2). */
  complexity?: TaskComplexity;
}

/**
 * Create a fail-soft timing sink for one delivery run. Callers pass the
 * returned function as `recordTiming` on the orchestrated-mission deps.
 */
export function createEtaRecorder(options: EtaRecorderOptions): (t: TaskTiming) => void {
  if (process.env.UAP_ETA_OFF === '1') return () => undefined;
  let analytics: ModelAnalytics | null = null;
  let broken = false;
  return (t) => {
    if (broken) return;
    try {
      analytics ??= new ModelAnalytics(options.dbPath);
      analytics.recordOutcome({
        modelId: options.modelId,
        taskType: options.taskType ?? 'orchestrated',
        complexity: options.complexity ?? 'medium',
        success: t.success,
        durationMs: t.durationMs,
        turns: t.turns,
        tokensUsed: { input: 0, output: 0 },
        cost: 0,
        taskId: t.taskId,
      });
    } catch {
      // Disable, don't propagate: analytics is telemetry, not a gate. Close
      // the handle (the WAL stays behind otherwise) before latching broken.
      try {
        analytics?.close();
      } catch {
        // already broken — nothing to release
      }
      broken = true;
      analytics = null;
    }
  };
}
