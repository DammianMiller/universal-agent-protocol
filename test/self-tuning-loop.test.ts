import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  decideTuning,
  runTuningIteration,
  type TuningValidator,
  type TuningValidationOutcome,
} from '../src/self-tuning/orchestrator.js';
import { runTuningLoop } from '../src/self-tuning/run.js';
import { buildPairedTuningValidator } from '../src/self-tuning/paired-validator.js';
import { defaultFlagConfig, type FlagConfig } from '../src/self-tuning/flags.js';
import { analyze } from '../src/benchmarks/paired/report.js';
import type { Comparison } from '../src/benchmarks/paired/report.js';
import type { RunnerOutput } from '../src/benchmarks/paired/runner.js';
import type { RunRecord, MetricVector } from '../src/benchmarks/paired/types.js';
import type { TuningContext } from '../src/self-tuning/llm-tuner.js';

function metrics(correct: boolean, tokens = 8000): MetricVector {
  return { correct, tokens, costUsd: null, turns: 4, toolCalls: 6, latencyMs: 500, wellFormed: true, error: null };
}

/** Build a candidate-vs-baseline Comparison from per-cell composite quality arrays. */
function mkComparison(baselineQ: number[], candidateQ: number[]): Comparison {
  const rec = (label: string, q: number, seed: number): RunRecord => ({
    taskId: 't',
    condition: label,
    seed,
    adapter: 'mock',
    model: 'm',
    metrics: metrics(q > 50),
    qualityScore: { correctness: q, quality: q, efficiency: q, toolReliability: q, planning: q, composite: q, source: 'heuristic' },
  });
  const records: RunRecord[] = [
    ...baselineQ.map((q, i) => rec('baseline', q, i)),
    ...candidateQ.map((q, i) => rec('candidate', q, i)),
  ];
  const output: RunnerOutput = { records, model: 'm', adapter: 'mock', epochs: baselineQ.length, startedAt: 'a', finishedAt: 'b' };
  const report = analyze(output, { baselineLabel: 'baseline', iterations: 1000, seed: 3 });
  return report.comparisons.find((c) => c.label === 'candidate')!;
}

describe('decideTuning', () => {
  it('accepts a significant quality lift past the hysteresis band', () => {
    const cmp = mkComparison([40, 42, 41, 39, 43, 40], [70, 72, 71, 69, 73, 70]);
    const d = decideTuning(cmp, null, { minQualityGain: 2 });
    expect(d.verdict).toBe('accept');
    expect(d.qualityDelta).toBeGreaterThan(20);
  });

  it('rejects a tiny (within-hysteresis) lift', () => {
    const cmp = mkComparison([50, 51, 49, 50, 51, 50], [50.5, 51.2, 49.4, 50.1, 51.3, 50.2]);
    const d = decideTuning(cmp, null, { minQualityGain: 5 });
    expect(d.verdict).toBe('reject');
  });

  it('rejects when the held-out suite regresses significantly', () => {
    const val = mkComparison([40, 41, 40, 42, 41, 40], [70, 71, 70, 72, 71, 70]);
    const held = mkComparison([70, 71, 70, 72, 71, 70], [40, 41, 40, 42, 41, 40]); // big drop
    const d = decideTuning(val, held, { minQualityGain: 2, heldoutRegressionTolerance: 2 });
    expect(d.verdict).toBe('reject');
    expect(d.reason).toMatch(/held-out/);
  });
});

describe('runTuningIteration', () => {
  const ctx = (): TuningContext => ({
    model: 'qwen36-a3b',
    currentConfig: { ...defaultFlagConfig(), 'recipes.enabled': false, 'recipes.recipe': 'auto' },
    observations: [
      { config: { ...defaultFlagConfig(), 'recipes.enabled': false }, quality: 50 },
      { config: { ...defaultFlagConfig(), 'recipes.enabled': true }, quality: 62 },
      { config: { ...defaultFlagConfig(), PROXY_LOOP_BREAKER: false }, quality: 48 },
    ],
  });

  const acceptValidator: TuningValidator = async (): Promise<TuningValidationOutcome> => ({
    validation: mkComparison([40, 41, 40, 42, 41, 40], [70, 71, 70, 72, 71, 70]),
    heldout: null,
    candidateQuality: 71,
  });

  it('accepts and advances the config on a validated lift', async () => {
    const r = await runTuningIteration({ ctx: ctx(), validate: acceptValidator });
    expect(r.outcome).toBe('accepted');
    expect(r.accepted).toBe(true);
    expect(r.observation?.quality).toBe(71);
    expect(r.config).not.toEqual(ctx().currentConfig);
  });

  it('rejects and keeps the current config on no lift', async () => {
    const noLift: TuningValidator = async () => ({
      validation: mkComparison([50, 51, 49, 50, 51, 50], [50, 51, 49, 50, 51, 50]),
      heldout: null,
      candidateQuality: 50,
    });
    const c = ctx();
    const r = await runTuningIteration({ ctx: c, validate: noLift });
    expect(r.outcome).toBe('rejected');
    expect(r.config).toEqual(c.currentConfig);
  });

  it('reports an error outcome when validation throws', async () => {
    const boom: TuningValidator = async () => { throw new Error('bench crashed'); };
    const r = await runTuningIteration({ ctx: ctx(), validate: boom });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/bench crashed/);
  });
});

describe('runTuningLoop — end-to-end', () => {
  it('accepts improving proposals and records profile history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-tuneloop-'));
    try {
      writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
      // Every candidate validates as better than baseline (simulates config helping).
      const alwaysBetter: TuningValidator = async () => ({
        validation: mkComparison([40, 41, 40, 42, 41, 40], [70, 71, 70, 72, 71, 70]),
        heldout: null,
        candidateQuality: 71,
      });
      const res = await runTuningLoop({
        model: 'qwen36-a3b',
        validate: alwaysBetter,
        judge: null, // GP path
        maxIterations: 3,
        tuner: { seed: 5 },
        now: '2026-07-12T00:00:00.000Z',
        apply: false,
        cwd: dir,
      });
      expect(res.accepted.length).toBeGreaterThan(0);
      expect(res.finalQuality).toBeGreaterThan(0);
      expect(res.profile.history.length).toBeGreaterThan(0);
      expect(res.profile.history.every((h) => h.accepted)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops on a plateau when nothing improves', async () => {
    const flat: TuningValidator = async () => ({
      validation: mkComparison([50, 51, 49, 50, 51, 50], [50, 51, 49, 50, 51, 50]),
      heldout: null,
      candidateQuality: 50,
    });
    const res = await runTuningLoop({
      model: 'qwen36-a3b',
      validate: flat,
      judge: null,
      maxIterations: 10,
      plateauLimit: 2,
      tuner: { seed: 1 },
      now: '2026-07-12T00:00:00.000Z',
      apply: false,
    });
    expect(res.stoppedBecause).toBe('plateau');
    expect(res.accepted.length).toBe(0);
    expect(res.iterations.length).toBeLessThanOrEqual(2);
  });
});

describe('buildPairedTuningValidator — real two-arm scoring', () => {
  it('scores both arms and returns a quality delta + candidate quality', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-pairedval-'));
    try {
      writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
      // The candidate arm resolves all tasks; the baseline arm resolves none.
      const runArm = async (label: string): Promise<RunRecord[]> => {
        const correct = label === 'candidate';
        return [0, 1, 2].map((seed) => ({
          taskId: 'task-a',
          condition: label,
          seed,
          adapter: 'mock',
          model: 'qwen36-a3b',
          metrics: metrics(correct, correct ? 4000 : 9000),
        }));
      };
      const validate = buildPairedTuningValidator({
        cwd: dir,
        runArm,
        scoreInput: (r) => ({ taskInstruction: 'do the thing', correct: r.metrics.correct, metrics: r.metrics }),
        judge: null, // heuristic scoring
        analyzeOptions: { iterations: 1000, seed: 2 },
      });
      const cur: FlagConfig = { ...defaultFlagConfig(), 'recipes.enabled': false };
      const cand: FlagConfig = { ...defaultFlagConfig(), 'recipes.enabled': true };
      const out = await validate(cand, cur);
      expect(out.validation.quality).toBeDefined();
      expect(out.validation.quality!.meanDelta).toBeGreaterThan(0);
      expect(out.candidateQuality).toBeGreaterThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
