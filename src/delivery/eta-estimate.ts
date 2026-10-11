/**
 * S1b · ETA estimation — the EWMA estimator over the S1a sample stream
 * (bridge P5: "ETA surfaces").
 *
 * After Lynch's "the agent maintains an ETA for task completion" (mtlynch.io,
 * "Why Are Coding Agents So Dumb?"): estimates a human can trust are built
 * from the agent's own measured history, tuned per task shape and model. S1a
 * (delivery/eta.ts) records per-attempt wall-clock samples into the
 * model-analytics store keyed by (model, taskType, complexity); this module
 * folds those samples into an exponentially-weighted moving average — recent
 * attempts count more, because the model, the harness, and the task mix all
 * drift — and hands the estimate to its surfaces (the `uap eta` CLI, the
 * dashboard's models view, handsfree status, and the reactor's session
 * banner).
 *
 * Honesty rules, in order of importance:
 * - **Few samples are not an estimate.** Fewer than 3 successful attempts in
 *   the window yields null — surfaces show nothing rather than a number
 *   invented from noise. 3–5 samples is `thin` (shown with the caveat); 6 or
 *   more is `solid`.
 * - **The spread is part of the number.** min/max of the folded samples travel
 *   with the estimate; a surface that prints "~2 min" without the spread is
 *   lying by omission.
 * - **Failures are visible.** The estimator folds SUCCESS durations (that is
 *   what "how long does a completing attempt take" means), but it also
 *   reports the observed failure rate and the attempts-per-success — expected
 *   WALL time scales by them, and a 50%-failure key must not present its
 *   successes as its pace.
 *
 * Contract: pure math over a plain sample array (no store, no fs) so the
 * estimator is unit-testable and deterministic; the store wrapper
 * (`estimatePace`) is fail-soft like the S1a recorder — a broken store costs
 * one try/catch, never a crash in a surface.
 */
import { existsSync } from 'fs';
import { ModelAnalytics, resolveAnalyticsDbPath } from '../models/analytics.js';

/** One S1a sample as the store returns it (newest first). */
export interface EtaSample {
  durationMs: number;
  success: boolean;
  turns: number;
  timestamp: string;
}

/** Confidence tier derived from the sample count. */
export type EtaConfidence = 'thin' | 'solid';

/** Fewer successful samples than this ⇒ no estimate at all. */
export const MIN_ETA_SAMPLES = 3;
/** At or above this many successful samples the estimate is `solid`. */
export const SOLID_ETA_SAMPLES = 6;
/** Default EWMA half-life, in SAMPLES (not time): ~10 attempts to forget. */
export const DEFAULT_ETA_HALF_LIFE = 10;

export interface EtaEstimate {
  /** EWMA of SUCCESSFUL-attempt durations, in ms. */
  etaMs: number;
  /** EWMA of turns over the same successful attempts. */
  etaTurns: number;
  /** Successful attempts folded into the average. */
  samples: number;
  /** ALL attempts observed in the window, failures included. */
  observed: number;
  /** successes / observed over the window. */
  successRate: number;
  /** observed / successes — what a completing task EXPECTS to spend. */
  attemptsPerSuccess: number;
  /** Honest spread of the folded successful durations. */
  minMs: number;
  maxMs: number;
  /** Timestamp of the newest sample in the window. */
  lastSampleAt: string;
  /** Samples per half-life used for the fold. */
  halfLifeSamples: number;
  confidence: EtaConfidence;
}

export interface EwmaEstimateOptions {
  /** Half-life in samples (default 10). */
  halfLifeSamples?: number;
}

/**
 * Fold the sample stream into an estimate. `samples` may be newest-first (the
 * store's order — it is reversed internally); the EWMA always folds
 * OLDEST→NEWEST so recency weighs most. Returns null when there are fewer
 * than MIN_ETA_SAMPLES successful attempts — thin data is not an estimate.
 */
export function ewmaEstimate(samples: EtaSample[], opts: EwmaEstimateOptions = {}): EtaEstimate | null {
  const halfLifeSamples = Math.max(1, opts.halfLifeSamples ?? DEFAULT_ETA_HALF_LIFE);
  // alpha from a half-life in samples: alpha = 1 - 2^(-1/halfLife).
  const alpha = 1 - Math.pow(2, -1 / halfLifeSamples);

  const oldest = [...samples].reverse();
  const successes = oldest.filter((s) => s.success && Number.isFinite(s.durationMs) && s.durationMs >= 0);
  if (successes.length < MIN_ETA_SAMPLES) return null;

  let ms = successes[0].durationMs;
  let turns = successes[0].turns;
  let minMs = successes[0].durationMs;
  let maxMs = successes[0].durationMs;
  for (let i = 1; i < successes.length; i++) {
    const s = successes[i];
    ms += alpha * (s.durationMs - ms);
    // turns is advisory display data; the store guarantees a number, but a
    // hostile/legacy row must not poison etaTurns with NaN.
    const sTurns = Number.isFinite(s.turns) ? s.turns : turns;
    turns += alpha * (sTurns - turns);
    minMs = Math.min(minMs, s.durationMs);
    maxMs = Math.max(maxMs, s.durationMs);
  }

  const observed = oldest.filter((s) => Number.isFinite(s.durationMs)).length;
  const lastSampleAt = oldest[oldest.length - 1]?.timestamp ?? '';
  return {
    etaMs: ms,
    etaTurns: turns,
    samples: successes.length,
    observed,
    successRate: successes.length / Math.max(1, observed),
    attemptsPerSuccess: Math.max(1, observed / Math.max(1, successes.length)),
    minMs,
    maxMs,
    lastSampleAt,
    halfLifeSamples,
    confidence: successes.length >= SOLID_ETA_SAMPLES ? 'solid' : 'thin',
  };
}

/** Human string for a duration: ms → "1.2 min" / "42s" / "3.4h". */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)}h`;
}

export interface EstimatePaceOptions {
  /** Analytics DB path (default: the store's own project-relative default). */
  dbPath?: string;
  modelId: string;
  taskType?: string;
  complexity?: string;
  /** Sample window size (default 50, same as the store's). */
  limit?: number;
  halfLifeSamples?: number;
  /**
   * Refuse instead of OPEN when the DB file does not exist. The reactor's
   * injection path runs per prompt: without this it would materialize an
   * empty store on disk for every fresh checkout — a read surface must not
   * create the thing it reads. (Opening a MISSING store also creates it;
   * opening a present one does not.)
   */
  requireExisting?: boolean;
}

/**
 * Read the S1a sample stream from the store and fold it. Fail-soft: a broken
 * or missing store yields null (no estimate), never a throw — the same
 * contract as the S1a recorder, for the same reason (analytics is telemetry,
 * not a gate).
 */
export function estimatePace(options: EstimatePaceOptions): EtaEstimate | null {
  let analytics: ModelAnalytics | null = null;
  try {
    if (options.requireExisting && !existsSync(resolveAnalyticsDbPath(options.dbPath))) return null;
    analytics = new ModelAnalytics(options.dbPath);
    const samples = analytics.recentDurations(
      options.modelId,
      options.taskType ?? 'orchestrated',
      options.complexity ?? 'medium',
      options.limit ?? 50
    );
    return ewmaEstimate(samples, { halfLifeSamples: options.halfLifeSamples });
  } catch {
    return null;
  } finally {
    try {
      analytics?.close();
    } catch {
      // already closed — nothing to release
    }
  }
}

/**
 * Expected wall-clock for `items` remaining tasks, scaled by the key's
 * attempts-per-success: a 60%-success key completing 5 items is expected to
 * burn 5 / 0.6 attempts, and the operator should see THAT number. Null when
 * there is no estimate.
 */
export function remainingWallMs(estimate: EtaEstimate | null, items: number): number | null {
  if (!estimate || !Number.isFinite(items) || items <= 0) return null;
  return items * estimate.attemptsPerSuccess * estimate.etaMs;
}

/** One (model, taskType, complexity) key the store holds history for. */
export interface PaceKey {
  modelId: string;
  taskType: string;
  complexity: string;
  attempts: number;
}

/**
 * Every key with history, each with its estimate, in ONE store open (the
 * enumeration and the sample reads share a handle — N keys must not cost N
 * opens). Fail-soft like `estimatePace`: no store, empty list, never a
 * throw. `maxKeys` caps the enumeration (default 50) — an unbounded key
 * walk on a long-lived store is a resource hazard, and the operator's list
 * stays honest via the `truncated` flag.
 */
export function listPaceKeys(
  opts: { dbPath?: string; limit?: number; halfLifeSamples?: number; maxKeys?: number } = {}
): { keys: PaceKey[]; estimates: Array<{ key: PaceKey; estimate: EtaEstimate | null }>; truncated: boolean } {
  let analytics: ModelAnalytics | null = null;
  try {
    analytics = new ModelAnalytics(opts.dbPath);
    const maxKeys = opts.maxKeys ?? 50;
    const all = analytics.distinctOutcomeKeys();
    const keys = all.slice(0, maxKeys);
    const estimates = keys.map((k) => ({
      key: k,
      estimate: ewmaEstimate(analytics!.recentDurations(k.modelId, k.taskType, k.complexity, opts.limit ?? 50), {
        halfLifeSamples: opts.halfLifeSamples,
      }),
    }));
    return { keys, estimates, truncated: all.length > maxKeys };
  } catch {
    return { keys: [], estimates: [], truncated: false };
  } finally {
    try {
      analytics?.close();
    } catch {
      // already closed — nothing to release
    }
  }
}
