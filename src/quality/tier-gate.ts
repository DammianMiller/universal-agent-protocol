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

import { classOfTierKey, resolveClass } from './classes.js';
import { compileGap, GapReport, resolveTiers } from './tiers.js';

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
  /** Aggregate verdict — false only in block mode below tier, or on max-fidelity prior escalation. */
  pass: boolean;
  /**
   * Max-fidelity prior escalation (U-I): true when the gate ran in shadow
   * mode but a BUILT-IN class prior failed under max fidelity — the
   * reference-free frontier floor refuses DONE without the operator having
   * set UAP_TIER_GATE=block. Anchor-derived tiers never escalate (their
   * promotion stays an explicit operator act).
   */
  escalated?: boolean;
  /** Worst-first gap directives; present only when blocking. */
  feedback?: string;
}

/** One-line human summary for logs (shadow observation + block refusals). */
export function formatTierGateLine(r: TierGateResult): string {
  if (r.skipped) return `tier gate: skipped (${r.skipped})`;
  const worst = r.reports.find((x) => !x.pass);
  if (!worst) return `tier gate: ✓ ${r.reports.length} measurement(s) at tier`;
  const label = r.escalated ? 'tier gate (max-fidelity prior escalation)' : 'tier gate';
  return `${label}: ✗ below tier ${worst.tier} — ${worst.failing}/${worst.axes} axes failing (worst: ${worst.worst})`;
}

/** The threshold range in human form (>= min / <= max / between). */
function thresholdText(t: { min?: number; max?: number }): string {
  return t.min !== undefined && t.max !== undefined
    ? `[${t.min}, ${t.max}]`
    : t.min !== undefined
      ? `>= ${t.min}`
      : `<= ${t.max}`;
}

/** The worst-first fix directives for a failing gap report (max 5 axes). */
function gapFeedbackLines(report: GapReport, headline: string, doctrine: string): string[] {
  return [
    headline,
    doctrine,
    ...report.axes
      .filter((a) => a.status === 'fail')
      .slice(0, 5)
      .map((a) => `  ${a.axis}: ${a.value} (tier ${thresholdText(a.threshold)}) → ${a.directive}`),
  ];
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
  /**
   * Max-fidelity prior escalation (U-I): when true, a BUILT-IN class prior
   * failing in shadow mode refuses DONE (result.escalated). Anchor-derived
   * tiers keep pure shadow semantics at every fidelity.
   */
  maxFidelity?: boolean;
  load?: typeof resolveTiers;
}): TierGateResult {
  if (opts.mode === 'off') return { mode: 'off', skipped: 'gate off (UAP_TIER_GATE=off)', reports: [], pass: true };
  // resolveTiers: project tiers over the fleet-global store (auto-apply) —
  // a published global tier reaches projects that never derived one.
  const store = (opts.load ?? resolveTiers)(opts.projectRoot);
  const tierKeys = Object.keys(store.tiers);
  if (tierKeys.length === 0) return { mode: opts.mode, skipped: 'no derived tiers', reports: [], pass: true };
  if (opts.captures.length === 0) return { mode: opts.mode, skipped: 'no captures', reports: [], pass: true };

  const reports: TierGateTierResult[] = [];
  const gaps: Array<{ tier: string; report: GapReport }> = [];
  for (const key of tierKeys) {
    const tier = store.tiers[key];
    // The tier's class selects its extractor (Wave 1.1): a visual-scene tier
    // reads PNG captures, an api-behavior tier reads API transcripts. A
    // capture of the wrong shape does not decode and is skipped below — the
    // gate never cross-reads an artifact into another class's axes.
    const extract = resolveClass(classOfTierKey(key)).extract;
    for (const capture of opts.captures) {
      const vector = extract(capture);
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
    // Assess, do not block — with one escalation path (U-I): a BUILT-IN class
    // prior is the reference-free frontier floor, and under max fidelity its
    // failure refuses DONE even without UAP_TIER_GATE=block. Anchor-derived
    // tiers keep pure shadow semantics at every fidelity (their promotion to
    // blocking stays an explicit operator act).
    const priorGaps = opts.maxFidelity
      ? gaps.filter((g) => store.tiers[g.tier]?.builtin === true)
      : [];
    if (priorGaps.length === 0) return { mode: 'shadow', reports, pass: true };
    const worstPrior = [...priorGaps].sort((a, b) => b.report.failing - a.report.failing)[0];
    const lines = gapFeedbackLines(
      worstPrior.report,
      `TIER GATE (max-fidelity escalation) — below the built-in frontier prior ${worstPrior.tier}: ${worstPrior.report.failing} of ${worstPrior.report.axes.length} axes failing (worst: ${worstPrior.report.worst}).`,
      'The artifact is refused DONE below the reference-free frontier envelope (harvested class prior; UAP_TIER_PRIORS=off disables priors, UAP_TIER_GATE=off silences the gate). Fix the axes in severity order — one pass per axis:'
    );
    return { mode: 'shadow', reports, pass: false, escalated: true, feedback: lines.join('\n') };
  }
  if (gaps.length === 0) return { mode: 'block', reports, pass: true };
  // BLOCK mode: refuse DONE with the gap report attached (worst tier first).
  const ordered = [...gaps].sort((a, b) => b.report.failing - a.report.failing);
  const worst = ordered[0];
  const lines = gapFeedbackLines(
    worst.report,
    `TIER GATE — below tier ${worst.tier}: ${worst.report.failing} of ${worst.report.axes.length} axes failing (worst: ${worst.report.worst}).`,
    'The artifact is refused DONE below the digitized quality bar. Fix the axes in severity order — one pass per axis:'
  );
  return { mode: 'block', reports, pass: false, feedback: lines.join('\n') };
}
