import { describe, expect, it } from 'vitest';
import {
  recommendAdaptiveFromLive,
  runSimulationBenchmark,
  summarizeLiveBenchmark,
  tuneSpeculativeParams,
} from '../src/benchmarks/speculative-autotune.js';

describe('speculative autotune', () => {
  it('reduces aggressiveness when acceptance is poor', () => {
    const tuned = tuneSpeculativeParams(
      { draftMax: 16, draftMin: 3, draftPMin: 0.8 },
      { acceptanceRate: 0.4, rollbackRate: 0.32 },
      'throughput'
    );

    expect(tuned.draftMax).toBeLessThan(16);
    expect(tuned.draftPMin).toBeGreaterThan(0.8);
  });

  it('improves average TPS over static defaults on mixed traces', () => {
    const result = runSimulationBenchmark({
      profile: 'throughput',
      trace: 'mixed',
      steps: 240,
      seed: 7,
    });

    expect(result.adaptiveAvgTps).toBeGreaterThan(result.staticAvgTps);
    expect(result.improvementPct).toBeGreaterThan(0);
  });

  it('summarizes live benchmark samples to throughput stats', () => {
    const summary = summarizeLiveBenchmark([
      { latencyMs: 1000, completionTokens: 120 },
      { latencyMs: 1500, completionTokens: 150 },
    ]);

    expect(summary.runs).toBe(2);
    expect(summary.totalCompletionTokens).toBe(270);
    expect(summary.tokensPerSecond).toBeCloseTo(108, 5);
  });

  it('recommends valid tuned params from live summary', () => {
    const recommendation = recommendAdaptiveFromLive(
      {
        runs: 5,
        totalCompletionTokens: 1000,
        totalLatencyMs: 10000,
        avgLatencyMs: 2000,
        tokensPerSecond: 100,
      },
      'throughput',
      { draftMax: 16, draftMin: 3, draftPMin: 0.8 }
    );

    expect(recommendation.inferredMetrics.acceptanceRate).toBeGreaterThan(0.35);
    expect(recommendation.tunedParams.draftMax).toBeGreaterThanOrEqual(4);
    expect(recommendation.tunedParams.draftPMin).toBeGreaterThanOrEqual(0.6);
  });
});
