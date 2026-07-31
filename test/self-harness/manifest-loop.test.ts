import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../../src/benchmarks/paired/types.js';
import type { Comparison } from '../../src/benchmarks/paired/report.js';
import { runIteration } from '../../src/self-harness/orchestrator.js';
import { ManifestStore } from '../../src/self-harness/manifest.js';

function rec(taskId: string, seed: number, correct: boolean, error: string | null, turns = 1): RunRecord {
  return {
    taskId,
    condition: 'baseline',
    seed,
    metrics: {
      correct, error, turns, tokens: null, costUsd: null, toolCalls: null,
      latencyMs: 1000, wellFormed: true,
    },
  } as RunRecord;
}

function accepting(): Comparison {
  return {
    label: 'with-mod',
    baseline: 'baseline',
    correctness: {
      baselineRate: 0,
      treatmentRate: 0.3,
      delta: { meanDelta: 0.3, ci: { lower: 0, upper: 0 }, pValue: 0.5, n: 10, significant: true },
      mcnemar: {
        bothCorrect: 0, onlyTreatment: 3, onlyBaseline: 0, bothWrong: 0,
        netGain: 3, pValue: 0.5, n: 10,
      },
    },
    metrics: {},
  } as Comparison;
}

const TIMEOUTS = [
  rec('a', 0, false, 'agent timed out after 300s'),
  rec('b', 0, false, 'agent timed out after 300s'),
];

const validate = async () => ({ validation: accepting(), heldout: null });

describe('orchestrator + change manifests (harness plan C)', () => {
  it('records an accepted Mod as a falsifiable prediction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-manifest-loop-'));
    try {
      const manifests = new ManifestStore(dir);
      const res = await runIteration({
        model: 'qwen',
        records: TIMEOUTS,
        profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
        validate,
        manifests,
        validatedAt: '2026-07-31T00:00:00Z',
      });
      expect(res.accepted).toHaveLength(1);
      const open = manifests.open();
      expect(open).toHaveLength(1);
      // The tasks the weakness was mined from ARE the claim the edit is making.
      expect(open[0].predictedFixes.sort()).toEqual(['a', 'b']);
      expect(open[0].touched).toEqual(['env:LLAMA_N_PREDICT']);
      // Nothing to attribute on the first iteration — no prior records.
      expect(res.reverted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REVERTS the change next round when its predicted fixes did not materialise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-manifest-loop-'));
    try {
      const manifests = new ManifestStore(dir);
      const first = await runIteration({
        model: 'qwen',
        records: TIMEOUTS,
        profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
        validate,
        manifests,
        validatedAt: 't1',
      });
      expect(first.profile.env.LLAMA_N_PREDICT).toBe('4096');

      // Round 2: the same tasks are still failing. The A/B said the Mod helped;
      // production says otherwise, and the manifest is what catches that.
      const second = await runIteration({
        model: 'qwen',
        records: TIMEOUTS,
        priorRecords: TIMEOUTS,
        profile: first.profile,
        validate: async () => ({ validation: accepting(), heldout: null }),
        manifests,
        validatedAt: 't2',
      });

      expect(second.reverted).toHaveLength(1);
      expect(second.reverted[0].decision.verdict).toBe('revert');
      expect(second.reverted[0].decision.reason).toMatch(/realised none/);
      // The revert is folded into the profile the caller will apply.
      expect(second.reverted[0].decision.revert).toMatchObject({ kind: 'env', to: '8192' });
      // And it is logged, not lost.
      expect(manifests.closed()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('KEEPS the change when the predicted fixes actually land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-manifest-loop-'));
    try {
      const manifests = new ManifestStore(dir);
      await runIteration({
        model: 'qwen',
        records: TIMEOUTS,
        profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
        validate,
        manifests,
        validatedAt: 't1',
      });

      const fixed = [rec('a', 0, true, null), rec('b', 0, true, null)];
      const second = await runIteration({
        model: 'qwen',
        records: fixed,
        priorRecords: TIMEOUTS,
        profile: { env: { LLAMA_N_PREDICT: '4096' }, scaffold: {}, middleware: {} },
        validate,
        manifests,
        validatedAt: 't2',
      });

      expect(second.reverted).toEqual([]);
      expect(manifests.closed()[0].decision.verdict).toBe('keep');
      expect(second.profile.env.LLAMA_N_PREDICT).toBe('4096');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('behaves exactly as before when no manifest store is supplied', async () => {
    const res = await runIteration({
      model: 'qwen',
      records: TIMEOUTS,
      profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
      validate,
    });
    expect(res.accepted).toHaveLength(1);
    expect(res.reverted).toEqual([]);
  });
});
