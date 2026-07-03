/**
 * Auto-Mine — close the HALO self-improvement loop.
 *
 * HALO tracing is on by default, but until now the analysis step was manual
 * (`uap harness analyze`), so findings never flowed back into the harness.
 * This module mines the local trace file after every delivery run using the
 * self-harness span classifier, persists the ranked weakness report to
 * `.uap/halo/weaknesses.json`, and returns the top findings for display —
 * every run makes the next run a little smarter, no operator required.
 *
 * Read-only over traces; fail-soft by contract. Opt out: UAP_HALO_AUTOMINE=0.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { haloTracePath } from '../observability/halo-exporter.js';
import { mineFromHaloSpans, type HaloSpanLike } from '../self-harness/trace-mine.js';
import type { WeaknessReport } from '../self-harness/weakness.js';

/** Only mine the recent tail — old spans were already mined by earlier runs. */
const MAX_TRACE_LINES = 5000;
/** A pattern must recur to be a systemic weakness, not a one-off. */
const DEFAULT_MIN_FREQUENCY = 3;

export interface AutoMineResult {
  reports: WeaknessReport[];
  /** Where the full ranked report was written (null if nothing was mined). */
  reportPath: string | null;
}

export function isAutoMineEnabled(): boolean {
  const v = (process.env.UAP_HALO_AUTOMINE ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function weaknessReportPath(): string {
  return haloTracePath().replace(/[^/\\]+$/, 'weaknesses.json');
}

/**
 * Mine the HALO trace tail for recurring failure patterns and persist the
 * ranked report next to the trace file. Returns empty on any failure.
 */
export function autoMineHaloTraces(modelId: string, minFrequency = DEFAULT_MIN_FREQUENCY): AutoMineResult {
  const empty: AutoMineResult = { reports: [], reportPath: null };
  if (!isAutoMineEnabled()) return empty;
  try {
    const tracePath = haloTracePath();
    if (!existsSync(tracePath)) return empty;
    const lines = readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean).slice(-MAX_TRACE_LINES);
    const spans: HaloSpanLike[] = [];
    for (const line of lines) {
      try {
        spans.push(JSON.parse(line) as HaloSpanLike);
      } catch {
        // skip corrupt lines
      }
    }
    if (spans.length === 0) return empty;
    const reports = mineFromHaloSpans(spans, { model: modelId, minFrequency });
    if (reports.length === 0) return empty;

    const out = weaknessReportPath();
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ generatedAt: new Date().toISOString(), model: modelId, minedSpans: spans.length, reports }, null, 2),
      'utf-8'
    );
    renameSync(tmp, out);
    return { reports, reportPath: out };
  } catch {
    return empty;
  }
}

/** One-line operator summary of the top mined weaknesses. */
export function summarizeWeaknesses(reports: WeaknessReport[], top = 3): string | null {
  if (reports.length === 0) return null;
  const parts = reports.slice(0, top).map((r) => `${r.kind} ×${r.frequency}`);
  return `recurring failure patterns: ${parts.join(', ')} — details: uap harness analyze`;
}
