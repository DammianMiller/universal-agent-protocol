/**
 * DeliveryResult utilities shared by every mission runner. Lives in its own
 * leaf so runners never import each other just for a generic fold
 * (epic-mission → orchestrated-mission was exactly that wart).
 */

import type { DeliveryResult } from './convergence-loop.js';

/** Fold one loop/mission result into a running aggregate (turns, history,
 * best score, latest feedback/output). `success` is deliberately NOT folded —
 * what "success" means across parts is the caller's policy. */
export function foldDeliveryResult(target: DeliveryResult, source: DeliveryResult): void {
  target.turns += source.turns;
  target.history.push(...source.history);
  target.totalDurationMs += source.totalDurationMs;
  if (source.bestScore > target.bestScore) {
    target.bestScore = source.bestScore;
    target.bestTurn = source.bestTurn;
  }
  target.finalFeedback = source.finalFeedback;
  target.finalOutput = source.finalOutput;
  // Baseline gate outcomes survive folding so the evidence seam still sees
  // them after an orchestrated/phased run short-circuits as alreadyDelivered.
  if (source.baselineGates && !target.baselineGates) {
    target.baselineGates = source.baselineGates;
  }
}
