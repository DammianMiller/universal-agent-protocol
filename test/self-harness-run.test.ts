import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunRecord } from '../src/benchmarks/paired/types.js';
import type { Comparison } from '../src/benchmarks/paired/report.js';
import type { EnvMod } from '../src/self-harness/mods.js';
import {
  buildValidator,
  compare,
  nullComparison,
  BASELINE_LABEL,
  CANDIDATE_LABEL,
} from '../src/self-harness/validate.js';
import { runSelfHarnessLoop } from '../src/self-harness/run.js';
import { loadProfileSnapshot } from '../src/self-harness/profile.js';
import type { ValidationOutcome } from '../src/self-harness/orchestrator.js';

function rec(taskId: string, seed: number, condition: string, correct: boolean): RunRecord {
  return {
    taskId,
    condition,
    seed,
    metrics: {
      correct, error: correct ? null : 'verify failed (exit 1)', turns: 1,
      tokens: null, costUsd: null, toolCalls: null, latencyMs: 1000, wellFormed: true,
    },
    adapter: 'mock',
    model: 'test-model',
  } as RunRecord;
}

const TASKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function comparison(meanDelta: number, significant: boolean, netGain = 0): Comparison {
  return {
    label: CANDIDATE_LABEL, baseline: BASELINE_LABEL,
    correctness: {
      baselineRate: 0, treatmentRate: meanDelta,
      delta: { meanDelta, ci: { lower: 0, upper: 0 }, pValue: 0.5, n: 8, significant },
      mcnemar: { bothCorrect: 0, onlyTreatment: Math.max(0, netGain), onlyBaseline: Math.max(0, -netGain), bothWrong: 0, netGain, pValue: 0.5, n: 8 },
      verdict: 'tie',
    },
    metrics: {}, metricVerdicts: {},
  };
}

describe('validate — compare + nullComparison', () => {
  it('compare pairs baseline vs candidate into a positive-delta Comparison', () => {
    const records = TASKS.flatMap((t) => [rec(t, 0, BASELINE_LABEL, false), rec(t, 0, CANDIDATE_LABEL, true)]);
    const cmp = compare(records, { seed: 1, iterations: 2000 });
    expect(cmp.label).toBe(CANDIDATE_LABEL);
    expect(cmp.correctness.delta.meanDelta).toBeGreaterThan(0);
    expect(cmp.correctness.delta.significant).toBe(true); // all-wrong -> all-right, CI excludes 0
  });

  it('nullComparison is a no-lift tie (rejectable)', () => {
    const c = nullComparison();
    expect(c.correctness.delta.meanDelta).toBe(0);
    expect(c.correctness.delta.significant).toBe(false);
    expect(c.correctness.mcnemar.netGain).toBe(0);
  });
});

describe('buildValidator — env Mod A/B applies + reverts + restarts', () => {
  it('applies the Mod before the candidate arm, reverts after, restarts each arm boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-val-'));
    const envPath = join(dir, 'llama-server.env');
    writeFileSync(envPath, '# hdr\nLLAMA_N_PREDICT=8192\n');

    let restarts = 0;
    let sawDuringCandidate = '';
    const runArm = async (_suite: string, label: string): Promise<RunRecord[]> => {
      if (label === CANDIDATE_LABEL) sawDuringCandidate = readFileSync(envPath, 'utf-8');
      // Baseline all-wrong, candidate all-right => a clean, significant lift.
      return TASKS.map((t) => rec(t, 0, label, label === CANDIDATE_LABEL));
    };

    const validate = buildValidator({
      suiteDir: 'unused', envPath,
      restart: async () => { restarts += 1; },
      runArm, analyzeOpts: { seed: 1, iterations: 2000 }, heldoutDir: null,
    });

    const mod: EnvMod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    const out: ValidationOutcome = await validate(mod);

    // The candidate arm ran with the Mod applied...
    expect(sawDuringCandidate).toContain('LLAMA_N_PREDICT=4096');
    // ...and the env file was reverted afterwards.
    expect(readFileSync(envPath, 'utf-8')).toContain('LLAMA_N_PREDICT=8192');
    // One suite (held-out skipped) => apply+restart, revert+restart = 2.
    expect(restarts).toBe(2);
    expect(out.validation.correctness.delta.meanDelta).toBeGreaterThan(0);
    expect(out.heldout).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not auto-validate a non-env Mod (returns a rejectable null comparison)', async () => {
    const validate = buildValidator({
      suiteDir: 'x', envPath: 'x', restart: async () => {},
      runArm: async () => { throw new Error('runArm must not be called for non-env Mods'); },
    });
    const out = await validate({ kind: 'middleware', id: 'toolcall-path-normalizer', params: {} });
    expect(out.validation.correctness.delta.significant).toBe(false);
    expect(out.heldout).toBeNull();
  });
});

describe('runSelfHarnessLoop — commit + versioned snapshot', () => {
  const timeoutRecs: RunRecord[] = [
    rec('a', 0, 'baseline', false), rec('b', 0, 'baseline', false),
  ].map((r) => ({ ...r, metrics: { ...r.metrics, error: 'agent timed out after 300s', correct: false } }));

  const acceptEnv = async (mod: { kind: string }): Promise<ValidationOutcome> =>
    mod.kind === 'env'
      ? { validation: comparison(0.4, true), heldout: comparison(0.0, false) }
      : { validation: nullComparison(), heldout: null };

  it('apply=true physically commits the env Mod + writes snapshot + history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-run-'));
    const envPath = join(dir, 'llama-server.env');
    writeFileSync(envPath, 'LLAMA_N_PREDICT=8192\n');
    const snapshotPath = join(dir, 'profile.json');
    const historyPath = join(dir, 'history.jsonl');

    let restarts = 0;
    const res = await runSelfHarnessLoop({
      model: 'qwen3.6', records: timeoutRecs,
      profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
      validate: acceptEnv, now: '2026-07-06T00:00:00Z', apply: true,
      envPath, snapshotPath, historyPath, restart: async () => { restarts += 1; },
    });

    expect(res.persisted).toBe(true);
    expect(res.committed).toHaveLength(1);
    expect(restarts).toBe(1); // one restart after committing the accepted env Mods
    // Env file physically updated to the accepted value.
    expect(readFileSync(envPath, 'utf-8')).toContain('LLAMA_N_PREDICT=4096');
    // Versioned snapshot written.
    const snap = loadProfileSnapshot(snapshotPath);
    expect(snap?.version).toBe(1);
    expect(snap?.profile.env.LLAMA_N_PREDICT).toBe('4096');
    expect(snap?.accepted[0]).toMatch(/LLAMA_N_PREDICT/);
    // History appended (one JSONL line).
    expect(readFileSync(historyPath, 'utf-8').trim().split('\n')).toHaveLength(1);

    // A second committing run increments the version.
    writeFileSync(envPath, 'LLAMA_N_PREDICT=4096\n');
    const res2 = await runSelfHarnessLoop({
      model: 'qwen3.6', records: timeoutRecs,
      profile: { env: { LLAMA_N_PREDICT: '4096' }, scaffold: {}, middleware: {} },
      validate: acceptEnv, now: '2026-07-06T01:00:00Z', apply: true,
      envPath, snapshotPath, historyPath, restart: async () => {},
    });
    expect(res2.snapshot?.version).toBe(2);
    expect(readFileSync(historyPath, 'utf-8').trim().split('\n')).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('apply=false is a pure dry-run: nothing is persisted or restarted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-dry-'));
    const envPath = join(dir, 'llama-server.env');
    writeFileSync(envPath, 'LLAMA_N_PREDICT=8192\n');
    const snapshotPath = join(dir, 'profile.json');

    let restarts = 0;
    const res = await runSelfHarnessLoop({
      model: 'qwen3.6', records: timeoutRecs,
      profile: { env: { LLAMA_N_PREDICT: '8192' }, scaffold: {}, middleware: {} },
      validate: acceptEnv, now: '2026-07-06T00:00:00Z', apply: false,
      envPath, snapshotPath, restart: async () => { restarts += 1; },
    });

    expect(res.persisted).toBe(false);
    expect(res.committed).toHaveLength(0);
    expect(restarts).toBe(0);
    expect(readFileSync(envPath, 'utf-8')).toContain('LLAMA_N_PREDICT=8192'); // untouched
    expect(existsSync(snapshotPath)).toBe(false);
    // The iteration still reports what it WOULD have accepted.
    expect(res.iteration.accepted).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
