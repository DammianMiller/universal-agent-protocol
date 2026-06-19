/**
 * Per-component ablation.
 *
 * Builds a leave-one-out condition matrix (baseline, full, and full-minus-each-
 * component) and attributes the *marginal* contribution of each UAP component by
 * pairing `uap-full` against `no-<component>` cell-for-cell. This is the
 * scaffold-ablation method (HAL / SWE-Agent): turn off one mechanism at a time
 * and measure the delta in resolve-rate and cost, ranking components so we can
 * answer "is the whole protocol worth its overhead, or just two of six features?"
 */

import { mean, pairedDelta, PairedDeltaResult, PairedOptions } from './stats.js';
import { RunnerOutput } from './runner.js';
import {
  Condition,
  makeBaselineCondition,
  makeFullCondition,
  RunRecord,
  UAP_COMPONENTS,
  UapComponent,
} from './types.js';

export function ablationLabel(component: UapComponent): string {
  return `no-${component}`;
}

/** baseline + uap-full + one leave-one-out condition per component. */
export function buildAblationConditions(): Condition[] {
  const full = new Set(UAP_COMPONENTS);
  const leaveOneOut = UAP_COMPONENTS.map((drop) => ({
    label: ablationLabel(drop),
    components: new Set([...full].filter((c) => c !== drop)) as ReadonlySet<UapComponent>,
  }));
  return [makeBaselineCondition(), makeFullCondition(), ...leaveOneOut];
}

export interface ComponentContribution {
  component: UapComponent;
  /** success(full) - success(no-component), paired. Positive => component helps. */
  correctnessDelta: PairedDeltaResult;
  /** token(full) - token(no-component), paired. Positive => component costs tokens. */
  tokenDelta: PairedDeltaResult | null;
  fullSuccess: number;
  ablatedSuccess: number;
}

export interface AblationReport {
  fullLabel: string;
  contributions: ComponentContribution[];
}

function cellKey(r: RunRecord): string {
  return `${r.taskId}#${r.seed}`;
}

function cellMap(records: RunRecord[], condition: string): Map<string, RunRecord> {
  const m = new Map<string, RunRecord>();
  for (const r of records) if (r.condition === condition) m.set(cellKey(r), r);
  return m;
}

/**
 * Rank components by marginal contribution. Requires the run to have used the
 * ablation conditions (uap-full present plus the no-<component> arms).
 */
export function analyzeAblation(output: RunnerOutput, opts: PairedOptions = {}): AblationReport {
  const fullLabel = 'uap-full';
  const fullMap = cellMap(output.records, fullLabel);
  if (fullMap.size === 0) {
    throw new Error(`analyzeAblation: no '${fullLabel}' records present`);
  }

  const contributions: ComponentContribution[] = [];
  for (const component of UAP_COMPONENTS) {
    const ablMap = cellMap(output.records, ablationLabel(component));
    if (ablMap.size === 0) continue; // this component wasn't ablated in the run

    const correctnessDeltas: number[] = [];
    const tokenDeltas: number[] = [];
    const fullCorrect: number[] = [];
    const ablCorrect: number[] = [];
    for (const [k, full] of fullMap) {
      const abl = ablMap.get(k);
      if (!abl) continue;
      correctnessDeltas.push((full.metrics.correct ? 1 : 0) - (abl.metrics.correct ? 1 : 0));
      fullCorrect.push(full.metrics.correct ? 1 : 0);
      ablCorrect.push(abl.metrics.correct ? 1 : 0);
      if (full.metrics.tokens != null && abl.metrics.tokens != null) {
        tokenDeltas.push(full.metrics.tokens - abl.metrics.tokens);
      }
    }

    contributions.push({
      component,
      correctnessDelta: pairedDelta(correctnessDeltas, opts),
      tokenDelta: tokenDeltas.length ? pairedDelta(tokenDeltas, opts) : null,
      fullSuccess: fullCorrect.length ? mean(fullCorrect) : NaN,
      ablatedSuccess: ablCorrect.length ? mean(ablCorrect) : NaN,
    });
  }

  // Rank by correctness contribution descending (most valuable first).
  contributions.sort((a, b) => b.correctnessDelta.meanDelta - a.correctnessDelta.meanDelta);
  return { fullLabel, contributions };
}

export function renderAblationMarkdown(r: AblationReport): string {
  const L: string[] = [];
  L.push(`## Component ablation (marginal contribution vs \`${r.fullLabel}\`)`);
  L.push('');
  L.push(`| Component | Δ success (full − ablated) | 95% CI | p | Δ tokens | sig |`);
  L.push(`|---|--:|--:|--:|--:|:-:|`);
  for (const c of r.contributions) {
    const cd = c.correctnessDelta;
    const tok = c.tokenDelta ? c.tokenDelta.meanDelta.toFixed(0) : 'n/a';
    L.push(
      `| \`${c.component}\` | ${(cd.meanDelta * 100).toFixed(1)}pp | ` +
        `[${(cd.ci.lower * 100).toFixed(1)}, ${(cd.ci.upper * 100).toFixed(1)}]pp | ` +
        `${cd.pValue.toFixed(3)} | ${tok} | ${cd.significant ? '✅' : '–'} |`
    );
  }
  L.push('');
  L.push(
    `> A component earns its keep when its Δ success CI is above 0. Components with ` +
      `CI spanning 0 but positive Δ tokens are pure overhead — candidates to drop.`
  );
  L.push('');
  return L.join('\n');
}
