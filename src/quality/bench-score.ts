/**
 * bench-score outcome class extractor — quality-tier uplift plan 1.1.
 *
 * The artifact is a bench results file: one entry per task with its terminal
 * status. The same shape serves anchors (an exemplar run — the operator's
 * bar, e.g. a frontier-model pass) and captures (a run to judge).
 *
 * {
 *   "version": 1,
 *   "results": [
 *     { "task": "tb:grep-204", "status": "pass" },
 *     { "task": "tb:sqlite-11", "status": "error" }
 *   ]
 * }
 *
 * Axes (scalars on the TierVector; directions/directives in classes.ts):
 *   passRate   fraction of tasks with status "pass" (partial is not pass)
 *   errorRate  fraction with status "error" (crashes/timeouts — before answers)
 *   taskCount  evidence volume (degenerate guard, not a gated axis)
 *
 * Deterministic: pure counts over the file. Fail-soft on read/shape failure.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { TIER_EXTRACTOR_VERSION, TierVector } from './tier.js';

interface BenchResult {
  task?: string;
  status?: string;
}

interface BenchFile {
  version?: number;
  results?: BenchResult[];
}

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

const KNOWN_STATUS = new Set(['pass', 'fail', 'error', 'partial']);

/** Measure a bench results file into a tier vector. Null on any read/shape failure. */
export function extractBenchVector(path: string): TierVector | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let b: BenchFile;
  try {
    b = JSON.parse(raw) as BenchFile;
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || !Array.isArray(b.results)) return null;

  let pass = 0;
  let error = 0;
  for (const r of b.results) {
    // Unknown status words count as fail for passRate but never as error —
    // a harness the extractor does not recognize must not look "crashed".
    if (r?.status === 'pass') pass += 1;
    if (r?.status === 'error') error += 1;
  }
  const total = b.results.length;
  const scalars: Record<string, number> = {
    passRate: r5(total === 0 ? 0 : pass / total),
    errorRate: r5(total === 0 ? 0 : error / total),
    taskCount: total,
  };

  return {
    extractorVersion: TIER_EXTRACTOR_VERSION,
    canonicalWidth: 0,
    canonicalHeight: 0,
    sha256: createHash('sha256').update(raw).digest('hex'),
    satMean: 0,
    valMean: 0,
    contrast: 0,
    edgeFrac: 0,
    glowFrac: 0,
    darkFrac: 0,
    colors12: 0,
    scalars,
  };
}

/** Exposed for tests: the recognized status vocabulary (documentation of contract). */
export const BENCH_STATUSES = [...KNOWN_STATUS];
