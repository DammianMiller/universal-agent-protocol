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

export interface ConditionSummary {
  label: string;
  n: number;
  successRate: number;
  meanTokens: number | null;
  meanTurns: number | null;
  meanCostUsd: number | null;
  meanLatencyMs: number;
  errorRate: number;
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
  return {
    label,
    n: recs.length,
    successRate: recs.length ? mean(correct) : NaN,
    meanTokens: numeric((m) => m.tokens),
    meanTurns: numeric((m) => m.turns),
    meanCostUsd: numeric((m) => m.costUsd),
    meanLatencyMs: numeric((m) => m.latencyMs) ?? NaN,
    errorRate: recs.length ? mean(recs.map((r) => (r.metrics.error ? 1 : 0))) : NaN,
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

  L.push(`## Per-condition summary`);
  L.push('');
  L.push(`| Condition | n | Success | Tokens | Turns | Cost $ | Latency ms | Err |`);
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|`);
  for (const c of r.perCondition) {
    L.push(
      `| \`${c.label}\` | ${c.n} | ${pct(c.successRate)} | ${fixed(c.meanTokens)} | ` +
        `${fixed(c.meanTurns, 1)} | ${fixed(c.meanCostUsd, 4)} | ${fixed(c.meanLatencyMs)} | ${pct(c.errorRate)} |`
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
  return L.join('\n');
}
