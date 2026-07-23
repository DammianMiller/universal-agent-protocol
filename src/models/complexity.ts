/**
 * Unified complexity classifier (S2).
 *
 * Before this module UAP had two disconnected notions of complexity:
 *  - router.ts        → low | medium | high | critical  (keyword-driven)
 *  - query-complexity → simple | moderate | complex      (heuristic scorer)
 * bridged one-way by deliver.ts's COMPLEXITY_TO_TIER, which silently DROPPED
 * `critical`. This module is the single source of truth: one 5-level `Tier`
 * (adds `trivial` as a floor) that composes the existing scorer and preserves
 * `critical` end-to-end. It is CHEAP-FIRST — a pure heuristic, no model call —
 * so classifying a task adds no overhead. `source` leaves room for a future
 * model-assisted tie-break in the ambiguous band without changing callers.
 */

import { measureQueryComplexity } from '../utils/query-complexity.js';

export type Tier = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

export interface ComplexitySignal {
  tier: Tier;
  /** 0..1 continuous — for thresholds/telemetry. */
  score: number;
  /** Why this tier — keyword hits, size, file count, risk flags. */
  reasons: string[];
  /** How it was decided; 'model' reserved for a future ambiguous-band tie-break. */
  source: 'heuristic' | 'model';
}

// Risk keywords force `critical` — the tier the old bridge could never emit.
const CRITICAL_KW =
  /\b(security|auth(?:entication|oriz\w*)?|credential|secret|token|encryption|payment|compliance|migration|schema|breaking\s+change)\b/i;

// Trivial keywords + short + single-file → the near-zero-overhead floor.
const TRIVIAL_KW =
  /\b(typo|rename|comment|whitespace|lint|formatting|format|bump\s+version|one[-\s]?liner|doc\s*typo)\b/i;

const SCORE: Record<Tier, number> = {
  trivial: 0.05,
  low: 0.25,
  medium: 0.55,
  high: 0.8,
  critical: 0.95,
};

/**
 * Classify task complexity into one 5-level tier. PURE, no model call.
 * Precedence: risk/critical > trivial-floor > 3-level scorer (low/medium/high),
 * with a file-count bump.
 */
export function classifyComplexity(input: {
  instruction: string;
  affectedFiles?: string[];
  riskFlags?: string[];
}): ComplexitySignal {
  const text = input.instruction ?? '';
  const files = input.affectedFiles?.length ?? 0;
  const reasons: string[] = [];

  if ((input.riskFlags && input.riskFlags.length > 0) || CRITICAL_KW.test(text)) {
    if (input.riskFlags && input.riskFlags.length > 0) reasons.push(`riskFlags=[${input.riskFlags.join(',')}]`);
    if (CRITICAL_KW.test(text)) reasons.push('critical keyword');
    return { tier: 'critical', score: SCORE.critical, reasons, source: 'heuristic' };
  }

  if (TRIVIAL_KW.test(text) && text.length < 200 && files <= 1) {
    reasons.push('trivial keyword, short, ≤1 file');
    return { tier: 'trivial', score: SCORE.trivial, reasons, source: 'heuristic' };
  }

  const q = measureQueryComplexity(text, { moderate: 1, complex: 2 });
  reasons.push(`query-complexity=${q}`);
  let tier: Tier = q === 'simple' ? 'low' : q === 'moderate' ? 'medium' : 'high';
  // Many files raises the floor a notch (capped at high; critical is keyword-only).
  if (files >= 5 && tier !== 'high') {
    tier = tier === 'low' ? 'medium' : 'high';
    reasons.push(`${files} files → bumped`);
  }
  return { tier, score: SCORE[tier], reasons, source: 'heuristic' };
}

/** Map the 5-level tier onto the 4-level routing scale (trivial folds to low). */
export function tierToRouting(tier: Tier): 'low' | 'medium' | 'high' | 'critical' {
  return tier === 'trivial' ? 'low' : tier;
}
