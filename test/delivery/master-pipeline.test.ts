/**
 * master-pipeline tests — pin the resolved composition of the deliver master
 * pipeline (fan-out → evidence loops → state-hash dedup → adversarial gate)
 * and its one-line readout, without driving a full deliver run.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMasterPipeline,
  formatMasterPipelineLine,
} from '../../src/delivery/master-pipeline.js';
import { DEFAULT_PARALLEL_TASKS } from '../../src/delivery/task-workspace.js';
import { STATE_HASH_DEFAULT_MIN_BYTES } from '../../src/delivery/agentic-executor.js';
import { DEFAULT_ADVERSARIAL_ROUNDS } from '../../src/delivery/adversarial-gate.js';

/** An env with every pipeline knob explicitly absent, so a developer's
 * exported shell vars cannot pollute the assertions. */
const CLEAN_ENV: NodeJS.ProcessEnv = {
  UAP_DELIVER_PARALLEL_TASKS: undefined,
  UAP_DELIVER_STATE_HASH: undefined,
  UAP_DELIVER_STATE_HASH_MIN_BYTES: undefined,
  UAP_DELIVER_ADVERSARIAL_GATE: undefined,
  UAP_DELIVER_CRITERIA_LINT: undefined,
  UAP_DELIVER_EVIDENCE_GATE: undefined,
};

describe('resolveMasterPipeline', () => {
  it('resolves the defaults: parallel fan-out, state-hash dedup, and the adversarial gate all ON', () => {
    const p = resolveMasterPipeline(undefined, CLEAN_ENV);
    expect(p.parallelTasks).toBe(DEFAULT_PARALLEL_TASKS);
    expect(p.parallelTasks).toBeGreaterThan(1); // parallel is the default topology
    expect(p.stateHash).toBe(true);
    expect(p.stateHashMinBytes).toBe(STATE_HASH_DEFAULT_MIN_BYTES);
    expect(p.adversarial.enabled).toBe(true);
    expect(p.adversarial.maxRounds).toBe(DEFAULT_ADVERSARIAL_ROUNDS);
  });

  it('honors the escape hatches: env disables each stage independently', () => {
    const p = resolveMasterPipeline(undefined, {
      ...CLEAN_ENV,
      UAP_DELIVER_PARALLEL_TASKS: '1',
      UAP_DELIVER_STATE_HASH: '0',
      UAP_DELIVER_ADVERSARIAL_GATE: '0',
    });
    expect(p.parallelTasks).toBe(1);
    expect(p.stateHash).toBe(false);
    expect(p.adversarial.enabled).toBe(false);
  });

  it('env beats .uap.json, and .uap.json beats the default', () => {
    const fromConfig = resolveMasterPipeline(
      { parallelTasks: 2, adversarialGate: 3 },
      CLEAN_ENV
    );
    expect(fromConfig.parallelTasks).toBe(2);
    expect(fromConfig.adversarial.maxRounds).toBe(3);

    const envWins = resolveMasterPipeline(
      { parallelTasks: 2, adversarialGate: 3 },
      { ...CLEAN_ENV, UAP_DELIVER_PARALLEL_TASKS: '6', UAP_DELIVER_ADVERSARIAL_GATE: '1' }
    );
    expect(envWins.parallelTasks).toBe(6);
    expect(envWins.adversarial.maxRounds).toBe(1);
  });

  it('retunes the state-hash floor and falls back to the default on garbage', () => {
    expect(
      resolveMasterPipeline(undefined, { ...CLEAN_ENV, UAP_DELIVER_STATE_HASH_MIN_BYTES: '4096' })
        .stateHashMinBytes
    ).toBe(4096);
    expect(
      resolveMasterPipeline(undefined, { ...CLEAN_ENV, UAP_DELIVER_STATE_HASH_MIN_BYTES: 'abc' })
        .stateHashMinBytes
    ).toBe(STATE_HASH_DEFAULT_MIN_BYTES);
  });

  it('shares the executor floor semantics exactly: negative, fractional, and empty fall back', () => {
    // The readout CALLS stateHashMinBytes (readCountEnv) instead of mirroring
    // it — a mirrored copy previously printed "≥-5B" while the executor ran
    // at the 1024 default. Pin the shared semantics so they cannot drift again.
    for (const bad of ['-5', '1.5', '', '  ']) {
      expect(
        resolveMasterPipeline(undefined, { ...CLEAN_ENV, UAP_DELIVER_STATE_HASH_MIN_BYTES: bad })
          .stateHashMinBytes
      ).toBe(STATE_HASH_DEFAULT_MIN_BYTES);
    }
    // 0 is a legal count-env value (floor of zero: every repeat collapses).
    expect(
      resolveMasterPipeline(undefined, { ...CLEAN_ENV, UAP_DELIVER_STATE_HASH_MIN_BYTES: '0' })
        .stateHashMinBytes
    ).toBe(0);
  });
});

describe('formatMasterPipelineLine', () => {
  it('names every stage in pipeline order with its effective setting', () => {
    const line = formatMasterPipelineLine(resolveMasterPipeline(undefined, CLEAN_ENV));
    expect(line).toContain(`fan-out ×${DEFAULT_PARALLEL_TASKS}`);
    expect(line).toContain('evidence loops');
    expect(line).toContain(`state-hash dedup on (≥${STATE_HASH_DEFAULT_MIN_BYTES}B)`);
    expect(line).toContain(`adversarial gate on (≤${DEFAULT_ADVERSARIAL_ROUNDS} rounds)`);
    // order: fan-out → loops → dedup → adversarial
    expect(line.indexOf('fan-out')).toBeLessThan(line.indexOf('evidence loops'));
    expect(line.indexOf('evidence loops')).toBeLessThan(line.indexOf('state-hash'));
    expect(line.indexOf('state-hash')).toBeLessThan(line.indexOf('adversarial gate'));
  });

  it('reflects disabled stages as off', () => {
    const line = formatMasterPipelineLine(
      resolveMasterPipeline(undefined, {
        ...CLEAN_ENV,
        UAP_DELIVER_STATE_HASH: '0',
        UAP_DELIVER_ADVERSARIAL_GATE: '0',
      })
    );
    expect(line).toContain('state-hash dedup off');
    expect(line).toContain('adversarial gate off');
  });
});

describe('evidence-gates stages (criteria lint C + delivery evidence B)', () => {
  it('reports both ON by default and in the readout line, after the adversarial stage', () => {
    // `{}` deliverCfg (not undefined): a provided-but-keyless config resolves
    // to the default WITHOUT reading the repo's own .uap.json — hermetic
    // (correctness-review finding 9).
    const p = resolveMasterPipeline({}, CLEAN_ENV);
    expect(p.criteriaLint).toBe(true);
    expect(p.evidenceGate).toBe(true);
    const line = formatMasterPipelineLine(p);
    expect(line).toContain('criteria lint on');
    expect(line).toContain('evidence gate on');
    expect(line.indexOf('adversarial gate')).toBeLessThan(line.indexOf('criteria lint'));
  });

  it('reflects the env kill-switches as off', () => {
    const line = formatMasterPipelineLine(
      resolveMasterPipeline(undefined, {
        ...CLEAN_ENV,
        UAP_DELIVER_CRITERIA_LINT: '0',
        UAP_DELIVER_EVIDENCE_GATE: '0',
      })
    );
    expect(line).toContain('criteria lint off');
    expect(line).toContain('evidence gate off');
  });
});
