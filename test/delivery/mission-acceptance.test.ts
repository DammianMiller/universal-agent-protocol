/**
 * Mission acceptance gate (extracted from deliver.ts): primary-mode
 * execution/visual gating, per-root spec resolution, judge evidence notes,
 * and the secondary-mode churn breaker. All gate seams faked.
 */
import { describe, it, expect } from 'vitest';
import { buildMissionAcceptanceGate, type MissionAcceptanceDeps } from '../../src/delivery/mission-acceptance.js';
import { createSpecRegistry } from '../../src/delivery/spec-registry.js';
import type { AcceptanceResult } from '../../src/delivery/acceptance-judge.js';
import type { ExecutionResult } from '../../src/delivery/execution-gate.js';
import type { VisualVerdict, PageVisualReport } from '../../src/delivery/visual-gate.js';

const judgePass: AcceptanceResult = { passed: true, score: 1, criteria: [] };
const judgeFail: AcceptanceResult = { passed: false, score: 0.5, criteria: [] };

const execOk: ExecutionResult = { passed: true, exitCode: 0, outputTail: '', durationMs: 1 };
const execFail: ExecutionResult = { passed: false, exitCode: 1, outputTail: 'boom: exit 1', durationMs: 1 };
const visualOk: VisualVerdict = { passed: true, skipped: true, structural: false, feedback: '', pages: [], screenshotDir: null };
const renderedPage: PageVisualReport = {
  file: 'index.html',
  loaded: true,
  hasCanvas: true,
  distinctColors: 12,
  dominantRatio: 0.5,
  motionRatio: 0.42,
  expectsAnimation: true,
  runtimeErrors: [],
  failedRequests: [],
  screenshots: [],
  problems: [],
};

function makeDeps(over: Partial<MissionAcceptanceDeps>): MissionAcceptanceDeps {
  return {
    primary: false,
    specs: createSpecRegistry({ initialSpec: 'MISSION', sharedRoot: '/proj', flipLimit: 2 }),
    judgeExecutor: async () => '',
    judge: async () => judgePass,
    executionGate: async () => execOk,
    visualGate: async () => visualOk,
    userPathsNote: () => null,
    ...over,
  };
}

describe('buildMissionAcceptanceGate', () => {
  it('SECONDARY: hands the judge the objective-gates-green evidence note and the resolved spec', async () => {
    const judgeArgs: Array<{ spec: string; runtimeNote?: string }> = [];
    const specs = createSpecRegistry({ initialSpec: 'MISSION', sharedRoot: '/proj', flipLimit: 2 });
    specs.begin('/wt/task-1', 'TASK ONE SPEC');
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        specs,
        judge: async (opts) => {
          judgeArgs.push({ spec: opts.spec, runtimeNote: opts.runtimeNote });
          return judgePass;
        },
      })
    );
    const verdict = await gate('/wt/task-1');
    expect(verdict.passed).toBe(true);
    expect(judgeArgs[0].spec).toBe('TASK ONE SPEC'); // per-root resolution
    expect(judgeArgs[0].runtimeNote).toContain('ALL PASSED');
  });

  it('SECONDARY: the churn breaker overrides after the flip limit and the note fires', async () => {
    const notes: string[] = [];
    const specs = createSpecRegistry({ initialSpec: 'MISSION', sharedRoot: '/proj', flipLimit: 2 });
    specs.recordWrites('/proj', 3); // change evidence so the breaker can trip
    const gate = buildMissionAcceptanceGate(
      makeDeps({ specs, judge: async () => judgeFail, note: (l) => notes.push(l) })
    );
    const first = await gate('/proj');
    expect(first.passed).toBe(false); // flip 1 of 2 — judge verdict stands
    const second = await gate('/proj');
    expect(second.passed).toBe(true); // limit hit — gates win
    expect((second as { overridden?: boolean }).overridden).toBe(true);
    expect(notes.some((n) => n.includes('accepting on gates'))).toBe(true);
  });

  it('PRIMARY: a failed execution gate short-circuits — the judge is never consulted', async () => {
    let judgeCalls = 0;
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: true,
        executionGate: async () => execFail,
        judge: async () => {
          judgeCalls++;
          return judgePass;
        },
      })
    );
    const verdict = await gate('/proj');
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toContain('EXECUTION FAILED');
    expect(verdict.feedback).toContain('boom: exit 1');
    expect(judgeCalls).toBe(0);
  });

  it('SECONDARY: a STRUCTURAL visual failure blocks even though the objective gates are green', async () => {
    // The gap this closes: visual failures used to block in primary mode only, so
    // with real project gates present a page that THREW became a note handed to a
    // text judge — "the suite is green and the code loads" was enough to be
    // accepted, which is exactly what a stub satisfies.
    let judged = 0;
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: false,
        executionGate: async () => execOk,
        visualGate: async (): Promise<VisualVerdict> => ({
          passed: false,
          skipped: false,
          structural: true,
          feedback: 'uncaught runtime error: TypeError: Player.update is not a function',
          pages: [],
          screenshotDir: null,
        }),
        judge: async () => {
          judged++;
          return judgePass;
        },
      })
    );
    const verdict = await gate('/proj');
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toContain('TypeError');
    expect(judged).toBe(0); // never graded — the page is broken
  });

  it('SECONDARY: a GRADED visual failure stays advisory and reaches the judge', async () => {
    // The counterpart that must not regress: a scaffold epic rendering sparsely
    // is the case the non-final allowance exists for (run J, live).
    let judged = 0;
    const notes: Array<string | undefined> = [];
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: false,
        executionGate: async () => execOk,
        visualGate: async (): Promise<VisualVerdict> => ({
          passed: false,
          skipped: false,
          structural: false,
          feedback: 'canvas renders below the visual floor (1 distinct color < 3 required)',
          // A page carrying a real problem, so the runtimeNote assertion below can
          // actually demonstrate the finding reaching the judge. With `problems: []`
          // the note read "renders+animates OK" and proved nothing.
          pages: [{ ...renderedPage, distinctColors: 1, problems: ['canvas renders below the visual floor'] }],
          screenshotDir: null,
        }),
        judge: async (opts) => {
          judged++;
          notes.push(opts.runtimeNote);
          return judgePass;
        },
      })
    );
    const verdict = await gate('/proj');
    expect(judged).toBe(1);
    expect(verdict.passed).toBe(true);
    // Secondary mode used to discard the observation entirely; it is evidence now.
    expect(notes[0]).toContain('visual floor');
  });

  it('a SKIPPED visual gate never blocks, even when it reports structural', async () => {
    // The `skipped` guard is the fail-open the gate documents: no browser means no
    // verdict. Asserting it with `structural: false` exercised nothing — a change
    // dropping the guard would have started hard-blocking every machine without a
    // browser, and no test would have failed.
    for (const primary of [true, false]) {
      const gate = buildMissionAcceptanceGate(
        makeDeps({
          primary,
          executionGate: async () => execOk,
          visualGate: async (): Promise<VisualVerdict> => ({
            passed: false,
            skipped: true,
            structural: true,
            feedback: 'visual gate skipped: browser unavailable',
            pages: [],
            screenshotDir: null,
          }),
        })
      );
      expect((await gate('/proj')).passed).toBe(true);
    }
  });

  it('SECONDARY: a non-final epic is exempt, because its verdict is downgraded to passed', async () => {
    // A compliant SCAFFOLD epic emits `throw new Error("TODO")` bodies, which ARE
    // uncaught runtime errors — so scoping the non-final allowance to graded
    // findings only would have hard-failed every scaffold on its own deliverable.
    // Reading `!passed && structural` is what keeps that satisfiable.
    let judged = 0;
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: false,
        executionGate: async () => execOk,
        visualGate: async (): Promise<VisualVerdict> => ({
          passed: true, // the non-final downgrade already applied
          skipped: false,
          structural: true,
          feedback: 'NA: non-final epic — visual findings are advisory',
          pages: [renderedPage],
          screenshotDir: null,
        }),
        judge: async () => {
          judged++;
          return judgePass;
        },
      })
    );
    expect((await gate('/proj')).passed).toBe(true);
    expect(judged).toBe(1);
  });

  it('PRIMARY: a failed (non-skipped) visual gate blocks with its feedback', async () => {
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: true,
        visualGate: async (): Promise<VisualVerdict> =>
          ({ passed: false, skipped: false, structural: false, feedback: 'blank canvas for 3s', pages: [], screenshotDir: null }),
      })
    );
    const verdict = await gate('/proj');
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toBe('blank canvas for 3s');
  });

  it('PRIMARY: the visual observation summary becomes judge evidence; no breaker interference', async () => {
    const judgeNotes: Array<string | undefined> = [];
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: true,
        visualGate: async (): Promise<VisualVerdict> => ({
          passed: true,
          skipped: false,
          structural: false,
          feedback: '',
          pages: [renderedPage],
          screenshotDir: null,
        }),
        judge: async (opts) => {
          judgeNotes.push(opts.runtimeNote);
          return judgeFail; // primary mode: judge verdict stands, breaker never runs
        },
      })
    );
    const verdict = await gate('/proj');
    expect(judgeNotes[0]).toContain('Visual observation of the RUNNING artifact');
    expect(judgeNotes[0]).toContain('index.html');
    expect(verdict.passed).toBe(false); // no override in primary mode
    expect((verdict as { overridden?: boolean }).overridden).toBeUndefined();
  });

  it('PRIMARY: an unparseable judge result folds to the inconclusive keep-implementing verdict', async () => {
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: true,
        judge: async () => ({ passed: true, score: 1, criteria: [], parseError: 'no JSON found' }),
      })
    );
    const verdict = await gate('/proj');
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toContain('Acceptance inconclusive');
    expect(verdict.score).toBeUndefined(); // never saturate bestAcceptance on fail-open
  });
});

describe('fidelity-max vision convergence (run Y delivered-vs-verify divergence, 2026-07-19)', () => {
  const stubVisual = async () =>
    ({
      skipped: false,
      passed: true,
      structural: false,
      feedback: '',
      pages: [
        {
          file: 'index.html', loaded: true, hasCanvas: true, distinctColors: 3,
          dominantRatio: 0.9, motionRatio: 0, expectsAnimation: false,
          runtimeErrors: [], failedRequests: [], screenshots: ['/tmp/shot-a.png', '/tmp/shot-b.png'],
          problems: [],
        },
      ],
    }) as never;

  it('fails acceptance with the vision findings when the review is below threshold', async () => {
    const gate = buildMissionAcceptanceGate({
      primary: true,
      specs: createSpecRegistry({ initialSpec: 'a space shooter with a visible start screen', sharedRoot: '/tmp/x' }),
      judgeExecutor: async () => {
        throw new Error('judge must not run when vision blocks');
      },
      executionGate: (async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1, via: 'vm-dom' })) as never,
      visualGate: stubVisual,
      visionReview: async (_root, _spec, shots) => {
        expect(shots).toEqual(['/tmp/shot-b.png']);
        return 'VISION REVIEW FAILED — the rendered UI scores 2/10 (max-fidelity threshold 6).\n- empty bordered canvas';
      },
    });
    const r = await gate('/tmp/x');
    expect(r.passed).toBe(false);
    expect(r.feedback).toContain('VISION REVIEW FAILED');
    expect(r.feedback).toContain('empty bordered canvas');
  });

  it('runs the vision review in SECONDARY mode under max fidelity (breaks the self-gate catch-22)', async () => {
    const prev = process.env.UAP_FIDELITY;
    process.env.UAP_FIDELITY = 'max';
    try {
      let visionRan = false;
      const gate = buildMissionAcceptanceGate({
        primary: false, // objective gates exist (e.g. a red anti-vacuous self-gate)
        specs: createSpecRegistry({ initialSpec: 'a space shooter', sharedRoot: '/tmp/x' }),
        judgeExecutor: async () => {
          throw new Error('judge must not run when vision blocks');
        },
        executionGate: (async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1, via: 'vm-dom' })) as never,
        visualGate: stubVisual,
        userPathsNote: () => ({ note: 'User-path validation ALL PASSED (2 real-client journeys)', trusted: true }),
        visionReview: async () => {
          visionRan = true;
          return 'VISION REVIEW FAILED — the rendered UI scores 3/10 (max-fidelity threshold 6).\n- off-palette planets';
        },
      });
      const r = await gate('/tmp/x');
      expect(visionRan).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.feedback).toContain('VISION REVIEW FAILED');
    } finally {
      if (prev === undefined) delete process.env.UAP_FIDELITY;
      else process.env.UAP_FIDELITY = prev;
    }
  });

  it('does NOT grade aesthetics in secondary mode while user paths are FAILING (ordering)', async () => {
    const prev = process.env.UAP_FIDELITY;
    process.env.UAP_FIDELITY = 'max';
    try {
      let visionRan = false;
      const gate = buildMissionAcceptanceGate({
        primary: false,
        specs: createSpecRegistry({ initialSpec: 'a space shooter', sharedRoot: '/tmp/x' }),
        judgeExecutor: async () => ({ passed: false, verdict: 'reject', feedback: 'judge' }) as never,
        executionGate: (async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1, via: 'vm-dom' })) as never,
        visualGate: stubVisual,
        userPathsNote: () => ({ note: 'User-path validation FAILED: start (click) — the artifact does not work', trusted: true }),
        visionReview: async () => {
          visionRan = true;
          return 'VISION REVIEW FAILED';
        },
      });
      await gate('/tmp/x');
      expect(visionRan).toBe(false); // behavioral gate must pass before visual
    } finally {
      if (prev === undefined) delete process.env.UAP_FIDELITY;
      else process.env.UAP_FIDELITY = prev;
    }
  });

  it('proceeds to the acceptance judge when the vision review passes (null)', async () => {
    const gate = buildMissionAcceptanceGate({
      primary: true,
      specs: createSpecRegistry({ initialSpec: 'spec', sharedRoot: '/tmp/x' }),
      judgeExecutor: async () => JSON.stringify({ passed: true, requirements: [] }),
      executionGate: (async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1, via: 'vm-dom' })) as never,
      visualGate: stubVisual,
      visionReview: async () => null,
      judge: (async () => ({ passed: true, feedback: '', score: 1 })) as never,
    });
    const r = await gate('/tmp/x');
    expect(r.passed).toBe(true);
  });
});

describe('red-ladder acceptance (runAcceptanceDespiteLadder safety)', () => {
  const specs = () => createSpecRegistry({ initialSpec: 'a space shooter', sharedRoot: '/tmp/x' });

  it('does NOT tell the judge the gates passed when the ladder is RED', async () => {
    // The secondary-mode note used to assert "Objective project gates ALL PASSED"
    // unconditionally. Once acceptance can run on a red ladder that is a lie, and
    // it instructs the judge to treat FAILING build/test requirements as verified.
    let seenNote = '';
    const gate = buildMissionAcceptanceGate({
      primary: false,
      specs: specs(),
      judgeExecutor: (async () => '') as never,
      judge: (async (args: { runtimeNote?: string }) => {
        seenNote = args.runtimeNote ?? '';
        return { passed: false, verdict: 'reject', feedback: 'nope', score: 0, criteria: [] };
      }) as never,
      userPathsNote: () => null,
    });
    await gate('/tmp/x', { ladderPassed: false });
    expect(seenNote).toMatch(/FAILING/);
    expect(seenNote).not.toMatch(/ALL PASSED/);
  });

  it('still reports gates green when the ladder passed', async () => {
    let seenNote = '';
    const gate = buildMissionAcceptanceGate({
      primary: false,
      specs: specs(),
      judgeExecutor: (async () => '') as never,
      judge: (async (args: { runtimeNote?: string }) => {
        seenNote = args.runtimeNote ?? '';
        return { passed: true, verdict: 'accept', feedback: '', score: 1, criteria: [] };
      }) as never,
      userPathsNote: () => null,
    });
    await gate('/tmp/x', { ladderPassed: true });
    expect(seenNote).toMatch(/ALL PASSED/);
  });

  it('does not feed RED turns to the churn breaker', async () => {
    // The breaker means "gates say yes, judge keeps saying no — trust the gates".
    // Counting red turns poisons it: it only resets on a PASSING verdict, so once
    // tripped it force-accepts every later turn, including the one where the
    // ladder finally goes green — delivering with the judge still rejecting.
    let breakerCalls = 0;
    const reg = specs();
    const realBreaker = reg.breaker.bind(reg);
    const spied = {
      ...reg,
      breaker: (spec: string, root: string) => {
        const b = realBreaker(spec, root);
        return {
          check: (s: string, v: { passed: boolean; feedback: string }) => {
            breakerCalls++;
            return b.check(s, v);
          },
        };
      },
    } as never;

    const gate = buildMissionAcceptanceGate({
      primary: false,
      specs: spied,
      judgeExecutor: (async () => '') as never,
      judge: (async () => ({ passed: false, verdict: 'reject', feedback: 'nope', score: 0, criteria: [] })) as never,
      userPathsNote: () => null,
    });

    await gate('/tmp/x', { ladderPassed: false });
    expect(breakerCalls).toBe(0); // red turn: not the breaker's business

    await gate('/tmp/x', { ladderPassed: true });
    expect(breakerCalls).toBe(1); // green turn: counted as before
  });
});
