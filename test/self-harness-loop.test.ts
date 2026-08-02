import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunRecord } from '../src/benchmarks/paired/types.js';
import type { Comparison } from '../src/benchmarks/paired/report.js';
import { classifyFailure, mineFromRecords } from '../src/self-harness/mine.js';
import { heuristicProposer } from '../src/self-harness/propose.js';
import { decideAccept } from '../src/self-harness/decide.js';
import { applyEnvModToFile, profileFromEnvFile } from '../src/self-harness/profile.js';
import { runIteration } from '../src/self-harness/orchestrator.js';
import type { EnvMod } from '../src/self-harness/mods.js';

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

function comparison(meanDelta: number, significant: boolean, netGain = 0): Comparison {
  return {
    label: 'with-mod', baseline: 'baseline',
    correctness: {
      // See self-harness-run.test.ts: a held-out baseline of 0 means no
      // regression is detectable, which is no longer accepted as "clean".
      baselineRate: 0.5, treatmentRate: 0.5 + meanDelta,
      delta: { meanDelta, ci: { lower: 0, upper: 0 }, pValue: 0.5, n: 10, significant },
      mcnemar: { bothCorrect: 0, onlyTreatment: Math.max(0, netGain), onlyBaseline: Math.max(0, -netGain), bothWrong: 0, netGain, pValue: 0.5, n: 10 },
    },
    metrics: {},
  };
}

describe('mine — failure classification', () => {
  it('classifies timeout / verify-fail / loop / success', () => {
    expect(classifyFailure(rec('t', 0, true, null))).toBeNull();
    expect(classifyFailure(rec('t', 0, false, 'agent timed out after 300s'))).toBe('agent.timeout');
    expect(classifyFailure(rec('t', 0, false, 'verify failed (exit 1)', 5))).toBe('verify.fail');
    expect(classifyFailure(rec('t', 0, false, 'verify failed (exit 1)', 44))).toBe('loop.nonterminate');
  });

  it('aggregates + ranks weaknesses by frequency x impact', () => {
    const records = [
      rec('a', 0, false, 'agent timed out after 300s'),
      rec('b', 0, false, 'agent timed out after 300s'),
      rec('c', 0, false, 'verify failed (exit 1)', 5),
    ];
    const w = mineFromRecords(records, { model: 'qwen3.6-35b-a3b' });
    expect(w[0].kind).toBe('agent.timeout'); // freq 2 × 2 tasks = 4 > verify.fail 1×1
    expect(w[0].signature).toHaveLength(16);
  });
});

describe('propose — heuristic', () => {
  it('proposes a minimal n-predict cut for runaway timeouts', () => {
    const w = mineFromRecords([rec('a', 0, false, 'agent timed out after 300s')], { model: 'm' });
    const profile = { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} };
    const mods = heuristicProposer.propose(w, profile);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' });
  });
});

describe('decide — accept gate', () => {
  it('accepts a significant validation lift with clean held-out', () => {
    const d = decideAccept(comparison(0.2, true), comparison(0.0, false));
    expect(d.verdict).toBe('accept');
  });
  it('rejects when no validation lift', () => {
    expect(decideAccept(comparison(0.0, false), null).verdict).toBe('reject');
  });
  it('rejects on a significant held-out regression despite validation lift', () => {
    const d = decideAccept(comparison(0.2, true), comparison(-0.3, true));
    expect(d.verdict).toBe('reject');
    expect(d.reason).toMatch(/held-out regression/);
  });
  it('accepts on positive McNemar net even if CI not significant', () => {
    expect(decideAccept(comparison(0.05, false, 2), null).verdict).toBe('accept');
  });
});

describe('profile — env apply/revert round-trip', () => {
  it('replaces an existing knob and reports the prior value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-'));
    const f = join(dir, 'llama-server.env');
    writeFileSync(f, '# header\nLLAMA_N_PREDICT=8192\nLLAMA_REPEAT_PENALTY=1.08\n');
    const mod: EnvMod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    const { priorValue } = applyEnvModToFile(f, mod);
    expect(priorValue).toBe('8192');
    expect(readFileSync(f, 'utf-8')).toContain('LLAMA_N_PREDICT=4096');
    expect(profileFromEnvFile(f).env.LLAMA_N_PREDICT).toBe('4096');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('orchestrator — full iteration (stubbed validator)', () => {
  it('re-discovers the n-predict cut: mine -> propose -> validate(accept) -> commit', async () => {
    const records = [
      rec('a', 0, false, 'agent timed out after 300s'),
      rec('b', 0, false, 'agent timed out after 300s'),
    ];
    // Stub validator: the n-predict cut "helps" (significant +0.3), anything else no lift.
    const validate = async (mod: { kind: string }) =>
      mod.kind === 'env'
        ? { validation: comparison(0.3, true), heldout: comparison(0.0, false) }
        : { validation: comparison(0.0, false), heldout: null };
    const res = await runIteration({
      model: 'qwen3.6-35b-a3b',
      records,
      profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
      validate,
    });
    expect(res.weaknesses[0].kind).toBe('agent.timeout');
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]).toMatchObject({ kind: 'env', key: 'LLAMA_N_PREDICT', to: '4096' });
    expect(res.profile.env.LLAMA_N_PREDICT).toBe('4096'); // committed to profile
  });

  it('rejects (and does not commit) when validation shows no lift', async () => {
    const validate = async () => ({ validation: comparison(0.0, false), heldout: null });
    const res = await runIteration({
      model: 'm',
      records: [rec('a', 0, false, 'agent timed out after 300s')],
      profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
      validate,
    });
    expect(res.accepted).toHaveLength(0);
    expect(res.profile.env.LLAMA_N_PREDICT).toBe('8192'); // unchanged
  });
});
