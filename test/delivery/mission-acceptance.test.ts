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
const visualOk: VisualVerdict = { passed: true, skipped: true, feedback: '', pages: [], screenshotDir: null };
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

  it('PRIMARY: a failed (non-skipped) visual gate blocks with its feedback', async () => {
    const gate = buildMissionAcceptanceGate(
      makeDeps({
        primary: true,
        visualGate: async (): Promise<VisualVerdict> =>
          ({ passed: false, skipped: false, feedback: 'blank canvas for 3s', pages: [], screenshotDir: null }),
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
