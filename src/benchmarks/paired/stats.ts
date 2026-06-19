/**
 * Paired-comparison statistics for the UAP benchmark.
 *
 * The research is explicit: agent evals are stochastic, so a point estimate is
 * meaningless without a variance measure, and the *paired* design (same task &
 * seed in both arms) is what gives statistical power — it removes between-task
 * variance, the dominant noise source. This module implements:
 *
 *  - mean / std / standard error
 *  - paired bootstrap confidence interval on a delta (percentile method)
 *  - paired permutation test (two-sided) for significance of a delta
 *  - McNemar contingency for paired binary outcomes (the gate-value 2x2)
 *  - pass@k reducer
 *
 * All randomized procedures take an explicit seed so reports are reproducible
 * (the Mem0/Zep scandal lesson: single-run, non-reproducible numbers are the #1
 * credibility red flag).
 */

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, dependency-free.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Descriptive stats
// ---------------------------------------------------------------------------
export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}

export function std(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

export function stderr(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return std(xs) / Math.sqrt(xs.length);
}

export interface CI {
  lower: number;
  upper: number;
}

export interface PairedDeltaResult {
  /** Mean of (treatment - baseline) over paired observations. */
  meanDelta: number;
  /** Bootstrap percentile CI on the mean delta. */
  ci: CI;
  /** Two-sided permutation p-value for H0: delta == 0. */
  pValue: number;
  /** Number of paired observations. */
  n: number;
  /** True when the CI excludes 0 at the configured level. */
  significant: boolean;
}

export interface PairedOptions {
  /** Bootstrap/permutation iterations (default 10000). */
  iterations?: number;
  /** Confidence level for the CI, e.g. 0.95 (default). */
  confidence?: number;
  /** RNG seed for reproducibility (default 1). */
  seed?: number;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Paired analysis of a treatment vs baseline metric. `deltas[i]` is
 * (treatment_i - baseline_i) for the i-th paired observation. Returns the mean
 * delta, a bootstrap CI, and a permutation p-value (sign-flip, the correct null
 * for a paired design).
 */
export function pairedDelta(deltas: number[], opts: PairedOptions = {}): PairedDeltaResult {
  const iterations = opts.iterations ?? 10000;
  const confidence = opts.confidence ?? 0.95;
  const rng = mulberry32(opts.seed ?? 1);
  const n = deltas.length;

  if (n === 0) {
    return { meanDelta: NaN, ci: { lower: NaN, upper: NaN }, pValue: NaN, n: 0, significant: false };
  }

  const observed = mean(deltas);

  // --- Bootstrap CI: resample paired deltas with replacement.
  const bootMeans: number[] = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += deltas[(rng() * n) | 0];
    }
    bootMeans[b] = acc / n;
  }
  bootMeans.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const ci: CI = {
    lower: percentile(bootMeans, alpha / 2),
    upper: percentile(bootMeans, 1 - alpha / 2),
  };

  // --- Permutation test: under H0 the sign of each paired delta is arbitrary,
  //     so randomly flip signs and compare |mean| to observed.
  let extreme = 0;
  const absObs = Math.abs(observed);
  for (let p = 0; p < iterations; p++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += rng() < 0.5 ? deltas[i] : -deltas[i];
    }
    if (Math.abs(acc / n) >= absObs - 1e-12) extreme++;
  }
  const pValue = (extreme + 1) / (iterations + 1);

  return {
    meanDelta: observed,
    ci,
    pValue,
    n,
    significant: ci.lower > 0 || ci.upper < 0,
  };
}

// ---------------------------------------------------------------------------
// McNemar contingency for paired binary (correct/incorrect) outcomes.
// This 2x2 IS the gate-value framing: of tasks the baseline got wrong, how many
// did UAP fix (onlyTreatment), vs of tasks the baseline got right, how many did
// UAP break (onlyBaseline). A useful layer has onlyTreatment >> onlyBaseline.
// ---------------------------------------------------------------------------
export interface McNemarResult {
  bothCorrect: number;
  onlyTreatment: number; // baseline wrong, treatment right  (gate "saves")
  onlyBaseline: number; // baseline right, treatment wrong   (gate "regressions")
  bothWrong: number;
  /** Net correctness gain from treatment: (onlyTreatment - onlyBaseline). */
  netGain: number;
  /** Two-sided exact McNemar p-value on the discordant pairs. */
  pValue: number;
  n: number;
}

/** Exact binomial two-sided tail (used for McNemar on discordant pairs). */
function binomTwoSided(b: number, c: number): number {
  const nDisc = b + c;
  if (nDisc === 0) return 1;
  // P(X <= min) under Binomial(nDisc, 0.5), doubled, capped at 1.
  const k = Math.min(b, c);
  let logFac = 0;
  const logFacs: number[] = new Array(nDisc + 1);
  logFacs[0] = 0;
  for (let i = 1; i <= nDisc; i++) {
    logFac += Math.log(i);
    logFacs[i] = logFac;
  }
  const logChoose = (nn: number, kk: number) => logFacs[nn] - logFacs[kk] - logFacs[nn - kk];
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logChoose(nDisc, i) + nDisc * Math.log(0.5));
  }
  return Math.min(1, 2 * tail);
}

export function mcnemar(treatment: boolean[], baseline: boolean[]): McNemarResult {
  if (treatment.length !== baseline.length) {
    throw new Error('mcnemar: paired arrays must be equal length');
  }
  let bothCorrect = 0;
  let onlyTreatment = 0;
  let onlyBaseline = 0;
  let bothWrong = 0;
  for (let i = 0; i < treatment.length; i++) {
    const t = treatment[i];
    const b = baseline[i];
    if (t && b) bothCorrect++;
    else if (t && !b) onlyTreatment++;
    else if (!t && b) onlyBaseline++;
    else bothWrong++;
  }
  return {
    bothCorrect,
    onlyTreatment,
    onlyBaseline,
    bothWrong,
    netGain: onlyTreatment - onlyBaseline,
    pValue: binomTwoSided(onlyTreatment, onlyBaseline),
    n: treatment.length,
  };
}

// ---------------------------------------------------------------------------
// pass@k — probability at least one of k i.i.d. attempts succeeds, using the
// unbiased estimator from the Codex/HumanEval literature.
// ---------------------------------------------------------------------------
export function passAtK(numSamples: number, numCorrect: number, k: number): number {
  if (k > numSamples) throw new Error('passAtK: k cannot exceed numSamples');
  if (numSamples - numCorrect < k) return 1;
  let prod = 1;
  for (let i = 0; i < k; i++) {
    prod *= (numSamples - numCorrect - i) / (numSamples - i);
  }
  return 1 - prod;
}
