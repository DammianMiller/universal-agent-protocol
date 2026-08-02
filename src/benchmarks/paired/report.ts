/**
 * Analysis + reporting.
 *
 * Turns raw paired RunRecords into the credible result shape the research
 * prescribes: NOT a single headline number, but a vector of paired deltas with
 * confidence intervals (accuracy AND efficiency), a McNemar 2x2 for gate value,
 * and a cost-accuracy Pareto view. Treatment arms are always compared against
 * the baseline cell-for-cell (same task + seed).
 */

import {
  CI,
  mcnemar,
  McNemarResult,
  mean,
  pairedDelta,
  PairedDeltaResult,
  PairedOptions,
  verdict,
  Verdict,
} from './stats.js';
import { RunnerOutput } from './runner.js';
import { CONTINUOUS_METRICS, ContinuousMetric, MetricVector, RunRecord } from './types.js';
import {
  buildHarnessCard,
  renderHarnessCard,
  type HarnessCard,
  type HarnessCardInput,
} from '../harness-card.js';

export interface ConditionSummary {
  label: string;
  n: number;
  successRate: number;
  meanTokens: number | null;
  meanTurns: number | null;
  meanCostUsd: number | null;
  meanLatencyMs: number;
  errorRate: number;
  /** Mean composite quality (0-100) over runs that carried a quality score, or null. */
  meanQuality: number | null;
}

export interface Comparison {
  label: string;
  baseline: string;
  /** Paired correctness: rates, bootstrap CI on the delta, permutation p. */
  correctness: {
    baselineRate: number;
    treatmentRate: number;
    delta: PairedDeltaResult;
    mcnemar: McNemarResult;
    /** win/tie/loss under the ROPE norm (ties within noise are not wins). */
    verdict: Verdict;
  };
  /** Paired deltas for each continuous metric where both arms reported a value. */
  metrics: Partial<Record<ContinuousMetric, PairedDeltaResult>>;
  /** Per-metric win/tie/loss (lower-is-better for tokens/cost/turns/latency). */
  metricVerdicts: Partial<Record<ContinuousMetric, Verdict>>;
  /**
   * Paired composite-quality delta (treatment - baseline over cells where BOTH
   * arms carried a quality score), higher-is-better. Present only when quality
   * scores exist. This is the LLM-Self-Tuning signal the tuner optimizes.
   */
  quality?: PairedDeltaResult;
  /** Win/tie/loss on composite quality (higher-is-better). */
  qualityVerdict?: Verdict;
}

export interface AnalysisReport {
  meta: {
    model: string;
    adapter: string;
    epochs: number;
    taskCount: number;
    conditions: string[];
    baseline: string;
    startedAt: string;
    finishedAt: string;
  };
  perCondition: ConditionSummary[];
  comparisons: Comparison[];
  /** Cost-accuracy Pareto points (one per condition). */
  pareto: { label: string; successRate: number; meanTokens: number | null }[];
  /**
   * Whether this run could have detected a difference at all (see
   * `assessDiscrimination`). A suite where every arm scores 100% — or 0% —
   * yields `delta=+0.000, significant=false`, which reads like "no effect" but
   * actually means "no measurement".
   */
  discrimination: DiscriminationVerdict;
  /**
   * ETCSOVG disclosure card for the harness these numbers were produced by
   * (harness plan F). Harness variance dominates model variance 7.8x
   * (arXiv 2605.23950), so a score reported without it is not comparable to any
   * other score. Absent only when the caller supplied no harness description —
   * the card is never invented.
   */
  harnessCard?: HarnessCard;
}

/**
 * Can this run tell the arms apart at all?
 *
 * A paired benchmark reports `delta=+0.000, significant=false` in two very
 * different situations: the arms genuinely perform the same, or the SUITE
 * cannot separate them because every arm sits at the ceiling (or the floor).
 * The numbers are identical; the conclusions are opposite. Reporting only the
 * delta invites reading "no measurement" as "no effect" — three consecutive
 * runs against `real-gate` (100%/100%) and `smoke` (0%/0%, wrong adapter) were
 * each read as a null result before anyone noticed nothing had been measured.
 *
 * So the verdict is computed and printed alongside the delta, always.
 */
export type DiscriminationStatus =
  | 'ok'
  /** Every arm solved (nearly) everything — the suite cannot separate them. */
  | 'ceiling'
  /** Nothing was solved — suite too hard, or adapter/harness misconfigured. */
  | 'floor'
  /**
   * Arms differed nowhere on CORRECTNESS: zero discordant pairs. This is the
   * criterion McNemar tests on, and it is the honest name for the failure — a
   * bootstrap over an all-zero delta vector returns CI [0.000, 0.000], which
   * reads as "conclusively no effect" when it means "no information".
   */
  | 'no-discordant-pairs'
  /** The interval spans both zero and the effect worth having. */
  | 'underpowered'
  /** Nothing to compare — a report with no treatment arm. */
  | 'no-comparisons';

export interface DiscriminationVerdict {
  status: DiscriminationStatus;
  /**
   * True when a CORRECTNESS difference could have shown up. Efficiency results
   * are judged separately — see `efficiencyUsable`.
   */
  usable: boolean;
  /**
   * True when at least one continuous metric (tokens/turns/cost/latency) or the
   * quality score carries a non-degenerate interval.
   *
   * This exists because "same accuracy, 40% fewer tokens" is a real, citable
   * result — and the first cut of this check refused it, printing "not evidence
   * of anything" directly above a token table reading 🟢 WIN. A saturated suite
   * measures correctness badly and efficiency perfectly well.
   */
  efficiencyUsable: boolean;
  reason: string;
  minSuccess: number;
  maxSuccess: number;
  /** Paired cells in the PRIMARY comparison. */
  pairedCells: number;
  /** Discordant correctness pairs in the PRIMARY comparison (McNemar b+c). */
  discordantPairs: number;
}

export interface DiscriminationOptions {
  /** Every arm at or above this is a ceiling. Default 0.98. */
  ceilingAt?: number;
  /** Every arm at or below this is a floor. Default 0.02. */
  floorAt?: number;
  /** Fewer paired cells than this cannot support a verdict. Default 8. */
  minPairedCells?: number;
  /**
   * Smallest correctness delta worth detecting, in success-rate units. A run is
   * inconclusive when its interval contains BOTH zero and this effect.
   * Default 0.25.
   */
  minDetectableEffect?: number;
}

function finite(n: number | undefined | null): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Does any continuous metric or quality score carry a real difference?
 *
 * Keyed on a NON-ZERO paired mean, not on interval width. Zero width means
 * opposite things for the two kinds of measure: an all-zero correctness delta is
 * no information, while a constant -1200-token delta across every cell is the
 * strongest efficiency result there is — perfectly consistent, zero variance.
 * Testing width alone refused exactly that.
 */
function hasEfficiencySignal(c: Comparison | undefined): boolean {
  if (!c) return false;
  const carries = (pd: { n: number; meanDelta: number } | undefined): boolean =>
    Boolean(pd && pd.n > 0 && finite(pd.meanDelta) && pd.meanDelta !== 0);
  for (const m of CONTINUOUS_METRICS) {
    if (carries(c.metrics[m])) return true;
  }
  return carries(c.quality);
}

/**
 * Can this run tell the arms apart?
 *
 * Judged against the PRIMARY comparison (the first treatment arm), not folded
 * across every arm: an `--ablation` run has 6 comparisons, and summing their
 * discordance let one noisy leave-one-out arm mask a null primary, while taking
 * the widest CI let it refuse a tight primary.
 */
export function assessDiscrimination(
  perCondition: ConditionSummary[],
  comparisons: Comparison[],
  opts: DiscriminationOptions = {},
): DiscriminationVerdict {
  const ceilingAt = opts.ceilingAt ?? 0.98;
  const floorAt = opts.floorAt ?? 0.02;
  const minCells = opts.minPairedCells ?? 8;
  const mde = opts.minDetectableEffect ?? 0.25;

  const rates = perCondition.map((c) => c.successRate).filter(finite);
  const minSuccess = rates.length ? Math.min(...rates) : 0;
  const maxSuccess = rates.length ? Math.max(...rates) : 0;

  const primary = comparisons[0];
  const efficiencyUsable = hasEfficiencySignal(primary);
  const d = primary?.correctness.delta;
  const pairedCells = finite(d?.n) ? (d as { n: number }).n : 0;
  const discordantPairs = primary
    ? primary.correctness.mcnemar.onlyTreatment + primary.correctness.mcnemar.onlyBaseline
    : 0;
  const base = { minSuccess, maxSuccess, pairedCells, discordantPairs, efficiencyUsable };
  const alsoEfficiency = efficiencyUsable
    ? ' Efficiency deltas (tokens/turns/latency) below ARE valid and may be cited.'
    : '';

  if (!primary) {
    return {
      status: 'no-comparisons',
      usable: false,
      reason: 'no treatment arm to compare against the baseline — nothing was measured.',
      ...base,
    };
  }
  if (rates.length > 0 && minSuccess >= ceilingAt) {
    return {
      status: 'ceiling',
      usable: false,
      reason:
        `every condition solved ${(minSuccess * 100).toFixed(0)}%+ of cells — the suite cannot separate ` +
        `them on correctness. Either it is too easy, or the verify command always passes (a mock adapter ` +
        `against a mock suite looks identical). A zero correctness delta here means NO MEASUREMENT.` +
        alsoEfficiency,
      ...base,
    };
  }
  if (rates.length > 0 && maxSuccess <= floorAt) {
    return {
      status: 'floor',
      usable: false,
      reason:
        `no condition solved anything (max ${(maxSuccess * 100).toFixed(0)}%) — the suite is too hard, ` +
        `or the adapter/suite are mismatched (a mock-only suite scores 0% against every real model, ` +
        `which looks identical to "too hard"). A zero delta here means NO MEASUREMENT.` + alsoEfficiency,
      ...base,
    };
  }
  if (discordantPairs === 0) {
    return {
      status: 'no-discordant-pairs',
      usable: false,
      reason:
        `the arms produced identical correctness on all ${pairedCells} paired cells (0 discordant), so ` +
        `the run carries no information about a correctness difference — the CI collapses to [0, 0], ` +
        `which LOOKS conclusive and is not.` + alsoEfficiency,
      ...base,
    };
  }
  if (pairedCells > 0 && pairedCells < minCells) {
    return {
      status: 'underpowered',
      usable: false,
      reason:
        `only ${pairedCells} paired cells — too few to distinguish a real effect from noise. ` +
        `Raise --epochs or add tasks before reading the delta.` + alsoEfficiency,
      ...base,
    };
  }
  // Inconclusive = the interval admits both "no effect" and an effect worth
  // having. Half-width alone got this wrong in both directions: it passed
  // [-0.24, +0.24] (cannot tell a 24pp regression from a 24pp win) and refused
  // [0.02, 0.55] (a proven win with a long tail).
  const ci = d?.ci;
  const significant = Boolean(d?.significant);
  if (!significant && ci && finite(ci.lower) && finite(ci.upper) && ci.lower < mde && ci.upper > -mde) {
    return {
      status: 'underpowered',
      usable: false,
      reason:
        `the correctness CI [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}] contains both zero and the ` +
        `±${mde} effect worth detecting — this run could not have told a real difference from none. ` +
        `Raise --epochs or add tasks.` + alsoEfficiency,
      ...base,
    };
  }
  return {
    status: 'ok',
    usable: true,
    reason:
      `conditions span ${(minSuccess * 100).toFixed(0)}%-${(maxSuccess * 100).toFixed(0)}% over ` +
      `${pairedCells} paired cells with ${discordantPairs} discordant — a difference could show up here.`,
    ...base,
  };
}

function cellKey(r: RunRecord): string {
  return `${r.taskId}#${r.seed}`;
}

function byCondition(records: RunRecord[]): Map<string, RunRecord[]> {
  const m = new Map<string, RunRecord[]>();
  for (const r of records) {
    const arr = m.get(r.condition) ?? [];
    arr.push(r);
    m.set(r.condition, arr);
  }
  return m;
}

function summarize(label: string, recs: RunRecord[]): ConditionSummary {
  const correct = recs.map((r) => (r.metrics.correct ? 1 : 0));
  const numeric = (sel: (m: MetricVector) => number | null): number | null => {
    const vals = recs.map((r) => sel(r.metrics)).filter((v): v is number => v != null);
    return vals.length ? mean(vals) : null;
  };
  const quals = recs.map((r) => r.qualityScore?.composite).filter((v): v is number => v != null);
  return {
    label,
    n: recs.length,
    successRate: recs.length ? mean(correct) : NaN,
    meanTokens: numeric((m) => m.tokens),
    meanTurns: numeric((m) => m.turns),
    meanCostUsd: numeric((m) => m.costUsd),
    meanLatencyMs: numeric((m) => m.latencyMs) ?? NaN,
    errorRate: recs.length ? mean(recs.map((r) => (r.metrics.error ? 1 : 0))) : NaN,
    meanQuality: quals.length ? mean(quals) : null,
  };
}

/** Build the paired delta arrays between a treatment and baseline cell map. */
function pairCells(
  baseline: Map<string, RunRecord>,
  treatment: Map<string, RunRecord>
): { keys: string[]; base: RunRecord[]; treat: RunRecord[] } {
  const keys: string[] = [];
  const base: RunRecord[] = [];
  const treat: RunRecord[] = [];
  for (const [k, b] of baseline) {
    const t = treatment.get(k);
    if (t) {
      keys.push(k);
      base.push(b);
      treat.push(t);
    }
  }
  return { keys, base, treat };
}

function toCellMap(recs: RunRecord[]): Map<string, RunRecord> {
  const m = new Map<string, RunRecord>();
  for (const r of recs) m.set(cellKey(r), r);
  return m;
}

export interface AnalyzeOptions extends PairedOptions {
  baselineLabel?: string;
  /** ROPE half-width for correctness (success-rate units, 0..1). A success-rate
   *  delta within ±ropeMargin is a tie even if statistically significant.
   *  Default 0 (pure statistical). e.g. 0.02 = "within 2pp is a tie". */
  ropeMargin?: number;
  /** Per-metric ROPE half-widths (same units as the metric). The open-challenge
   *  "deltas <4 TPS are ties" norm is a per-metric margin. */
  metricMargins?: Partial<Record<ContinuousMetric, number>>;
  /** ROPE half-width (composite-quality points, 0..100) below which a quality
   *  delta is a tie even if statistically significant. Default 0. */
  qualityMargin?: number;
  /**
   * Harness configuration in force for this run. Supplied -> the report carries
   * an ETCSOVG disclosure card (harness plan F). Omitted -> no card, rather than
   * a guessed one.
   */
  harness?: HarnessCardInput;
  /** Thresholds for the ceiling/floor/underpowered verdict. */
  discrimination?: DiscriminationOptions;
}

export function analyze(output: RunnerOutput, opts: AnalyzeOptions = {}): AnalysisReport {
  const baselineLabel = opts.baselineLabel ?? 'baseline';
  const grouped = byCondition(output.records);

  const conditions = [...grouped.keys()];
  if (!grouped.has(baselineLabel)) {
    throw new Error(
      `analyze: baseline condition '${baselineLabel}' not present (have: ${conditions.join(', ')})`
    );
  }

  const perCondition = conditions.map((label) => summarize(label, grouped.get(label)!));

  const baseMap = toCellMap(grouped.get(baselineLabel)!);
  const taskCount = new Set(output.records.map((r) => r.taskId)).size;

  const comparisons: Comparison[] = [];
  for (const label of conditions) {
    if (label === baselineLabel) continue;
    const treatMap = toCellMap(grouped.get(label)!);
    const { base, treat } = pairCells(baseMap, treatMap);

    // Correctness: paired binary deltas (+1 fixed, -1 regressed, 0 same).
    const correctnessDeltas = base.map((b, i) => num(treat[i].metrics.correct) - num(b.metrics.correct));
    const delta = pairedDelta(correctnessDeltas, opts);
    const mc = mcnemar(
      treat.map((t) => t.metrics.correct),
      base.map((b) => b.metrics.correct)
    );

    // Continuous metrics: paired deltas where BOTH arms reported the value.
    const metrics: Partial<Record<ContinuousMetric, PairedDeltaResult>> = {};
    for (const metric of CONTINUOUS_METRICS) {
      const deltas: number[] = [];
      for (let i = 0; i < base.length; i++) {
        const bv = base[i].metrics[metric];
        const tv = treat[i].metrics[metric];
        if (bv != null && tv != null) deltas.push(tv - bv);
      }
      if (deltas.length > 0) metrics[metric] = pairedDelta(deltas, opts);
    }

    // Composite-quality paired delta (higher-is-better), over cells where BOTH
    // arms carried a quality score. This is the LLM-Self-Tuning quality signal.
    const qualityDeltas: number[] = [];
    for (let i = 0; i < base.length; i++) {
      const bq = base[i].qualityScore?.composite;
      const tq = treat[i].qualityScore?.composite;
      if (bq != null && tq != null) qualityDeltas.push(tq - bq);
    }
    const quality = qualityDeltas.length > 0 ? pairedDelta(qualityDeltas, opts) : undefined;
    const qualityVerdict = quality
      ? verdict(quality, { margin: opts.qualityMargin ?? 0, higherIsBetter: true })
      : undefined;

    // Win/tie/loss under the ROPE norm: correctness is higher-is-better; the
    // continuous metrics (tokens/cost/turns/latency) are lower-is-better.
    const correctnessVerdict = verdict(delta, { margin: opts.ropeMargin ?? 0, higherIsBetter: true });
    const metricVerdicts: Partial<Record<ContinuousMetric, Verdict>> = {};
    for (const metric of CONTINUOUS_METRICS) {
      const pd = metrics[metric];
      if (pd) {
        metricVerdicts[metric] = verdict(pd, {
          margin: opts.metricMargins?.[metric] ?? 0,
          higherIsBetter: false,
        });
      }
    }

    comparisons.push({
      label,
      baseline: baselineLabel,
      correctness: {
        baselineRate: mean(base.map((b) => num(b.metrics.correct))),
        treatmentRate: mean(treat.map((t) => num(t.metrics.correct))),
        delta,
        mcnemar: mc,
        verdict: correctnessVerdict,
      },
      metrics,
      metricVerdicts,
      quality,
      qualityVerdict,
    });
  }

  return {
    meta: {
      model: output.model,
      adapter: output.adapter,
      epochs: output.epochs,
      taskCount,
      conditions,
      baseline: baselineLabel,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
    },
    perCondition,
    comparisons,
    pareto: perCondition.map((c) => ({
      label: c.label,
      successRate: c.successRate,
      meanTokens: c.meanTokens,
    })),
    discrimination: assessDiscrimination(perCondition, comparisons, opts.discrimination),
    // Default the card's model to the one the run actually used, so the caller
    // cannot accidentally disclose a different model than it benchmarked.
    ...(opts.harness
      ? { harnessCard: buildHarnessCard({ model: output.model, ...opts.harness }) }
      : {}),
  };
}

function num(b: boolean): number {
  return b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}
function fixed(x: number | null, d = 0): string {
  return x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d);
}
function ciStr(ci: CI, d = 3): string {
  return `[${ci.lower.toFixed(d)}, ${ci.upper.toFixed(d)}]`;
}
function sig(p: PairedDeltaResult): string {
  return p.significant ? '✅' : '–';
}

/** Win/tie/loss badge under the ROPE norm — ties within noise are NOT wins. */
function vbadge(v: Verdict): string {
  return v === 'win' ? '🟢 WIN' : v === 'loss' ? '🔴 LOSS' : '⚪ TIE';
}

export function renderMarkdown(r: AnalysisReport): string {
  const L: string[] = [];
  L.push(`# UAP Paired Benchmark Report`);
  L.push('');
  L.push(
    `**Model:** ${r.meta.model}  ·  **Adapter:** ${r.meta.adapter}  ·  ` +
      `**Tasks:** ${r.meta.taskCount}  ·  **Epochs:** ${r.meta.epochs}  ·  ` +
      `**Baseline:** \`${r.meta.baseline}\``
  );
  L.push(`*${r.meta.startedAt} → ${r.meta.finishedAt}*`);
  L.push('');

  // Ahead of every number, because a reader who quotes a delta from a run that
  // could not measure anything has been misled by the report, not by the data.
  const d = r.discrimination;
  if (!d.usable) {
    const what = d.efficiencyUsable ? 'NO CORRECTNESS SIGNAL' : 'NO USABLE SIGNAL';
    L.push(`> ⚠️ **${what} (${d.status})** — ${d.reason}`);
    L.push('>');
    L.push(
      d.efficiencyUsable
        ? '> The CORRECTNESS delta below is not evidence of anything. The efficiency deltas are.'
        : '> The deltas below are not evidence of anything. Do not cite them.'
    );
    L.push('');
  } else {
    L.push(`> Signal check: ${d.reason}`);
    L.push('');
  }

  L.push(`## Per-condition summary`);
  L.push('');
  const anyQuality = r.perCondition.some((c) => c.meanQuality != null);
  L.push(
    `| Condition | n | Success | Tokens | Turns | Cost $ | Latency ms | Err |` +
      (anyQuality ? ` Quality |` : ``)
  );
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|` + (anyQuality ? `--:|` : ``));
  for (const c of r.perCondition) {
    L.push(
      `| \`${c.label}\` | ${c.n} | ${pct(c.successRate)} | ${fixed(c.meanTokens)} | ` +
        `${fixed(c.meanTurns, 1)} | ${fixed(c.meanCostUsd, 4)} | ${fixed(c.meanLatencyMs)} | ${pct(c.errorRate)} |` +
        (anyQuality ? ` ${fixed(c.meanQuality, 1)} |` : ``)
    );
  }
  L.push('');

  L.push(`## Paired comparisons vs \`${r.meta.baseline}\``);
  L.push('');
  for (const cmp of r.comparisons) {
    L.push(`### \`${cmp.label}\``);
    L.push('');
    const cd = cmp.correctness;
    L.push(
      `**Verdict:** ${vbadge(cd.verdict)}  ` +
        `**Correctness:** ${pct(cd.baselineRate)} → ${pct(cd.treatmentRate)}  ` +
        `(Δ ${(cd.delta.meanDelta * 100).toFixed(1)}pp, 95% CI ${ciStr(cd.delta.ci)}, ` +
        `p=${cd.delta.pValue.toFixed(3)}) ${sig(cd.delta)}`
    );
    const m = cd.mcnemar;
    L.push('');
    L.push(
      `**Gate value (McNemar 2×2):** fixed ${m.onlyTreatment}, regressed ${m.onlyBaseline}, ` +
        `net ${m.netGain >= 0 ? '+' : ''}${m.netGain} (p=${m.pValue.toFixed(3)}); ` +
        `both✓ ${m.bothCorrect}, both✗ ${m.bothWrong}`
    );
    if (cmp.quality) {
      const q = cmp.quality;
      L.push('');
      L.push(
        `**Quality (composite 0-100):** ${vbadge(cmp.qualityVerdict ?? 'tie')}  ` +
          `Δ ${q.meanDelta.toFixed(1)}, 95% CI ${ciStr(q.ci, 1)}, p=${q.pValue.toFixed(3)} ${sig(q)}`
      );
    }
    L.push('');
    L.push(`| Metric | Δ mean | 95% CI | p | verdict |`);
    L.push(`|---|--:|--:|--:|:-:|`);
    for (const metric of CONTINUOUS_METRICS) {
      const pd = cmp.metrics[metric];
      if (!pd) continue;
      const d = metric === 'costUsd' ? 4 : 1;
      const mv = cmp.metricVerdicts[metric] ?? 'tie';
      L.push(
        `| ${metric} | ${pd.meanDelta.toFixed(d)} | ${ciStr(pd.ci, d)} | ` +
          `${pd.pValue.toFixed(3)} | ${vbadge(mv)} |`
      );
    }
    L.push('');
  }

  L.push(`## Cost–accuracy Pareto`);
  L.push('');
  L.push(`| Condition | Success | Mean tokens |`);
  L.push(`|---|--:|--:|`);
  for (const p of [...r.pareto].sort((a, b) => b.successRate - a.successRate)) {
    L.push(`| \`${p.label}\` | ${pct(p.successRate)} | ${fixed(p.meanTokens)} |`);
  }
  L.push('');
  L.push(
    `> Interpretation: a credible UAP win is a **positive net gate value** and ` +
      `**non-inferior success** at **lower tokens/turns** — or higher success at acceptable cost. ` +
      `Single-arm point estimates without overlapping-zero CIs are not claims.`
  );
  L.push('');
  // The disclosure card goes LAST and unconditionally when present: it is the
  // context every number above must be read in (harness plan F).
  if (r.harnessCard) {
    L.push(renderHarnessCard(r.harnessCard));
    L.push('');
  }
  return L.join('\n');
}
