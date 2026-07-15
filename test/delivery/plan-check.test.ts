/**
 * Pre-execution plan validation (ATG thought experiment): structural DAG
 * checks, verdict parsing (fail-soft), and the model-facing review calls.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePhaseGraph,
  parsePlanVerdict,
  runPlanThoughtExperiment,
  reviewPlanText,
} from '../../src/delivery/plan-check.js';
import type { DeliveryPhase } from '../../src/delivery/decompose.js';

const p = (id: string, deps?: string[], goal = `do ${id}`): DeliveryPhase => ({
  id,
  title: id,
  goal,
  ...(deps ? { deps } : {}),
});

describe('validatePhaseGraph (structural)', () => {
  it('passes a well-formed DAG', () => {
    const v = validatePhaseGraph([p('a'), p('b', ['a']), p('c', ['a', 'b'])]);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('flags a dependency cycle as an error', () => {
    const v = validatePhaseGraph([p('a', ['b']), p('b', ['a'])]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('cycle');
  });

  it('flags self-deps and duplicate ids as errors, unknown deps as warnings', () => {
    const v = validatePhaseGraph([p('a', ['a']), p('a'), p('b', ['ghost'])]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('depends on itself');
    expect(v.errors.join(' ')).toContain('duplicate phase id');
    expect(v.warnings.join(' ')).toContain("unknown phase 'ghost'");
  });

  it('flags an empty goal', () => {
    const v = validatePhaseGraph([p('a', undefined, '  '), p('b')]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('empty goal');
  });
});

describe('parsePlanVerdict (fail-soft)', () => {
  it('parses a fail verdict with findings', () => {
    const v = parsePlanVerdict('noise {"verdict":"fail","findings":["step 2 needs the schema from step 3"]} noise');
    expect(v.verdict).toBe('fail');
    expect(v.findings).toEqual(['step 2 needs the schema from step 3']);
  });

  it('treats anything unparseable or non-fail as pass', () => {
    expect(parsePlanVerdict('total garbage').verdict).toBe('pass');
    expect(parsePlanVerdict('{"verdict":"maybe"}').verdict).toBe('pass');
    expect(parsePlanVerdict('{broken json').verdict).toBe('pass');
  });

  it('filters non-string findings and caps their count', () => {
    const findings = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const v = parsePlanVerdict(JSON.stringify({ verdict: 'fail', findings: [42, '', ...findings] }));
    expect(v.findings.length).toBeLessThanOrEqual(8);
    expect(v.findings[0]).toBe('f0');
  });
});

describe('runPlanThoughtExperiment', () => {
  const phases = [p('a'), p('b', ['a'])];

  it('surfaces a fail verdict from the evaluator', async () => {
    let prompt = '';
    const v = await runPlanThoughtExperiment('build the thing', phases, async (pr) => {
      prompt = pr;
      return '{"verdict":"fail","findings":["phase b consumes an API no phase defines"]}';
    });
    expect(v.verdict).toBe('fail');
    expect(v.findings[0]).toContain('phase b');
    // the evaluator saw the mission and the dependency-annotated plan
    expect(prompt).toContain('build the thing');
    expect(prompt).toContain('[b] b');
    expect(prompt).toContain('deps: a');
  });

  it('fail-softs to pass when the evaluator throws', async () => {
    const v = await runPlanThoughtExperiment('m', phases, async () => {
      throw new Error('model down');
    });
    expect(v).toEqual({ verdict: 'pass', findings: [] });
  });
});

describe('reviewPlanText', () => {
  it('reviews free-text plans with the same verdict contract', async () => {
    let prompt = '';
    const v = await reviewPlanText('1. deploy\n2. build\n3. test', async (pr) => {
      prompt = pr;
      return '{"verdict":"fail","findings":["deploys before building"]}';
    });
    expect(v.verdict).toBe('fail');
    expect(v.findings).toEqual(['deploys before building']);
    expect(prompt).toContain('1. deploy'); // the judge saw the plan text
  });

  it('fail-softs to pass on executor error', async () => {
    const v = await reviewPlanText('plan', async () => {
      throw new Error('down');
    });
    expect(v).toEqual({ verdict: 'pass', findings: [] });
  });
});

describe('thought-experiment serialization (round-2 follow-up)', () => {
  it('the judge sees criteria and contracts/scaffold tags', async () => {
    let prompt = '';
    await runPlanThoughtExperiment(
      'mission',
      [
        { id: 'c', title: 'Contracts', goal: 'define types', contracts: true },
        { id: 'k', title: 'Skeleton', goal: 'stub it', scaffold: true, deps: ['c'], criteria: ['compiles with stub bodies'] },
      ],
      async (pr) => {
        prompt = pr;
        return '{"verdict":"pass","findings":[]}';
      }
    );
    expect(prompt).toContain('[CONTRACTS]');
    expect(prompt).toContain('[SCAFFOLD]');
    expect(prompt).toContain('criteria: compiles with stub bodies');
  });
});
