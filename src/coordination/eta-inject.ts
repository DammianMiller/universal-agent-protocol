/**
 * Measured-pace reactor injection (bridge P5: S1b "ETA surfaces") — give the
 * agent its OWN measured history as calibrated context: "your tasks on this
 * model take ~X and succeed ~Y% of the time" is the one planning number a
 * local model never has and routinely guesses wildly.
 *
 * Fires ONLY when the store holds a solid estimate (>= 6 successful attempts
 * for the active model's key) — the block's value IS its calibration, and a
 * thin-data guess would inject exactly the confident noise it exists to
 * replace. Deduped per session by the reactor via the `eta:pace` surfaced key;
 * fail-soft like every injection.
 */

import { resolveActiveModel } from '../delivery/handsfree-config.js';
import { estimatePace, formatDurationMs } from '../delivery/eta-estimate.js';
import { termSafeBounded } from '../utils/terminal-safe.js';

/**
 * Return the measured-pace block for injection, or null when there is no
 * solid estimate for the active model (or the store is unreadable). The
 * optional `dbPath` is the tests' seam; the reactor always reads the project
 * store.
 *
 * `requireExisting`: this runs on EVERY reactor resolve — opening a missing
 * store would materialize an empty analytics DB per fresh checkout, and a
 * read surface must not create the thing it reads. No store on disk ⇒ no
 * block, no side effect.
 */
export function maybeEtaInjection(cwd: string, dbPath?: string): string | null {
  try {
    const modelId = resolveActiveModel(cwd);
    const est = estimatePace({ modelId, dbPath, requireExisting: true });
    if (!est || est.confidence !== 'solid') return null;
    // The model id comes from env/config the repo can control; the block
    // presents itself as MEASURED data, so the display string is sanitized
    // and bounded — the raw id still keys the store query above.
    const shown = termSafeBounded(modelId, 80);
    const lines = [
      `## Measured pace (this project's own history)`,
      '',
      `Tasks on **${shown}** here average ~${formatDurationMs(est.etaMs)} and ` +
        `~${est.etaTurns.toFixed(1)} turns per successful attempt (EWMA over ` +
        `${est.samples}/${est.observed} attempts, spread ${formatDurationMs(est.minMs)}–${formatDurationMs(est.maxMs)}).`,
    ];
    if (est.successRate < 1) {
      lines.push(
        `About ${(100 * (1 - est.successRate)).toFixed(0)}% of attempts fail; plan for ` +
          `~${est.attemptsPerSuccess.toFixed(1)} attempts per completed task.`
      );
    }
    lines.push('Budget and sequence work from these numbers, not from a guess.');
    return lines.join('\n');
  } catch {
    return null;
  }
}
