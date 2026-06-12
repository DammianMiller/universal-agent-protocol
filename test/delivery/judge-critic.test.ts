import { describe, it, expect } from 'vitest';
import { createModelJudge, extractJson } from '../../src/delivery/judge.js';
import { createModelCritic, parseFixList } from '../../src/delivery/critic.js';
import type { JudgeCandidate } from '../../src/delivery/judge.js';
import type { IterationRecord } from '../../src/delivery/convergence-loop.js';

function candidates(): JudgeCandidate[] {
  return [
    { id: 'c1', strategy: 'direct', output: 'solution A', ladderFeedback: '', score: 0.5 },
    { id: 'c2', strategy: 'rewrite', output: 'solution B', ladderFeedback: '', score: 0.5 },
  ];
}

function failedRecord(): IterationRecord {
  return {
    turn: 1,
    passed: false,
    score: 0.5,
    gateResults: [
      { id: 'build', name: 'Build', passed: true, skipped: false, exitCode: 0, durationMs: 1, outputTail: '' },
      { id: 'test', name: 'Tests', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: 'expect(add(2,3)).toBe(5) failed' },
    ],
    filesApplied: ['src/util.ts'],
    durationMs: 10,
  };
}

describe('judge', () => {
  it('extractJson tolerates prose and fences around the object', () => {
    expect(extractJson('Here you go:\n```json\n{"winner": "c2", "rationale": "x"}\n```')).toEqual({
      winner: 'c2',
      rationale: 'x',
    });
    expect(extractJson('no json at all')).toBeNull();
    expect(extractJson('{broken')).toBeNull();
  });

  it('picks the candidate named by the model verdict', async () => {
    const judge = createModelJudge(async (prompt) => {
      expect(prompt).toContain('CANDIDATE c1');
      expect(prompt).toContain('CANDIDATE c2');
      return '{"winner": "c2", "rationale": "cleaner"}';
    });
    const verdict = await judge('task', candidates());
    expect(verdict).toEqual({ winnerId: 'c2', rationale: 'cleaner' });
  });

  it('falls back to the first candidate on garbage, unknown winner, or executor error', async () => {
    const garbage = createModelJudge(async () => 'I think both are nice');
    expect((await garbage('task', candidates())).winnerId).toBe('c1');

    const unknown = createModelJudge(async () => '{"winner": "c99"}');
    expect((await unknown('task', candidates())).winnerId).toBe('c1');

    const broken = createModelJudge(async () => {
      throw new Error('down');
    });
    expect((await broken('task', candidates())).winnerId).toBe('c1');
  });
});

describe('critic', () => {
  it('parseFixList extracts numbered steps in both 1. and 1) styles', () => {
    const text = [
      'Here is the plan:',
      '1. src/util.ts: export add as a named function',
      '2) test/util.test.ts: fix the import path',
      'not a step',
      '3.   src/index.ts: re-export add',
    ].join('\n');
    expect(parseFixList(text)).toEqual([
      'src/util.ts: export add as a named function',
      'test/util.test.ts: fix the import path',
      'src/index.ts: re-export add',
    ]);
  });

  it('uses the failing gate persona and returns the parsed fix list', async () => {
    const prompts: string[] = [];
    const critic = createModelCritic(async (prompt) => {
      prompts.push(prompt);
      return '1. src/util.ts: return a + b instead of a - b';
    });

    const critique = await critic({
      instruction: 'implement add',
      record: failedRecord(),
      feedback: 'Tests FAIL: expect(add(2,3)).toBe(5)',
      attemptOutput: 'function add(a,b){return a-b}',
    });

    expect(critique.focusGate).toBe('test');
    expect(critique.fixList).toEqual(['src/util.ts: return a + b instead of a - b']);
    expect(prompts[0]).toContain('test-failure analyst');
    expect(prompts[0]).toContain('src/util.ts');
  });

  it('parseFixList stays linear on a pathological all-space line (no ReDoS)', () => {
    const evil = `1.${' '.repeat(100_000)}`;
    const start = Date.now();
    const result = parseFixList(evil);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toEqual([]); // no non-space content after the spaces
  });

  it('fails soft to an empty fix list when the executor errors', async () => {
    const critic = createModelCritic(async () => {
      throw new Error('down');
    });
    const critique = await critic({
      instruction: 'x',
      record: failedRecord(),
      feedback: 'f',
      attemptOutput: 'o',
    });
    expect(critique.fixList).toEqual([]);
    expect(critique.focusGate).toBe('test');
  });
});
