/**
 * The dashboard's Measured Pace rows (bridge P5: S1b) — the compute/render
 * split. Extracted from src/cli/dashboard.ts so the shaping contract (the
 * estimate gate, most-attempts-first ranking, the honest thin/beyond-cap
 * counts) is testable WITHOUT the cwd-pinned `getModelAnalytics()` singleton:
 * tests construct their own ModelAnalytics at a tmp path and pass it in.
 */

import { ewmaEstimate, formatDurationMs } from '../delivery/eta-estimate.js';
import { ModelAnalytics } from '../models/analytics.js';
import { termSafe } from '../utils/terminal-safe.js';

/** One row of the dashboard's Measured Pace table (plain display strings —
 *  the caller pads and colors). */
export interface PaceRow {
  modelId: string;
  key: string;
  perTask: string;
  spread: string;
  n: string;
  successPct: string;
}

/**
 * Compute the Measured Pace rows + honest caveats: the agent's own EWMA
 * estimate per (model, taskType, complexity) key — the operator's legibility
 * surface for "how long does this model actually take here". Only keys with
 * a real estimate get a row; the honest caveats (thin keys, keys beyond the
 * cap) travel as counts. Pure with respect to the instance.
 */
export async function computeMeasuredPace(
  analytics: ModelAnalytics,
  cap = 8,
): Promise<{ rows: PaceRow[]; thin: number; more: number }> {
  const allPaceKeys = analytics.distinctOutcomeKeys();
  const paceKeys = allPaceKeys.slice(0, cap);
  const rows: PaceRow[] = [];
  for (const k of paceKeys) {
    const est = ewmaEstimate(analytics.recentDurations(k.modelId, k.taskType, k.complexity));
    if (!est) continue;
    // Foreign strings (the id especially can arrive from env/config) are
    // termSafe'd at the compute choke point; the caller only pads/colors.
    rows.push({
      modelId: termSafe(k.modelId),
      key: termSafe(`${k.taskType}/${k.complexity}`),
      perTask: `~${formatDurationMs(est.etaMs)}`,
      spread: `${formatDurationMs(est.minMs)}–${formatDurationMs(est.maxMs)}`,
      n: `${est.samples}/${est.observed}`,
      successPct: (100 * est.successRate).toFixed(0) + '%',
    });
  }
  return {
    rows,
    thin: paceKeys.length - rows.length,
    more: Math.max(0, allPaceKeys.length - cap),
  };
}
