import { describe, it, expect } from 'vitest';
import {
  heuristicQuality,
  scoreQuality,
  efficiencyScore,
  toolReliabilityScore,
  planningScore,
  type QualityScoreInput,
} from '../src/self-tuning/quality-scorer.js';
import { parseJsonLenient, type JudgeClient } from '../src/self-tuning/judge.js';
import {
  compositeQuality,
  QualityScoreSchema,
  type MetricVector,
} from '../src/benchmarks/paired/types.js';
import { analyze } from '../src/benchmarks/paired/report.js';
import type { RunnerOutput } from '../src/benchmarks/paired/runner.js';
import type { RunRecord } from '../src/benchmarks/paired/types.js';

function metrics(over: Partial<MetricVector> = {}): MetricVector {
  return {
    correct: true,
    tokens: 10000,
    costUsd: null,
    turns: 5,
    toolCalls: 8,
    latencyMs: 1000,
    wellFormed: true,
    error: null,
    ...over,
  };
}

const baseInput = (over: Partial<QualityScoreInput> = {}): QualityScoreInput => ({
  taskInstruction: 'Fix the failing test in calc.js',
  correct: true,
  metrics: metrics(),
  output: 'diff --git a/calc.js ...',
  ...over,
});

describe('quality-scorer — heuristic path', () => {
  it('scores a correct run higher than an incorrect one', () => {
    const good = heuristicQuality(baseInput({ correct: true, metrics: metrics({ correct: true }) }));
    const bad = heuristicQuality(baseInput({ correct: false, metrics: metrics({ correct: false }) }));
    expect(good.composite).toBeGreaterThan(bad.composite);
    expect(good.correctness).toBe(100);
    expect(bad.correctness).toBe(0);
    expect(good.source).toBe('heuristic');
  });

  it('produces a schema-valid, 0-100-bounded score', () => {
    const s = heuristicQuality(baseInput());
    expect(() => QualityScoreSchema.parse(s)).not.toThrow();
    for (const k of ['correctness', 'quality', 'efficiency', 'toolReliability', 'planning', 'composite'] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(100);
    }
  });

  it('efficiency rewards leaner correct runs and penalizes wasted tokens', () => {
    const lean = efficiencyScore(metrics({ correct: true, tokens: 3000 }));
    const heavy = efficiencyScore(metrics({ correct: true, tokens: 40000 }));
    const wasted = efficiencyScore(metrics({ correct: false, tokens: 3000 }));
    expect(lean).toBeGreaterThan(heavy);
    expect(wasted).toBeLessThan(lean); // an incorrect run wasted its tokens
  });

  it('tool reliability collapses on a malformed edit', () => {
    const clean = toolReliabilityScore(metrics({ wellFormed: true }));
    const malformed = toolReliabilityScore(metrics({ wellFormed: false }));
    expect(malformed).toBeLessThan(clean);
    expect(malformed).toBeLessThan(50);
  });

  it('planning improves with fewer turns', () => {
    const tight = planningScore(metrics({ correct: true, turns: 3 }));
    const loose = planningScore(metrics({ correct: true, turns: 30 }));
    expect(tight).toBeGreaterThan(loose);
  });
});

describe('compositeQuality — weighting', () => {
  it('renormalizes over supplied weights', () => {
    const dims = { correctness: 100, quality: 0, efficiency: 0, toolReliability: 0, planning: 0 };
    // Only correctness weighted → composite equals correctness.
    expect(compositeQuality(dims, { correctness: 1 })).toBe(100);
    // Default weights (planning 0) → correctness dominates but doesn't reach 100.
    expect(compositeQuality(dims)).toBeCloseTo(40, 5);
  });
});

describe('quality-scorer — judge path', () => {
  const stubJudge = (payload: object): JudgeClient => ({
    id: 'stub-judge',
    complete: async () => JSON.stringify(payload),
  });

  it('fuses judge dims but anchors correctness to ground truth', async () => {
    // Judge lies that a FAILED task is a perfect pass; correctness must stay low.
    const s = await scoreQuality(baseInput({ correct: false, metrics: metrics({ correct: false }) }), {
      judge: stubJudge({ correctness: 100, quality: 90, planning: 80, rationale: 'looks great' }),
    });
    expect(s.source).toBe('hybrid');
    expect(s.correctness).toBeLessThanOrEqual(30); // 0.3*100 + 0.7*0 = 30
    expect(s.quality).toBe(90);
    expect(s.rationale).toBe('looks great');
  });

  it('falls back to the heuristic on a judge failure (never throws)', async () => {
    const throwing: JudgeClient = { id: 'boom', complete: async () => { throw new Error('network'); } };
    const s = await scoreQuality(baseInput(), { judge: throwing });
    expect(s.source).toBe('heuristic');
  });

  it('falls back on unparseable judge output', async () => {
    const garbage: JudgeClient = { id: 'garbage', complete: async () => 'not json at all' };
    const s = await scoreQuality(baseInput(), { judge: garbage });
    expect(s.source).toBe('heuristic');
  });
});

describe('parseJsonLenient', () => {
  it('parses bare, fenced, prose-wrapped, and think-wrapped JSON', () => {
    expect(parseJsonLenient('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLenient('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLenient('Here is the result: {"a":3} — done')).toEqual({ a: 3 });
    expect(parseJsonLenient('<think>hmm</think>\n{"a":4}')).toEqual({ a: 4 });
    expect(parseJsonLenient('no json here')).toBeNull();
  });
});

describe('paired report — quality delta surfacing', () => {
  it('computes a paired composite-quality delta when both arms are scored', () => {
    const mk = (condition: string, seed: number, composite: number): RunRecord => ({
      taskId: 't1',
      condition,
      seed,
      adapter: 'mock',
      model: 'qwen36-a3b',
      metrics: metrics({ correct: composite > 50 }),
      qualityScore: {
        correctness: composite,
        quality: composite,
        efficiency: composite,
        toolReliability: composite,
        planning: composite,
        composite,
        source: 'heuristic',
      },
    });
    const records: RunRecord[] = [
      mk('baseline', 0, 40),
      mk('baseline', 1, 45),
      mk('uap-tuned', 0, 70),
      mk('uap-tuned', 1, 75),
    ];
    const output: RunnerOutput = {
      records,
      model: 'qwen36-a3b',
      adapter: 'mock',
      epochs: 2,
      startedAt: 'a',
      finishedAt: 'b',
    };
    const report = analyze(output, { baselineLabel: 'baseline', iterations: 500, seed: 7 });
    const cmp = report.comparisons.find((c) => c.label === 'uap-tuned');
    expect(cmp?.quality).toBeDefined();
    expect(cmp!.quality!.meanDelta).toBeCloseTo(30, 5); // (70+75)/2 - (40+45)/2
    const summary = report.perCondition.find((c) => c.label === 'uap-tuned');
    expect(summary?.meanQuality).toBeCloseTo(72.5, 5);
  });
});
