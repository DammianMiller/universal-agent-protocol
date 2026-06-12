import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import { createEscalationController } from '../../src/delivery/escalation.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

const RUNGS: GateRung[] = [
  { id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 },
];

function output(content: string): string {
  return `\`\`\`file:solution.txt\n${content}\n\`\`\``;
}

describe('ConvergenceLoop directives + practices', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-loop45-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readSolution(): string | null {
    const p = join(dir, 'solution.txt');
    return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null;
  }
  function contentLadder(): LadderResult {
    const c = readSolution();
    const passed = c === 'correct';
    return { passed, score: passed ? 1 : 0, feedback: `content: ${c}`, results: [] };
  }

  it('switches executor on a directive (model escalation)', async () => {
    const weakCalls: string[] = [];
    const strong = async (): Promise<string> => output('correct');

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 4,
        rungs: RUNGS,
        baselineCheck: false,
        onIteration: (rec) => (rec.turn === 1 ? { switchExecutor: strong } : undefined),
      },
      async () => {
        weakCalls.push('weak');
        return output('wrong');
      },
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2); // weak fails turn 1, strong passes turn 2
    expect(weakCalls).toHaveLength(1);
  });

  it('raises the turn budget on a directive', async () => {
    let attempt = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: RUNGS,
        baselineCheck: false,
        // On turn 1, grant 2 more turns; model only succeeds on turn 2
        onIteration: (rec) => (rec.turn === 1 ? { raiseMaxTurns: 3 } : undefined),
      },
      async () => {
        attempt++;
        return attempt >= 2 ? output('correct') : output('wrong');
      },
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
  });

  it('enables the critic mid-run via criticFactory', async () => {
    let criticBuilt = 0;
    const prompts: string[] = [];

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: RUNGS,
        baselineCheck: false,
        criticFactory: () => {
          criticBuilt++;
          return async () => ({ fixList: ['solution.txt: write correct'] });
        },
        onIteration: (rec) => (rec.turn === 1 ? { enableCritic: true } : undefined),
      },
      async (prompt) => {
        prompts.push(prompt);
        return prompt.includes('REPAIR PLAN') ? output('correct') : output('wrong');
      },
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    expect(criticBuilt).toBe(1);
    expect(prompts[1]).toContain('REPAIR PLAN');
  });

  it('injects retrieved practices into the prompt', async () => {
    const prompts: string[] = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: RUNGS,
        baselineCheck: false,
        practiceProvider: () => ['Lead with a direct approach.', 'Verify against gates early.'],
      },
      async (prompt) => {
        prompts.push(prompt);
        return output('correct');
      },
      { ladderRunner: contentLadder }
    );

    await loop.deliver('task');
    expect(prompts[0]).toContain('PROVEN PRACTICES');
    expect(prompts[0]).toContain('Lead with a direct approach.');
  });

  it('setCandidates directive switches a single-shot loop into explorer mode mid-run', async () => {
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: RUNGS,
        baselineCheck: false,
        onIteration: (rec) => (rec.turn === 1 ? { setCandidates: 2 } : undefined),
      },
      async () => output('wrong'), // never passes; we only assert mode switch
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    // Turn 1 single-shot (no candidates array), turn 2 onward explorer mode
    expect(result.history[0].candidates).toBeUndefined();
    expect(result.history[1].candidates).toHaveLength(2);
  });

  it('honors a stop directive on a non-passing turn', async () => {
    let calls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 5,
        rungs: RUNGS,
        baselineCheck: false,
        onIteration: () => ({ stop: true }),
      },
      async () => {
        calls++;
        return output('wrong');
      },
      { ladderRunner: contentLadder }
    );
    const result = await loop.deliver('task');
    expect(calls).toBe(1);
    expect(result.turns).toBe(1);
    expect(result.success).toBe(false);
  });

  it('fails soft when the practice provider throws', async () => {
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: RUNGS,
        baselineCheck: false,
        practiceProvider: () => {
          throw new Error('retrieval down');
        },
      },
      async () => output('correct'),
      { ladderRunner: contentLadder }
    );
    const result = await loop.deliver('task');
    expect(result.success).toBe(true); // provider failure did not block delivery
  });

  it('injects practices on retry turns, not just turn 1', async () => {
    const prompts: string[] = [];
    let run = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 2,
        rungs: RUNGS,
        baselineCheck: false,
        practiceProvider: () => ['Verify against gates early.'],
      },
      async (prompt) => {
        prompts.push(prompt);
        return run++ === 0 ? output('wrong') : output('correct');
      },
      { ladderRunner: contentLadder }
    );
    await loop.deliver('task');
    expect(prompts[0]).toContain('Verify against gates early.');
    expect(prompts[1]).toContain('Verify against gates early.'); // retry keeps practices
  });

  it('end-to-end: escalation controller drives a model switch on stagnation', async () => {
    const strong = async (): Promise<string> => output('correct');
    const escalation = createEscalationController({
      tiers: [{ label: 'stronger model', switchExecutor: strong }],
      stagnationTurns: 2,
    });

    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 6,
        rungs: RUNGS,
        baselineCheck: false,
        onIteration: (rec) => escalation.onIteration(rec),
      },
      async () => output('wrong'), // weak model never succeeds
      { ladderRunner: contentLadder }
    );

    const result = await loop.deliver('task');
    expect(result.success).toBe(true);
    // turn1 best=0, turn2 stagnant#1, turn3 stagnant#2→escalate (applies next
    // turn), turn4 strong model passes
    expect(result.turns).toBe(4);
    expect(readSolution()).toBe('correct');
  });
});
