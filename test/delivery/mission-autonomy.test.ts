import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop, defaultPromptBuilder } from '../../src/delivery/convergence-loop.js';
import type { LadderResult } from '../../src/delivery/verifier-ladder.js';

const block = (path: string, content: string): string => ['```file:' + path, content, '```'].join('\n');
const RUNGS = [{ id: 'g', name: 'gate', command: 'true', required: true }];

describe('autonomy contract (prompt)', () => {
  it('instructs the model not to stop or ask questions, and to complete the whole task', () => {
    const p = defaultPromptBuilder({ instruction: 'do it', turn: 1 });
    expect(p).toMatch(/never stop to ask questions/i);
    expect(p).toMatch(/do not hand back partial work|pause between steps/i);
    expect(p).toMatch(/complete the entire task/i);
    // progress-update expectation is part of the contract
    expect(p).toMatch(/progress note/i);
  });
});

describe('guidance section (prompt)', () => {
  it('renders operator guidance prominently when present', () => {
    const p = defaultPromptBuilder({ instruction: 'do it', turn: 2, guidance: 'prefer a ring buffer' });
    expect(p).toContain('OPERATOR GUIDANCE');
    expect(p).toContain('prefer a ring buffer');
    expect(p).toMatch(/do NOT stop/i);
  });

  it('omits the guidance section when there is none', () => {
    const p = defaultPromptBuilder({ instruction: 'do it', turn: 1 });
    expect(p).not.toContain('OPERATOR GUIDANCE');
  });
});

describe('autonomy toggle (prompt)', () => {
  it('includes the autonomy policy by default and when autonomous is true', () => {
    expect(defaultPromptBuilder({ instruction: 'x', turn: 1 })).toContain('MISSION AUTONOMY');
    expect(defaultPromptBuilder({ instruction: 'x', turn: 1, autonomous: true })).toContain('MISSION AUTONOMY');
  });

  it('omits the autonomy policy when autonomous is false (opt-out)', () => {
    const p = defaultPromptBuilder({ instruction: 'x', turn: 1, autonomous: false });
    expect(p).not.toContain('MISSION AUTONOMY');
    expect(p).not.toMatch(/never stop to ask/i);
    // output-format contract still present
    expect(p).toContain('OUTPUT FORMAT');
  });
});

describe('guidanceProvider (loop)', () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mission-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    return dir;
  }

  it('polls guidance each turn and injects it into the prompt, without stopping', async () => {
    const dir = makeProject();
    try {
      const prompts: string[] = [];
      let turn = 0;
      // never passes until turn 3, so we get multiple guidance polls
      const ladderRunner = (): LadderResult =>
        turn >= 3
          ? { passed: true, score: 1, results: [], feedback: '' }
          : { passed: false, score: 0, results: [], feedback: 'red' };

      let polls = 0;
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 4,
          baselineCheck: false,
          protectTests: false,
          guidanceProvider: () => {
            polls++;
            return polls >= 2 ? 'use approach B' : undefined; // guidance appears mid-run
          },
        },
        async (prompt) => {
          prompts.push(prompt);
          turn++;
          return block('src/impl.mjs', `export const v = ${turn};`);
        },
        { ladderRunner }
      );

      const result = await loop.deliver('build it');
      expect(polls).toBeGreaterThanOrEqual(2);
      // turn 1 had no guidance; a later turn carries the injected guidance
      expect(prompts[0]).not.toContain('OPERATOR GUIDANCE');
      expect(prompts.some((p) => p.includes('use approach B'))).toBe(true);
      // the loop kept running through the guidance change to completion
      expect(result.success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects guidance from turn 1 (async provider) into the first prompt', async () => {
    const dir = makeProject();
    try {
      const prompts: string[] = [];
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 1,
          baselineCheck: false,
          protectTests: false,
          guidanceProvider: async () => 'use a state machine', // async + present from turn 1
        },
        async (prompt) => {
          prompts.push(prompt);
          return block('src/impl.mjs', 'export const v = 1;');
        },
        { ladderRunner: () => ({ passed: true, score: 1, results: [], feedback: '' }) }
      );
      const result = await loop.deliver('build it');
      expect(prompts[0]).toContain('use a state machine');
      expect(result.success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is fail-soft: a throwing guidance provider does not stop the mission', async () => {
    const dir = makeProject();
    try {
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 1,
          baselineCheck: false,
          protectTests: false,
          guidanceProvider: () => {
            throw new Error('provider blew up');
          },
        },
        async () => block('src/impl.mjs', 'export const v = 1;'),
        { ladderRunner: () => ({ passed: true, score: 1, results: [], feedback: '' }) }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
