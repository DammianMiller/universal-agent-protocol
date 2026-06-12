import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

const RUNGS: GateRung[] = [
  { id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 },
];

function output(content: string): string {
  return `\`\`\`file:solution.txt\n${content}\n\`\`\``;
}

describe('ConvergenceLoop with explorer (Phase 2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-loop2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readSolution(): string | null {
    const path = join(dir, 'solution.txt');
    return existsSync(path) ? readFileSync(path, 'utf-8').trim() : null;
  }

  function contentLadder(): LadderResult {
    const content = readSolution();
    const passed = content === 'correct';
    return { passed, score: passed ? 1 : 0, feedback: `content: ${content}`, results: [] };
  }

  it('converges in one turn when any candidate passes, recording the winning strategy', async () => {
    // Candidate prompts get different strategy seeds; the 'test-first' seeded
    // candidate (2nd) emits the correct solution.
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: RUNGS,
        baselineCheck: false,
        explorer: { candidates: 3 },
      },
      async (prompt) => (prompt.includes('failing gates first') ? output('correct') : output('wrong')),
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('write the solution');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.history[0].strategy).toBe('test-first');
    expect(result.history[0].candidates).toHaveLength(3);
    expect(readSolution()).toBe('correct');
  });

  it('passes critic repair steps into the next turn prompt (Phase 3)', async () => {
    const prompts: string[] = [];
    let attempt = 0;

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: RUNGS,
        baselineCheck: false,
        critic: async (input) => {
          expect(input.instruction).toBe('write the solution');
          return { fixList: ['solution.txt: write the word correct'], focusGate: 'test' };
        },
      },
      async (prompt) => {
        prompts.push(prompt);
        attempt++;
        // Only complies once the repair plan appears
        return prompt.includes('REPAIR PLAN') ? output('correct') : output('wrong');
      },
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('write the solution');
    expect(result.success).toBe(true);
    expect(attempt).toBe(2);
    expect(prompts[1]).toContain('REPAIR PLAN — apply these fixes exactly:');
    expect(prompts[1]).toContain('1. solution.txt: write the word correct');
  });

  it('does not call the critic on the final turn (output would be unused)', async () => {
    let criticCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 2,
        rungs: RUNGS,
        baselineCheck: false,
        critic: async () => {
          criticCalls++;
          return { fixList: ['x: y'] };
        },
      },
      async () => output('wrong'), // never converges
      { ladderRunner: contentLadder }
    );

    await loop.deliver('task');
    // 2 turns, both fail — critic should fire only after turn 1, not turn 2
    expect(criticCalls).toBe(1);
  });

  it('continues with raw feedback when the critic fails soft', async () => {
    const prompts: string[] = [];
    let run = 0;

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 2,
        rungs: RUNGS,
        baselineCheck: false,
        critic: async () => {
          throw new Error('critic down');
        },
      },
      async (prompt) => {
        prompts.push(prompt);
        return run++ === 0 ? output('wrong') : output('correct');
      },
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    expect(prompts[1]).not.toContain('REPAIR PLAN');
    expect(prompts[1]).toContain('content: wrong');
  });
});
