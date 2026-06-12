/**
 * HALO Delivery Tracer — observability for the convergence loop
 *
 * Emits delivery runs as HALO/OpenInference spans so `uap harness analyze`
 * can mine systemic failure modes across runs (which gates dominate, where
 * turns stall, which strategies win). One AGENT span per run, one CHAIN span
 * per turn, parented to the run.
 *
 * Inherits the exporter's guarantees: zero overhead when tracing is disabled
 * and never throws into the loop.
 */

import {
  isHaloTracingEnabled,
  newSpanId,
  recordHaloSpan,
} from '../observability/halo-exporter.js';
import type { DeliveryResult, IterationRecord } from './convergence-loop.js';

export interface HaloDeliveryTracer {
  /** Record one loop turn as a CHAIN span (wire into onIteration). */
  onIteration(record: IterationRecord): void;
  /** Record the run-level AGENT span once the loop returns. */
  finish(result: DeliveryResult): void;
}

export interface HaloDeliveryTracerOptions {
  instruction: string;
  modelId: string;
  projectRoot: string;
}

const MAX_ERROR_CHARS = 1_000;

/**
 * Error strings can embed model-controlled text (rejected file-block paths,
 * HTTP payloads). Strip control characters and cap length before persisting
 * to the trace file — `uap harness analyze` replays these into an LLM, so
 * they must be treated as untrusted data, never as raw instructions.
 */
function sanitizeError(text: string): string {
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, MAX_ERROR_CHARS);
  /* eslint-enable no-control-regex */
}

/**
 * Create a tracer for a single delivery run. All emission is gated on
 * isHaloTracingEnabled(), so constructing one unconditionally is free.
 */
export function createHaloDeliveryTracer(options: HaloDeliveryTracerOptions): HaloDeliveryTracer {
  const runSpanId = newSpanId();
  const runStart = Date.now();

  return {
    onIteration(record: IterationRecord): void {
      if (!isHaloTracingEnabled()) return;
      const end = Date.now();
      recordHaloSpan({
        kind: 'CHAIN',
        name: `delivery.turn.${record.turn}`,
        startTimeMs: end - record.durationMs,
        endTimeMs: end,
        ok: record.passed,
        parentSpanId: runSpanId,
        attributes: {
          'delivery.turn': record.turn,
          'delivery.score': record.score,
          'delivery.files_applied': record.filesApplied.length,
          ...(record.strategy ? { 'delivery.strategy': record.strategy } : {}),
          ...(record.candidates ? { 'delivery.candidates': record.candidates.length } : {}),
          ...(record.executorError
            ? { 'delivery.executor_error': sanitizeError(record.executorError) }
            : {}),
          ...(record.applyError ? { 'delivery.apply_error': sanitizeError(record.applyError) } : {}),
          'delivery.gates_failed': record.gateResults
            .filter((g) => !g.passed && !g.skipped)
            .map((g) => g.id)
            .join(','),
        },
      });
    },

    finish(result: DeliveryResult): void {
      if (!isHaloTracingEnabled()) return;
      recordHaloSpan({
        kind: 'AGENT',
        name: 'agent.deliver',
        startTimeMs: runStart,
        endTimeMs: Date.now(),
        ok: result.success,
        spanId: runSpanId,
        attributes: {
          'agent.name': 'deliver',
          'delivery.instruction': options.instruction.slice(0, 500),
          'delivery.model': options.modelId,
          'delivery.project_root': options.projectRoot,
          'delivery.turns': result.turns,
          'delivery.best_score': result.bestScore,
          'delivery.best_turn': result.bestTurn,
          'delivery.already_delivered': result.alreadyDelivered,
        },
      });
    },
  };
}
