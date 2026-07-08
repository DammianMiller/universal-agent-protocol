/**
 * Context auto-size (rail-fit sizing): budget resolution, the planner budget
 * hint, the agentic executor's hard budget stop, and the epic controller's
 * split-and-retry path keyed off CONTEXT_BUDGET_MARKER.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveSessionTokenBudget,
  sessionWorkingBudget,
  estimateMessagesTokens,
  CONTEXT_BUDGET_MARKER,
  DEFAULT_SESSION_TOKEN_BUDGET,
  SESSION_WORKING_FRACTION,
} from '../../src/delivery/context-budget.js';
import { planDeliveryPhases } from '../../src/delivery/decompose.js';
import { runEpics, type Epic, type EpicRunResult } from '../../src/delivery/epic-controller.js';
import { createAgenticExecutor } from '../../src/delivery/agentic-executor.js';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { LadderResult } from '../../src/delivery/verifier-ladder.js';

const ok = (summary: string, turns = 1): EpicRunResult => ({ success: true, summary, turns });

describe('resolveSessionTokenBudget', () => {
  afterEach(() => {
    delete process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET;
  });

  it('env var wins over config and model', () => {
    process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET = '150000';
    const budget = resolveSessionTokenBudget(
      { modelContextBudget: 180000, maxContextTokens: 262144 },
      { deliver: { sessionTokenBudget: 100000 } }
    );
    expect(budget).toBe(150000);
  });

  it('config beats model preset; preset budget beats maxContextTokens; default is last', () => {
    expect(
      resolveSessionTokenBudget(
        { modelContextBudget: 180000, maxContextTokens: 262144 },
        { deliver: { sessionTokenBudget: 100000 } }
      )
    ).toBe(100000);
    expect(resolveSessionTokenBudget({ modelContextBudget: 180000, maxContextTokens: 262144 })).toBe(180000);
    expect(resolveSessionTokenBudget({ maxContextTokens: 262144 } as never)).toBe(262144);
    expect(resolveSessionTokenBudget()).toBe(DEFAULT_SESSION_TOKEN_BUDGET);
  });

  it('rejects insane values (too small / NaN) and falls through', () => {
    process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET = '12'; // below sanity floor
    expect(resolveSessionTokenBudget({ modelContextBudget: 180000, maxContextTokens: 262144 })).toBe(180000);
  });

  it('sessionWorkingBudget applies the prune-threshold-aligned fraction', () => {
    expect(sessionWorkingBudget(180000)).toBe(Math.floor(180000 * SESSION_WORKING_FRACTION));
  });
});

describe('estimateMessagesTokens', () => {
  it('counts content and serialized tool calls', () => {
    const est = estimateMessagesTokens([
      { content: 'x'.repeat(4000) },
      { content: null, tool_calls: [{ function: { name: 'run', arguments: 'y'.repeat(400) } }] },
    ]);
    expect(est).toBeGreaterThan(1000); // 4000 chars ≈ 1000 tokens
    expect(est).toBeLessThan(1300);
  });
});

describe('planDeliveryPhases — session budget hint', () => {
  it('includes the context limit in the planning prompt when a budget is set', async () => {
    let seenPrompt = '';
    await planDeliveryPhases(
      'build the thing end to end',
      async (prompt) => {
        seenPrompt = prompt;
        return '[]';
      },
      undefined,
      { sessionTokenBudget: 126000 }
    );
    expect(seenPrompt).toContain('126000 tokens');
    expect(seenPrompt).toContain('MORE, SMALLER phases');
  });

  it('omits the hint when no budget is set', async () => {
    let seenPrompt = '';
    await planDeliveryPhases('build the thing', async (prompt) => {
      seenPrompt = prompt;
      return '[]';
    });
    expect(seenPrompt).not.toContain('CONTEXT LIMIT');
  });
});

describe('createAgenticExecutor — context budget stop', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops with the marker before sending an over-budget request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxb-'));
    try {
      const fetchSpy = vi.spyOn(global, 'fetch');
      const exec = createAgenticExecutor({ id: 'm', apiModel: 'm' } as never, {
        projectRoot: dir,
        endpoint: 'http://localhost:9/v1',
        contextTokenBudget: 10, // prompt alone exceeds this
      });
      const out = await exec('a prompt long enough to exceed ten estimated tokens easily'.repeat(3));
      expect(out).toContain(CONTEXT_BUDGET_MARKER);
      expect(out).toContain('too large for one session');
      expect(fetchSpy).not.toHaveBeenCalled(); // never sent the doomed request
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ConvergenceLoop — budgetStopped tagging', () => {
  it('marks history records whose executor session was budget-stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxb-loop-'));
    try {
      const ladder = (): LadderResult => ({
        passed: false,
        score: 0,
        feedback: 'gates red',
        results: [{ id: 't', name: 't', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: 'fail' }],
      });
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          maxTurns: 1,
          baselineCheck: false,
          alwaysVerify: true,
          rungs: [{ id: 't', name: 't', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }],
        },
        async () => `${CONTEXT_BUDGET_MARKER} session reached ~9000 of 5734 estimated tokens after 3 round(s)`,
        { applier: async () => ({ filesWritten: [], rejected: [] }), ladderRunner: ladder }
      );
      const result = await loop.deliver('x');
      expect(result.history[0].budgetStopped).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runEpics — split on context-budget exhaustion', () => {
  it('re-plans an over-budget epic into sub-epics and accepts when they all pass', async () => {
    const ran: string[] = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'do everything' }],
      maxAttemptsPerEpic: 1,
      runEpic: async (epic) => {
        ran.push(epic.id);
        if (epic.id === 'big') {
          return { success: false, summary: `${CONTEXT_BUDGET_MARKER} session reached budget`, turns: 2 };
        }
        return ok(`${epic.id} done`);
      },
      splitEpic: async (epic) => [
        { id: 'part-1', title: 'Part 1', goal: `${epic.goal} (first half)` },
        { id: 'part-2', title: 'Part 2', goal: `${epic.goal} (second half)` },
      ],
    });
    expect(ran).toEqual(['big', 'big.part-1', 'big.part-2']);
    expect(res.success).toBe(true);
    expect(res.completed).toContain('big');
    // sub-epic outcomes are surfaced alongside the parent's
    expect(res.outcomes.map((o) => o.epicId)).toEqual(['big.part-1', 'big.part-2', 'big']);
    expect(res.turns).toBe(4); // 2 (failed big) + 1 + 1 (sub-epics), not double-counted
  });

  it('does NOT split on ordinary (non-budget) failures', async () => {
    let splitAsked = false;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      runEpic: async () => ({ success: false, summary: 'tests failed', turns: 1 }),
      splitEpic: async () => {
        splitAsked = true;
        return [
          { id: 'a', title: 'A', goal: 'a' },
          { id: 'b', title: 'B', goal: 'b' },
        ];
      },
    });
    expect(splitAsked).toBe(false);
    expect(res.success).toBe(false);
  });

  it('splits only one level deep — a sub-epic that still overflows fails', async () => {
    let splitCalls = 0;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      runEpic: async () => ({ success: false, summary: `${CONTEXT_BUDGET_MARKER} over budget`, turns: 1 }),
      splitEpic: async () => {
        splitCalls++;
        return [
          { id: 's1', title: 'S1', goal: 's1' },
          { id: 's2', title: 'S2', goal: 's2' },
        ];
      },
    });
    expect(splitCalls).toBe(1); // sub-epics never re-split
    expect(res.success).toBe(false);
  });

  it('later sub-epics run despite an earlier partial failure, and a green final piece delivers the epic', async () => {
    const ran: string[] = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'three modules' }],
      maxAttemptsPerEpic: 1,
      runEpic: async (epic) => {
        ran.push(epic.id);
        if (epic.id === 'big') return { success: false, summary: `${CONTEXT_BUDGET_MARKER} over`, turns: 1 };
        // pieces 1 and 2 fail full-project gates (whole not assembled yet);
        // piece 3 completes the assembly and gates go green
        return epic.id.endsWith('p3') ? ok('assembled, gates green') : { success: false, summary: 'gates still red', turns: 1 };
      },
      splitEpic: async () => [
        { id: 'p1', title: 'P1', goal: 'module 1' },
        { id: 'p2', title: 'P2', goal: 'module 2' },
        { id: 'p3', title: 'P3', goal: 'module 3' },
      ],
    });
    // all three pieces ran (no dep-chain skipping after p1's partial failure)
    expect(ran).toEqual(['big', 'big.p1', 'big.p2', 'big.p3']);
    expect(res.completed).toContain('big'); // final piece green => epic delivered
  });

  it('sub-epics see prior summaries from epics completed before the split', async () => {
    const priorsSeen: Record<string, string[]> = {};
    await runEpics({
      mission: 'm',
      epics: [
        { id: 'first', title: 'First', goal: 'f' },
        { id: 'big', title: 'Big', goal: 'g', deps: ['first'] },
      ],
      maxAttemptsPerEpic: 1,
      runEpic: async (epic, ctx) => {
        priorsSeen[epic.id] = ctx.priorSummaries;
        if (epic.id === 'big') return { success: false, summary: `${CONTEXT_BUDGET_MARKER} x`, turns: 1 };
        return ok(`${epic.id} done`);
      },
      splitEpic: async () => [
        { id: 'a', title: 'A', goal: 'a' },
        { id: 'b', title: 'B', goal: 'b' },
      ],
    });
    expect(priorsSeen['big.a'].some((p) => p.includes('First'))).toBe(true);
  });
});
