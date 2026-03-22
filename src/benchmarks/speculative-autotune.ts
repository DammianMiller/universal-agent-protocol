export interface SpeculativeParams {
  draftMax: number;
  draftMin: number;
  draftPMin: number;
}

export interface RuntimeMetrics {
  acceptanceRate: number;
  rollbackRate: number;
}

export type TuningProfile = 'throughput' | 'latency' | 'stable';

export interface SimulationResult {
  profile: TuningProfile;
  trace: 'stable' | 'volatile' | 'mixed';
  steps: number;
  staticAvgTps: number;
  adaptiveAvgTps: number;
  improvementPct: number;
  finalAdaptiveParams: SpeculativeParams;
}

export interface LiveBenchmarkSample {
  latencyMs: number;
  completionTokens: number;
}

export interface LiveBenchmarkSummary {
  runs: number;
  totalCompletionTokens: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  tokensPerSecond: number;
}

const MIN_DRAFT_MAX = 4;
const MAX_DRAFT_MAX = 32;
const MIN_DRAFT_MIN = 1;
const MAX_DRAFT_MIN = 8;
const MIN_DRAFT_P_MIN = 0.6;
const MAX_DRAFT_P_MIN = 0.95;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function summarizeLiveBenchmark(samples: LiveBenchmarkSample[]): LiveBenchmarkSummary {
  const runs = samples.length;
  const totalCompletionTokens = samples.reduce((sum, sample) => sum + sample.completionTokens, 0);
  const totalLatencyMs = samples.reduce((sum, sample) => sum + sample.latencyMs, 0);
  const avgLatencyMs = runs > 0 ? totalLatencyMs / runs : 0;
  const tokensPerSecond = totalLatencyMs > 0 ? (totalCompletionTokens / totalLatencyMs) * 1000 : 0;

  return {
    runs,
    totalCompletionTokens,
    totalLatencyMs: Number(totalLatencyMs.toFixed(2)),
    avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
    tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
  };
}

export function recommendAdaptiveFromLive(
  summary: LiveBenchmarkSummary,
  profile: TuningProfile,
  baseParams: SpeculativeParams
): {
  inferredMetrics: RuntimeMetrics;
  tunedParams: SpeculativeParams;
} {
  const acceptanceRate = clamp(0.38 + summary.tokensPerSecond / 190, 0.35, 0.9);
  const rollbackRate = clamp((1 - acceptanceRate) * 0.4, 0.05, 0.35);

  const inferredMetrics: RuntimeMetrics = { acceptanceRate, rollbackRate };
  const tunedParams = tuneSpeculativeParams(baseParams, inferredMetrics, profile);

  return { inferredMetrics, tunedParams };
}

export function tuneSpeculativeParams(
  base: SpeculativeParams,
  metrics: RuntimeMetrics,
  profile: TuningProfile
): SpeculativeParams {
  const acceptance = clamp(metrics.acceptanceRate, 0, 1);
  const rollback = clamp(metrics.rollbackRate, 0, 1);

  const profileDraftBias = profile === 'throughput' ? 1.5 : profile === 'latency' ? -1.5 : 0;
  const profilePMinBias = profile === 'throughput' ? -0.015 : profile === 'latency' ? 0.02 : 0;

  const targetDraftMax = 8 + acceptance * 16 - rollback * 4 + profileDraftBias;
  const targetPMin = 0.92 - acceptance * 0.25 + rollback * 0.05 + profilePMinBias;

  let draftMax = base.draftMax * 0.35 + targetDraftMax * 0.65;
  let draftPMin = base.draftPMin * 0.35 + targetPMin * 0.65;

  if (acceptance < 0.45 || rollback > 0.35) {
    draftMax -= 2;
    draftPMin += 0.03;
  }

  let draftMin = draftMax * (profile === 'latency' ? 0.22 : 0.28);

  draftMax = Math.round(clamp(draftMax, MIN_DRAFT_MAX, MAX_DRAFT_MAX));
  draftMin = Math.round(clamp(draftMin, MIN_DRAFT_MIN, Math.min(MAX_DRAFT_MIN, draftMax)));
  draftPMin = Number(clamp(draftPMin, MIN_DRAFT_P_MIN, MAX_DRAFT_P_MIN).toFixed(2));

  return { draftMax, draftMin, draftPMin };
}

export function estimateTps(params: SpeculativeParams, acceptanceRate: number): number {
  const acceptance = clamp(acceptanceRate, 0.05, 0.99);

  const optimalDraftMax = 8 + acceptance * 16;
  const optimalPMin = 0.92 - acceptance * 0.25;

  const proposalGain = 1 + (params.draftMax - 10) * 0.022;
  const acceptanceFactor = 0.62 + acceptance * 0.68;

  const draftAlignmentPenalty = 1 - Math.min(0.45, Math.abs(params.draftMax - optimalDraftMax) * 0.025);
  const pMinAlignmentPenalty = 1 - Math.min(0.35, Math.abs(params.draftPMin - optimalPMin) * 1.8);

  const tps =
    100 *
    proposalGain *
    acceptanceFactor *
    Math.max(0.35, draftAlignmentPenalty) *
    Math.max(0.4, pMinAlignmentPenalty);
  return Number(Math.max(12, tps).toFixed(2));
}

interface SeededRandom {
  next: () => number;
}

function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0xffffffff;
    },
  };
}

export function generateAcceptanceTrace(
  mode: 'stable' | 'volatile' | 'mixed',
  steps: number,
  seed: number
): number[] {
  const rng = createSeededRandom(seed);
  const trace: number[] = [];

  for (let i = 0; i < steps; i += 1) {
    const phase = i / Math.max(1, steps - 1);
    let base = 0.7;
    let noise = 0.08;

    if (mode === 'stable') {
      base = 0.74;
      noise = 0.04;
    } else if (mode === 'volatile') {
      base = 0.62 + Math.sin(phase * Math.PI * 5) * 0.15;
      noise = 0.12;
    } else {
      if (phase < 0.33) {
        base = 0.78;
        noise = 0.05;
      } else if (phase < 0.66) {
        base = 0.58;
        noise = 0.11;
      } else {
        base = 0.72;
        noise = 0.06;
      }
    }

    const jitter = (rng.next() * 2 - 1) * noise;
    trace.push(clamp(base + jitter, 0.2, 0.95));
  }

  return trace;
}

export function runSimulationBenchmark(options?: {
  steps?: number;
  seed?: number;
  trace?: 'stable' | 'volatile' | 'mixed';
  profile?: TuningProfile;
  staticParams?: SpeculativeParams;
}): SimulationResult {
  const steps = options?.steps ?? 120;
  const seed = options?.seed ?? 42;
  const traceType = options?.trace ?? 'mixed';
  const profile = options?.profile ?? 'throughput';
  const staticParams = options?.staticParams ?? { draftMax: 16, draftMin: 3, draftPMin: 0.8 };

  const trace = generateAcceptanceTrace(traceType, steps, seed);
  let adaptiveParams = { ...staticParams };
  let emaAcceptance = trace[0] ?? 0.7;
  let emaRollback = clamp((1 - emaAcceptance) * 0.35, 0, 1);
  const tuneInterval = 6;

  let staticSum = 0;
  let adaptiveSum = 0;

  for (let i = 0; i < trace.length; i += 1) {
    const acceptance = trace[i];
    const rollbackRate = clamp((1 - acceptance) * 0.35, 0, 1);

    emaAcceptance = emaAcceptance * 0.75 + acceptance * 0.25;
    emaRollback = emaRollback * 0.75 + rollbackRate * 0.25;

    staticSum += estimateTps(staticParams, acceptance);

    if (i % tuneInterval === 0) {
      adaptiveParams = tuneSpeculativeParams(
        adaptiveParams,
        { acceptanceRate: emaAcceptance, rollbackRate: emaRollback },
        profile
      );
    }

    adaptiveSum += estimateTps(adaptiveParams, acceptance);
  }

  const staticAvgTps = Number((staticSum / trace.length).toFixed(2));
  const adaptiveAvgTps = Number((adaptiveSum / trace.length).toFixed(2));
  const improvementPct = Number((((adaptiveAvgTps - staticAvgTps) / staticAvgTps) * 100).toFixed(2));

  return {
    profile,
    trace: traceType,
    steps,
    staticAvgTps,
    adaptiveAvgTps,
    improvementPct,
    finalAdaptiveParams: adaptiveParams,
  };
}
