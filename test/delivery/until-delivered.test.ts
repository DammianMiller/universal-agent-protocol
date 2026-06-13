import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { LadderResult } from '../../src/delivery/verifier-ladder.js';

const block = (path: string, content: string): string => ['```file:' + path, content, '```'].join('\n');
const RUNGS = [{ id: 'g', name: 'gate', command: 'true', required: true }];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'until-deliv-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

describe('untilDelivered loop autonomy', () => {
  it('extends past maxTurns and succeeds when a late turn passes', async () => {
    const dir = makeProject();
    try {
      let turn = 0;
      // improves slowly, only passes on turn 8 — past the default maxTurns of 3
      const ladderRunner = (): LadderResult => {
        turn++;
        const passed = turn >= 8;
        return { passed, score: passed ? 1 : turn * 0.1, results: [], feedback: passed ? '' : 'red' };
      };
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 3,
          baselineCheck: false,
          protectTests: false,
          untilDelivered: true,
          maxTurnsCeiling: 20,
        },
        async () => block('src/impl.mjs', `export const v = ${turn};`),
        { ladderRunner }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(true);
      expect(result.turns).toBeGreaterThanOrEqual(8); // looped past maxTurns=3
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at the ceiling when gates never pass (no infinite loop)', async () => {
    const dir = makeProject();
    try {
      let turn = 0;
      // keeps improving slightly each turn (never stagnates) but never passes
      const ladderRunner = (): LadderResult => {
        turn++;
        return { passed: false, score: Math.min(0.99, turn * 0.02), results: [], feedback: 'red' };
      };
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 2,
          baselineCheck: false,
          protectTests: false,
          untilDelivered: true,
          maxTurnsCeiling: 12,
        },
        async () => block('src/impl.mjs', `export const v = ${turn};`),
        { ladderRunner }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(false);
      expect(result.turns).toBe(12); // extended exactly to the ceiling, then stopped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts early on stagnation rather than running to the ceiling', async () => {
    const dir = makeProject();
    try {
      // score never improves past turn 1 → stagnation guard stops extension
      const ladderRunner = (): LadderResult => ({
        passed: false,
        score: 0.3,
        results: [],
        feedback: 'red',
      });
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 2,
          baselineCheck: false,
          protectTests: false,
          untilDelivered: true,
          maxTurnsCeiling: 30,
        },
        async () => block('src/impl.mjs', 'export const v = 1;'),
        { ladderRunner }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(false);
      // turn1 sets best (0.3 > -1); turns 2-5 are non-improving (stagnant 1..4);
      // extension stops once stagnant reaches STAGNATION_LIMIT=4 → exactly 5 turns.
      expect(result.turns).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never extends when maxTurns already equals the ceiling', async () => {
    const dir = makeProject();
    try {
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 4,
          baselineCheck: false,
          protectTests: false,
          untilDelivered: true,
          maxTurnsCeiling: 4, // == maxTurns: nothing to extend into
        },
        async () => block('src/impl.mjs', 'export const v = 1;'),
        { ladderRunner: () => ({ passed: false, score: 0.5, results: [], feedback: 'red' }) }
      );
      const result = await loop.deliver('build it');
      expect(result.turns).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalation raiseMaxTurns cannot push past the ceiling under untilDelivered', async () => {
    const dir = makeProject();
    try {
      let turn = 0;
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: RUNGS,
          maxTurns: 2,
          baselineCheck: false,
          protectTests: false,
          untilDelivered: true,
          maxTurnsCeiling: 6,
          // an escalation-style hook trying to blow the budget wide open
          onIteration: () => ({ raiseMaxTurns: 100 }),
        },
        async () => {
          turn++;
          return block('src/impl.mjs', `export const v = ${turn};`);
        },
        { ladderRunner: () => ({ passed: false, score: 0.5, results: [], feedback: 'red' }) }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(false);
      expect(result.turns).toBe(6); // clamped to the ceiling, not 100
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without untilDelivered, stops at maxTurns (default behavior preserved)', async () => {
    const dir = makeProject();
    try {
      const loop = new ConvergenceLoop(
        { projectRoot: dir, rungs: RUNGS, maxTurns: 3, baselineCheck: false, protectTests: false },
        async () => block('src/impl.mjs', 'export const v = 1;'),
        { ladderRunner: () => ({ passed: false, score: 0.5, results: [], feedback: 'red' }) }
      );
      const result = await loop.deliver('build it');
      expect(result.success).toBe(false);
      expect(result.turns).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
