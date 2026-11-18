/**
 * Deliver tier gate (quality-tier uplift 0.5) — the first-class gate that
 * measures the delivered artifact's captures against the project's derived
 * quality tiers (0.1 extractor + 0.2 compiler) and refuses DONE below tier.
 *
 * Shadow-first doctrine (the system-1 promotion rule): the gate ships
 * ASSESSING, not blocking. Promotion to blocking happens only after a
 * measured false-positive budget, and is an explicit operator act
 * (UAP_TIER_GATE=block). Escape hatch: UAP_TIER_GATE=off. Default: shadow.
 *
 * v1 wiring (documented limitation): the gate rides the acceptance turn,
 * where the visual gate's screenshots already exist — it observes judged
 * deliveries; ladder-only runs are not yet observed (promotion work).
 */

import { extractTierVector } from './tier.js';
import { compileGap, GapReport, loadTiers } from './tiers.js';

export type TierGateMode = 'off' | 'shadow' | 'block';

/** UAP_TIER_GATE: off | shadow | block. Anything else (or unset) → shadow. */
export function resolveTierGateMode(env: NodeJS.ProcessEnv): TierGateMode {
  const v = env.UAP_TIER_GATE;
  return v === 'off' || v === 'block' ? v : 'shadow';
}

export interface TierGateTierResult {
  tier: string;
  pass: boolean;
  failing: number;
  axes: number;
  worst: string | null;
  capture: string;
}

export interface TierGateResult {
  mode: TierGateMode;
  /** Set (with the reason) when the gate did not assess anything. */
  skipped?: string;
  /** One entry per (tier, capture) pair measured. Empty when skipped. */
  reports: TierGateTierResult[];
  /** Aggregate verdict — false only in block mode below tier. */
  pass: boolean;
  /** Worst-first gap directives; present only when blocking. */
  feedback?: string;
}

/** One-line human summary for logs (shadow observation + block refusals). */
export function formatTierGateLine(r: TierGateResult): string {
  if (r.skipped) return `tier gate: skipped (${r.skipped})`;
  const worst = r.reports.find((x) => !x.pass);
  if (!worst) return `tier gate: ✓ ${r.reports.length} measurement(s) at tier`;
  return `tier gate: ✗ below tier ${worst.tier} — ${worst.failing}/${worst.axes} axes failing (worst: ${worst.worst})`;
}

/**
 * Measure the captures against every derived tier the project carries.
 * PURE except for disk reads (the extractor + tier store are the 0.1/0.2
 * modules; both fail closed/soft on bad input).
 */
export function runTierGate(opts: {
  projectRoot: string;
  /** PNG captures (the visual gate's screenshots). */
  captures: string[];
  mode: TierGateMode;
  load?: typeof loadTiers;
}): TierGateResult {
  if (opts.mode === 'off') return { mode: 'off', skipped: 'gate off (UAP_TIER_GATE=off)', reports: [], pass: true };
  const store = (opts.load ?? loadTiers)(opts.projectRoot);
  const tierKeys = Object.keys(store.tiers);
  if (tierKeys.length === 0) return { mode: opts.mode, skipped: 'no derived tiers', reports: [], pass: true };
  if (opts.captures.length === 0) return { mode: opts.mode, skipped: 'no captures', reports: [], pass: true };

  const reports: TierGateTierResult[] = [];
  const gaps: Array<{ tier: string; report: GapReport }> = [];
  for (const key of tierKeys) {
    const tier = store.tiers[key];
    for (const capture of opts.captures) {
      const vector = extractTierVector(capture);
      if (!vector) continue; // undecodable capture — `uap quality gap` names it; here we measure what decodes
      const report = compileGap(vector, tier, capture);
      reports.push({
        tier: key,
        pass: report.pass,
        failing: report.failing,
        axes: report.axes.length,
        worst: report.worst,
        capture,
      });
      if (!report.pass) gaps.push({ tier: key, report });
    }
  }
  if (reports.length === 0) return { mode: opts.mode, skipped: 'no decodable captures', reports: [], pass: true };

  if (opts.mode === 'shadow') {
    // Assess, do not block. The measurement is reported; DONE is unaffected.
    return { mode: 'shadow', reports, pass: true };
  }
  if (gaps.length === 0) return { mode: 'block', reports, pass: true };
  // BLOCK mode: refuse DONE with the gap report attached (worst tier first).
  const ordered = [...gaps].sort((a, b) => b.report.failing - a.report.failing);
  const worst = ordered[0];
  const lines = [
    `TIER GATE — below tier ${worst.tier}: ${worst.report.failing} of ${worst.report.axes.length} axes failing (worst: ${worst.report.worst}).`,
    'The artifact is refused DONE below the digitized quality bar. Fix the axes in severity order — one pass per axis:',
    ...worst.report.axes
      .filter((a) => a.status === 'fail')
      .slice(0, 5)
      .map((a) => `  ${a.axis}: ${a.value} (tier ${a.threshold.min !== undefined && a.threshold.max !== undefined ? `[${a.threshold.min}, ${a.threshold.max}]` : a.threshold.min !== undefined ? `>= ${a.threshold.min}` : `<= ${a.threshold.max}`}) → ${a.directive}`),
  ];
  return { mode: 'block', reports, pass: false, feedback: lines.join('\n') };
}
