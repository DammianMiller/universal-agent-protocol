/**
 * LLM Self-Tuning — the Search-Space Reducer (P1): a real Gaussian-process
 * Bayesian optimizer over the tunable-flag space.
 *
 * With 16 flags of mixed type the naive grid is intractable (design §3.3.3), so
 * this module implements the three reduction techniques the design calls for as
 * an actual GP-BO loop:
 *   1. DEPENDENCY AWARENESS — inactive flags (whose parent gates them off) do
 *      not contribute to the kernel distance and are never perturbed, so the
 *      optimizer never wastes samples on a knob that has no effect.
 *   2. BAYESIAN OPTIMIZATION — a Gaussian process with an ARD kernel over mixed
 *      numeric (squared-exponential) + categorical (Hamming) dimensions models
 *      the quality surface; the next point maximizes Expected Improvement.
 *   3. TRANSFER LEARNING — prior good configs (from other models) are injected
 *      into the candidate pool as high-value seeds.
 *
 * The GP math is dependency-free: standardized targets, a Cholesky solve of
 * (K+σ²I), a small log-marginal-likelihood grid over the lengthscales, and the
 * closed-form EI acquisition. Everything is seeded for reproducible reports.
 */

import { mulberry32 } from '../benchmarks/paired/stats.js';
import {
  TUNABLE_FLAGS,
  TunableFlag,
  FlagConfig,
  FlagValue,
  flagValue,
  isFlagActive,
  coerceToDomain,
} from './flags.js';

/** One observed (config, quality) datapoint the GP is conditioned on. */
export interface Observation {
  config: FlagConfig;
  /** Composite quality score (0-100) measured for this config. */
  quality: number;
}

/** The four search phases (design §3.3.2). Bias which flags get perturbed. */
export type SearchPhase = 'coarse' | 'medium' | 'fine' | 'combinatorial';

export interface SearchOptions {
  /** RNG seed for reproducibility. Default 1. */
  seed?: number;
  /** Candidate pool size to score with the acquisition. Default 256. */
  poolSize?: number;
  /** EI exploration margin (ξ). Higher = more exploratory. Default 1.0 (std units). */
  xi?: number;
  /** Observation noise variance on the standardized scale. Default 0.05. */
  noise?: number;
  /** Prior good configs (e.g. cross-model transfer) seeded into the pool. */
  priors?: FlagConfig[];
  /** Search phase controlling candidate generation. Default 'combinatorial'. */
  phase?: SearchPhase;
  /**
   * Cold-start anchor: the config to explore around when there are NO
   * observations yet (nothing to fit a GP on). Lets the loop bootstrap its first
   * proposal from the current config instead of stalling.
   */
  seedConfig?: FlagConfig;
}

export interface Suggestion {
  config: FlagConfig;
  /** Expected Improvement (standardized units) of this config. */
  ei: number;
  /** GP predictive mean quality (0-100). */
  mean: number;
  /** GP predictive std (0-100 scale). */
  std: number;
}

// ---------------------------------------------------------------------------
// Normal helpers (erf-based CDF) for the EI closed form.
// ---------------------------------------------------------------------------
function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — max error 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// ---------------------------------------------------------------------------
// Mixed numeric/categorical ARD kernel.
// ---------------------------------------------------------------------------

/** Normalize a flag's value to a comparable scalar, or a categorical token. */
function normNumeric(flag: TunableFlag, v: FlagValue | undefined): number {
  const d = flag.domain;
  if (d.kind === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return (Math.max(d.min, Math.min(d.max, n)) - d.min) / Math.max(1e-9, d.max - d.min);
  }
  // bool as 0/1
  return v === true || v === 'true' || v === 1 ? 1 : 0;
}

interface KernelParams {
  /** Lengthscale for numeric/bool dims (on the normalized [0,1] scale). */
  lenNum: number;
  /** Lengthscale for categorical (enum) dims (Hamming). */
  lenCat: number;
}

/** k(a,b) with signal variance 1. Inactive-in-both dims contribute nothing. */
function kernel(a: FlagConfig, b: FlagConfig, p: KernelParams): number {
  let exponent = 0;
  for (const flag of TUNABLE_FLAGS) {
    const activeA = isFlagActive(flag, a);
    const activeB = isFlagActive(flag, b);
    if (!activeA && !activeB) continue; // both agree the dim is irrelevant
    const va = flagValue(a, flag.key);
    const vb = flagValue(b, flag.key);
    if (flag.domain.kind === 'enum') {
      // Categorical (Hamming): mismatch OR active-in-one-only is a full mismatch.
      const mism = activeA !== activeB || String(va) !== String(vb) ? 1 : 0;
      exponent += mism / (p.lenCat * p.lenCat);
    } else {
      const ua = activeA ? normNumeric(flag, va) : normNumeric(flag, undefined);
      const ub = activeB ? normNumeric(flag, vb) : normNumeric(flag, undefined);
      // active-in-one-only adds a structural penalty on top of the value gap.
      const struct = activeA !== activeB ? 0.5 : 0;
      const diff = ua - ub;
      exponent += (diff * diff + struct) / (p.lenNum * p.lenNum);
    }
  }
  return Math.exp(-0.5 * exponent);
}

// ---------------------------------------------------------------------------
// Linear algebra: Cholesky of an SPD matrix + triangular solves.
// ---------------------------------------------------------------------------
function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(sum, 1e-10));
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}
/** Solve L y = b (forward) then Lᵀ x = y (back) for A x = b given A=LLᵀ. */
function cholSolve(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

// ---------------------------------------------------------------------------
// The GP model.
// ---------------------------------------------------------------------------
interface FittedGP {
  L: number[][];
  alpha: number[]; // (K+σ²I)⁻¹ (y - mean)
  yMean: number;
  yStd: number;
  params: KernelParams;
  configs: FlagConfig[];
  noise: number;
}

function buildK(configs: FlagConfig[], p: KernelParams, noise: number): number[][] {
  const n = configs.length;
  const K: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const k = kernel(configs[i], configs[j], p);
      K[i][j] = k;
      K[j][i] = k;
    }
    K[i][i] += noise; // jitter + observation noise on the diagonal
  }
  return K;
}

/** Log marginal likelihood (up to constants) for hyperparameter selection. */
function logMarginalLikelihood(configs: FlagConfig[], yStd: number[], p: KernelParams, noise: number): number {
  const K = buildK(configs, p, noise);
  const L = cholesky(K);
  const alpha = cholSolve(L, yStd);
  let dataFit = 0;
  for (let i = 0; i < yStd.length; i++) dataFit += yStd[i] * alpha[i];
  let logDet = 0;
  for (let i = 0; i < L.length; i++) logDet += Math.log(L[i][i]);
  return -0.5 * dataFit - logDet - 0.5 * yStd.length * Math.log(2 * Math.PI);
}

function fitGP(obs: Observation[], noise: number): FittedGP {
  const configs = obs.map((o) => o.config);
  const ys = obs.map((o) => o.quality);
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const varY = ys.reduce((a, b) => a + (b - yMean) * (b - yMean), 0) / Math.max(1, ys.length - 1);
  const yStd = Math.max(1e-6, Math.sqrt(varY));
  const yz = ys.map((y) => (y - yMean) / yStd);

  // Light hyperparameter search: pick (lenNum, lenCat) maximizing log-ML over a
  // small grid. This is standard GP model selection, kept cheap.
  const numGrid = [0.15, 0.3, 0.5, 0.8];
  const catGrid = [0.5, 1.0, 2.0];
  let best: KernelParams = { lenNum: 0.3, lenCat: 1.0 };
  let bestLml = -Infinity;
  for (const lenNum of numGrid) {
    for (const lenCat of catGrid) {
      const lml = logMarginalLikelihood(configs, yz, { lenNum, lenCat }, noise);
      if (Number.isFinite(lml) && lml > bestLml) {
        bestLml = lml;
        best = { lenNum, lenCat };
      }
    }
  }

  const K = buildK(configs, best, noise);
  const L = cholesky(K);
  const alpha = cholSolve(L, yz);
  return { L, alpha, yMean, yStd, params: best, configs, noise };
}

/** Predict (mean, std) in ORIGINAL quality units at a candidate config. */
function predict(gp: FittedGP, x: FlagConfig): { mean: number; std: number } {
  const ks = gp.configs.map((c) => kernel(x, c, gp.params));
  let mz = 0;
  for (let i = 0; i < ks.length; i++) mz += ks[i] * gp.alpha[i];
  const v = cholSolve(gp.L, ks);
  let kxx = kernel(x, x, gp.params) + gp.noise;
  for (let i = 0; i < ks.length; i++) kxx -= ks[i] * v[i];
  const varz = Math.max(0, kxx);
  return { mean: gp.yMean + mz * gp.yStd, std: Math.sqrt(varz) * gp.yStd };
}

// ---------------------------------------------------------------------------
// Candidate generation (phase-aware, dependency-respecting).
// ---------------------------------------------------------------------------
function configKey(cfg: FlagConfig): string {
  // Only active flags define identity — two configs differing solely in an
  // inactive flag are the same point.
  return TUNABLE_FLAGS.filter((f) => isFlagActive(f, cfg))
    .map((f) => `${f.key}=${flagValue(cfg, f.key)}`)
    .sort()
    .join('|');
}

/** The set of flag values reachable for a numeric flag (grid over its range). */
function numericGrid(flag: TunableFlag): number[] {
  if (flag.domain.kind !== 'number') return [];
  const { min, max, step, int } = flag.domain;
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(int ? Math.round(v) : Number(v.toFixed(6)));
  return out.length ? out : [int ? Math.round(min) : min];
}

/** All alternative values for a flag (excluding its current value). */
function alternatives(flag: TunableFlag, current: FlagValue | undefined): FlagValue[] {
  if (flag.domain.kind === 'bool') return [!(current === true)];
  if (flag.domain.kind === 'enum') return flag.domain.values.filter((v) => v !== current);
  return numericGrid(flag).filter((v) => v !== current);
}

/** Which flags a phase is allowed to perturb. */
function phaseFlags(phase: SearchPhase, cfg: FlagConfig): TunableFlag[] {
  const active = TUNABLE_FLAGS.filter((f) => isFlagActive(f, cfg) || f.dependsOn.length === 0);
  switch (phase) {
    case 'coarse': // toggle the top-level boolean enablers only
      return active.filter((f) => f.domain.kind === 'bool' && f.dependsOn.length === 0);
    case 'medium': // enum choices (recipe type, intensity)
      return active.filter((f) => f.domain.kind === 'enum');
    case 'fine': // numeric refinement
      return active.filter((f) => f.domain.kind === 'number');
    case 'combinatorial':
    default:
      return active;
  }
}

function mutate(cfg: FlagConfig, flag: TunableFlag, value: FlagValue): FlagConfig {
  const next = { ...cfg };
  const coerced = coerceToDomain(flag.key, value);
  if (coerced !== null) next[flag.key] = coerced;
  return next;
}

/**
 * Generate a de-duplicated candidate pool around `best`: single- and
 * double-flag perturbations (phase-scoped) + priors + a few random configs.
 */
export function generateCandidates(
  best: FlagConfig,
  opts: SearchOptions = {},
): FlagConfig[] {
  const rng = mulberry32(opts.seed ?? 1);
  const phase = opts.phase ?? 'combinatorial';
  const poolSize = opts.poolSize ?? 256;
  const seen = new Set<string>([configKey(best)]);
  const pool: FlagConfig[] = [];
  const push = (c: FlagConfig) => {
    const k = configKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      pool.push(c);
    }
  };

  const flags = phaseFlags(phase, best);

  // Priors (transfer seeds) first — highest-value candidates.
  for (const prior of opts.priors ?? []) push({ ...best, ...prior });

  // Single-flag neighbors.
  for (const flag of flags) {
    for (const v of alternatives(flag, flagValue(best, flag.key))) {
      push(mutate(best, flag, v));
      if (pool.length >= poolSize) return pool;
    }
  }

  // Double-flag neighbors (combinatorial phase captures interactions).
  if (phase === 'combinatorial') {
    for (let i = 0; i < flags.length && pool.length < poolSize; i++) {
      for (let j = i + 1; j < flags.length && pool.length < poolSize; j++) {
        const av = alternatives(flags[i], flagValue(best, flags[i].key));
        const bv = alternatives(flags[j], flagValue(best, flags[j].key));
        if (!av.length || !bv.length) continue;
        const a = av[(rng() * av.length) | 0];
        const b = bv[(rng() * bv.length) | 0];
        push(mutate(mutate(best, flags[i], a), flags[j], b));
      }
    }
  }

  // A few fully-random configs for exploration.
  const nRandom = Math.min(32, poolSize - pool.length);
  for (let r = 0; r < nRandom; r++) {
    let c: FlagConfig = { ...best };
    for (const flag of flags) {
      if (rng() < 0.5) continue;
      const alts = alternatives(flag, flagValue(c, flag.key));
      if (alts.length) c = mutate(c, flag, alts[(rng() * alts.length) | 0]);
    }
    push(c);
  }

  return pool;
}

/**
 * The core BO step: fit a GP on `observations` and return the candidate config
 * that maximizes Expected Improvement over the current best observed quality.
 * With <2 observations there is nothing to model, so it returns the best
 * single-flag neighbor deterministically (pure exploration).
 */
export function proposeNext(observations: Observation[], opts: SearchOptions = {}): Suggestion | null {
  if (observations.length === 0) {
    // Cold start with no data: explore around the seed config if given.
    if (!opts.seedConfig) return null;
    const cands = generateCandidates(opts.seedConfig, opts);
    return cands.length ? { config: cands[0], ei: Number.POSITIVE_INFINITY, mean: 0, std: 0 } : null;
  }
  const noise = opts.noise ?? 0.05;
  const xi = opts.xi ?? 1.0;

  const best = observations.reduce((a, b) => (b.quality > a.quality ? b : a));
  const candidates = generateCandidates(best.config, opts);
  if (candidates.length === 0) return null;

  // Cold start: not enough data to condition a GP — explore the first neighbor.
  if (observations.length < 3) {
    const c = candidates[0];
    return { config: c, ei: Number.POSITIVE_INFINITY, mean: best.quality, std: 0 };
  }

  const gp = fitGP(observations, noise);
  const fBestZ = (best.quality - gp.yMean) / gp.yStd;

  let bestCand: Suggestion | null = null;
  for (const c of candidates) {
    const { mean, std } = predict(gp, c);
    const stdZ = std / gp.yStd;
    let ei: number;
    if (stdZ < 1e-9) {
      ei = 0;
    } else {
      const muZ = (mean - gp.yMean) / gp.yStd;
      const z = (muZ - fBestZ - xi) / stdZ;
      ei = (muZ - fBestZ - xi) * normCdf(z) + stdZ * normPdf(z);
    }
    if (!bestCand || ei > bestCand.ei) bestCand = { config: c, ei, mean, std };
  }
  return bestCand;
}

/** Expose the fitted-GP prediction for callers that want the surface directly. */
export function fitAndPredict(
  observations: Observation[],
  at: FlagConfig,
  noise = 0.05,
): { mean: number; std: number } | null {
  if (observations.length < 2) return null;
  const gp = fitGP(observations, noise);
  return predict(gp, at);
}
