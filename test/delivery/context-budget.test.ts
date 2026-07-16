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
  discoverModelContextWindow,
  estimateMessagesTokens,
  CONTEXT_BUDGET_MARKER,
  DEFAULT_SESSION_TOKEN_BUDGET,
  SESSION_WORKING_FRACTION,
  formatBudgetStop,
  decodeBudgetStop,
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

  it('discovered live window beats the preset but loses to env/config', () => {
    expect(resolveSessionTokenBudget({ modelContextBudget: 180000 }, undefined, 200000)).toBe(200000);
    expect(
      resolveSessionTokenBudget(
        { modelContextBudget: 180000 },
        { deliver: { sessionTokenBudget: 100000 } },
        200000
      )
    ).toBe(100000);
    process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET = '150000';
    expect(resolveSessionTokenBudget({ modelContextBudget: 180000 }, undefined, 200000)).toBe(150000);
    delete process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET;
  });

  it('an insane discovered value falls through to the preset', () => {
    expect(resolveSessionTokenBudget({ modelContextBudget: 180000 }, undefined, 10)).toBe(180000);
  });
});

describe('discoverModelContextWindow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads context_window from the proxy /v1/context', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: String(url).includes('/v1/context'),
      json: async () => ({ context_window: 180224 }),
    })));
    expect(await discoverModelContextWindow('http://127.0.0.1:4000/v1')).toBe(180224);
  });

  it('falls back to llama /props n_ctx when /v1/context is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/v1/context')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 131072 } }) };
    }));
    expect(await discoverModelContextWindow('http://127.0.0.1:8080/v1')).toBe(131072);
  });

  it('returns undefined when nothing is reachable (fail-soft → preset)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await discoverModelContextWindow('http://127.0.0.1:9999/v1')).toBeUndefined();
  });

  it('returns undefined for a missing or invalid endpoint', async () => {
    expect(await discoverModelContextWindow(undefined)).toBeUndefined();
    expect(await discoverModelContextWindow('not-a-url')).toBeUndefined();
  });

  it('rejects an insane discovered value (below the sanity floor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ context_window: 10 }) })));
    expect(await discoverModelContextWindow('http://x/v1')).toBeUndefined();
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
          return { success: false, summary: `${CONTEXT_BUDGET_MARKER} session reached budget`, turns: 2, budgetStopped: true };
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

  it('the deprecated MARKER-only summary no longer triggers a split (v1.153 deprecation executed)', async () => {
    let splitAsked = false;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      // marker in the summary but NO structured budgetStopped field
      runEpic: async () => ({ success: false, summary: `${CONTEXT_BUDGET_MARKER} over budget`, turns: 1 }),
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
      runEpic: async () => ({ success: false, summary: `${CONTEXT_BUDGET_MARKER} over budget`, turns: 1, budgetStopped: true }),
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
        if (epic.id === 'big') return { success: false, summary: `${CONTEXT_BUDGET_MARKER} over`, turns: 1, budgetStopped: true };
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
        if (epic.id === 'big') return { success: false, summary: `${CONTEXT_BUDGET_MARKER} x`, turns: 1, budgetStopped: true };
        return ok(`${epic.id} done`);
      },
      splitEpic: async () => [
        { id: 'a', title: 'A', goal: 'a' },
        { id: 'b', title: 'B', goal: 'b' },
      ],
    });
    expect(priorsSeen['big.a'].some((p) => p.includes('First'))).toBe(true);
  });

  it('(#5) splits on an ordinary (non-budget) failure when splitOnAnyFailure is set', async () => {
    let splitAsked = false;
    const ran: string[] = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      splitOnAnyFailure: true,
      runEpic: async (epic) => {
        ran.push(epic.id);
        if (epic.id === 'e') return { success: false, summary: 'tests failed', turns: 1 };
        return ok(`${epic.id} done`);
      },
      splitEpic: async () => {
        splitAsked = true;
        return [
          { id: 'a', title: 'A', goal: 'a' },
          { id: 'b', title: 'B', goal: 'b' },
        ];
      },
    });
    expect(splitAsked).toBe(true); // auto-escalation: give-up became a re-split
    expect(ran).toEqual(['e', 'e.a', 'e.b']);
    expect(res.success).toBe(true);
  });

  it('(#4c) recurses splitDepth levels — a sub-epic that still overflows is split again', async () => {
    let splitCalls = 0;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      splitDepth: 2,
      // only leaf pieces (two namespaced levels deep, e.g. big.a.a) pass; the
      // parent and the first-level pieces overflow their budget.
      runEpic: async (epic) =>
        /\.[a-z]\.[a-z]$/.test(epic.id)
          ? ok(`${epic.id} done`)
          : { success: false, summary: `${CONTEXT_BUDGET_MARKER} over`, turns: 1, budgetStopped: true },
      splitEpic: async () => {
        splitCalls++;
        return [
          { id: 'a', title: 'A', goal: 'a' },
          { id: 'b', title: 'B', goal: 'b' },
        ];
      },
    });
    expect(splitCalls).toBeGreaterThan(1); // split at level 1 AND again at level 2
    expect(res.success).toBe(true);
  });
});


describe('budget-stop wire protocol codec', () => {
  it('formatBudgetStop output round-trips through decodeBudgetStop', () => {
    const out = formatBudgetStop({ estimatedTokens: 9000, budget: 5734, rounds: 3, summaries: ['built a', 'built b'] });
    expect(decodeBudgetStop(out)).toBe(true);
    expect(out.startsWith(CONTEXT_BUDGET_MARKER)).toBe(true);
    expect(out).toContain('~9000 of 5734');
    expect(out).toContain('after 3 round(s)');
    expect(out).toContain('built a; built b');
  });

  it('formatBudgetStop keeps only the last 5 summaries and handles none', () => {
    const many = formatBudgetStop({ estimatedTokens: 1, budget: 1, rounds: 1, summaries: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] });
    expect(many).not.toContain('s1;');
    expect(many).toContain('s3; s4; s5; s6; s7');
    const none = formatBudgetStop({ estimatedTokens: 1, budget: 1, rounds: 0, summaries: [] });
    expect(none).toContain('Work completed so far: none');
  });

  it('decodeBudgetStop: false on plain/empty/undefined; wrapper-prefix tolerant within the window', () => {
    expect(decodeBudgetStop('all tests green, delivered')).toBe(false);
    expect(decodeBudgetStop('')).toBe(false);
    expect(decodeBudgetStop(undefined)).toBe(false);
    expect(decodeBudgetStop(null)).toBe(false);
    // Wrappers may prepend a short preamble — still decodes.
    expect(decodeBudgetStop(`wrapper preamble\n${CONTEXT_BUDGET_MARKER} session reached budget`)).toBe(true);
  });

  it('decodeBudgetStop: a marker ECHOED deep in the output never tags a non-budget turn', () => {
    const echo = `${'progress report. '.repeat(64)}the previous turn said ${CONTEXT_BUDGET_MARKER} but this turn completed fine`;
    expect(decodeBudgetStop(echo)).toBe(false);
  });
});
