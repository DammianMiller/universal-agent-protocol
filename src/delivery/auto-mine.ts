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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
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
    if (reports.length === 0) {
      // The failure pattern stopped recurring — retire the persisted report
      // so future runs stop being told about weaknesses that no longer exist.
      try {
        rmSync(weaknessReportPath(), { force: true });
      } catch {
        // best-effort
      }
      return empty;
    }

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

/**
 * Weakness → prompt feedback: translate recurring mined failure kinds into
 * imperative guidance the loop injects alongside practice cards, so what the
 * harness OBSERVED failing changes what the model is TOLD next run. Guidance
 * text is harness-authored (keyed by FailureKind), never model output — same
 * provenance rule as the practice store.
 */
const KIND_GUIDANCE: Record<string, string> = {
  'verify.fail':
    'Recent runs on this setup repeatedly produced output that FAILED the completion gates. Re-read the gate feedback line by line and satisfy every failing gate before ending a turn.',
  'toolcall.path.garbled':
    'Recent runs repeatedly used wrong or garbled file paths. Use exact relative paths from the project root, copied verbatim — never abbreviate or re-case a path.',
  'agent.timeout':
    'Recent runs repeatedly hit wall-clock timeouts. Prefer smaller, complete, verifiable increments per turn over one oversized attempt.',
  'agent.error':
    'Recent runs crashed mid-attempt. Keep every file block complete and well-formed; do not truncate output.',
  'loop.nonterminate':
    'Recent runs looped without terminating. Converge: finish the change and emit final file blocks instead of continuing to explore.',
  'gen.runaway.npredict':
    'Recent runs hit the generation-length cap. Be concise — emit only the files that change, with no commentary dumps.',
  'guardrail.poison.recon':
    'Recent runs got stuck in read-only reconnaissance. Start writing implementation files early; reading more is not progress.',
  'toolcall.args.truncated':
    'Recent runs emitted truncated tool arguments. Keep individual outputs small enough to complete; split large files across turns if needed.',
};

/** Convert mined weakness reports into injectable guidance lines (top N kinds). */
export function weaknessGuidance(reports: WeaknessReport[], top = 2): string[] {
  const lines: string[] = [];
  for (const r of reports.slice(0, top)) {
    const g = KIND_GUIDANCE[r.kind];
    if (g) lines.push(g);
  }
  return lines;
}

/**
 * Load the persisted weakness report written by a previous run's auto-mine.
 * Fail-soft: any problem (missing, corrupt, stale schema) yields [].
 */
/** Guidance older than this is stale — the codebase and harness moved on. */
const WEAKNESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function loadPersistedWeaknesses(): WeaknessReport[] {
  try {
    const path = weaknessReportPath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { reports?: unknown; generatedAt?: unknown };
    const generated = typeof parsed.generatedAt === 'string' ? Date.parse(parsed.generatedAt) : NaN;
    if (!Number.isFinite(generated) || Date.now() - generated > WEAKNESS_TTL_MS) return [];
    if (!Array.isArray(parsed.reports)) return [];
    return parsed.reports.filter(
      (r): r is WeaknessReport =>
        typeof r === 'object' && r !== null && typeof (r as WeaknessReport).kind === 'string'
    );
  } catch {
    return [];
  }
}

/** One-line operator summary of the top mined weaknesses. */
export function summarizeWeaknesses(reports: WeaknessReport[], top = 3): string | null {
  if (reports.length === 0) return null;
  const parts = reports.slice(0, top).map((r) => `${r.kind} ×${r.frequency}`);
  return `recurring failure patterns: ${parts.join(', ')} — details: uap harness analyze`;
}
