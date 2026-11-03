/**
 * team-solve-deliver — the wrapper extracted from deliver.ts's dispatch
 * block (ADR 0014). The deps-injection exists so THIS suite could: the
 * aggregation is pure and pinned branch-by-branch, and the loop/role seams
 * are driven exactly as the workflow engine drives them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  aggregateTeamSolveResult,
  assertTeamSolveDeliverShape,
  loopOutcome,
  runTeamSolveDeliver,
  TEAM_SOLVE_DELIVER_STEPS,
  type TeamSolveDeps,
} from '../../src/delivery/team-solve-deliver.js';
import type { ConvergenceConfig, ConvergenceLoop, DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { RunWorkflowOptions, WorkflowRunResult } from '../../src/workflow/runner.js';
import { parseWorkflowDef, type LoadedWorkflow } from '../../src/workflow/types.js';
import { ModelPresets } from '../../src/models/types.js';

function mkResult(partial: Partial<DeliveryResult>): DeliveryResult {
  return {
    success: false,
    alreadyDelivered: false,
    turns: 3,
    bestScore: 0.83,
    bestTurn: 2,
    history: [],
    finalFeedback: 'typecheck failed in src/x.ts',
    finalOutput: 'the final turn output',
    totalDurationMs: 1000,
    ...partial,
  };
}

function mkWorkflow(ids: string[] = [...TEAM_SOLVE_DELIVER_STEPS]): LoadedWorkflow {
  const kinds: Record<string, string> = {
    plan: 'agent',
    'ideate-a': 'agent',
    'ideate-b': 'agent',
    solve: 'loop',
    review: 'agent',
    repair: 'loop',
    verify: 'loop',
  };
  const def = parseWorkflowDef({
    name: 'team-solve-deliver',
    steps: ids.map((id) => ({
      id,
      kind: kinds[id] ?? 'agent',
      goal: `goal for ${id}`,
      requires: [],
      ...(id === 'verify' ? { verifyOnly: true } : {}),
    })),
  });
  return { dir: '/bundled/team-solve-deliver', def, rolePrompts: new Map() };
}

describe('loopOutcome (the one-line report the reviewer actually receives)', () => {
  it('reports green honestly: turns, baseline-green, changed tree, feedback tail', () => {
    expect(loopOutcome(mkResult({ success: true, alreadyDelivered: true, changedTree: false }))).toBe(
      'gates GREEN after 3 turn(s) (baseline already green); typecheck failed in src/x.ts'
    );
  });

  it('reports failure with the best gate score and truncates the tail', () => {
    const r = loopOutcome(mkResult({ success: false, changedTree: true, finalFeedback: 'x'.repeat(400) }));
    expect(r).toContain('NOT delivered after 3 turn(s) — best 83% of gates');
    expect(r).toContain('tree changed');
    expect(r).toContain('x'.repeat(150));
    expect(r).not.toContain('x'.repeat(151));
  });
});

describe('assertTeamSolveDeliverShape (fail-closed on role drift)', () => {
  it('accepts the canonical step set', () => {
    expect(() => assertTeamSolveDeliverShape(mkWorkflow())).not.toThrow();
  });
  it('refuses a renamed/added step — the wrong rail must never run silently', () => {
    expect(() =>
      assertTeamSolveDeliverShape(mkWorkflow(['plan', 'ideate-a', 'ideate-b', 'solve', 'review', 'repair', 'final']))
    ).toThrow(/shape drifted/);
  });
});

describe('aggregateTeamSolveResult (PURE — the branches that regress silently)', () => {
  const base = {
    verifyPassed: true,
    verifySummary: '4 gates green (verify-only pass)',
    projectRoot: '/proj',
    ledgerDir: '/proj/.uap/workflow-runs/team-solve-deliver-1',
  };

  it('roles failing before the solve loop → honest synthetic failure, not a crash', () => {
    const r = aggregateTeamSolveResult({
      ...base,
      wf: { status: 'failed', failed: ['plan', 'ideate-a', 'ideate-b', 'solve', 'review', 'repair', 'verify'] },
    });
    expect(r.success).toBe(false);
    expect(r.turns).toBe(0);
    // Skip-cascaded descendants never ran — phrased honestly, not "failed".
    expect(r.finalFeedback).toContain('not completed: plan');
    expect(r.finalOutput).toBe('');
  });

  it('success is the workflow status AND the verify pass — either alone is not delivery', () => {
    const solved = mkResult({ success: true });
    expect(aggregateTeamSolveResult({ ...base, wf: { status: 'succeeded', failed: [] }, solveResult: solved }).success).toBe(true);
    expect(
      aggregateTeamSolveResult({ ...base, verifyPassed: false, wf: { status: 'succeeded', failed: [] }, solveResult: solved })
        .success
    ).toBe(false);
    expect(aggregateTeamSolveResult({ ...base, wf: { status: 'failed', failed: ['verify'] }, solveResult: solved }).success).toBe(
      false
    );
  });

  it('histories concatenate, turns sum, the repair (last loop) carries best score', () => {
    const solve = mkResult({ turns: 4, history: [{}, {}] as DeliveryResult['history'], bestScore: 0.5, bestTurn: 3 });
    const repair = mkResult({
      success: true,
      turns: 2,
      history: [{}] as DeliveryResult['history'],
      bestScore: 1,
      bestTurn: 2,
    });
    const r = aggregateTeamSolveResult({
      ...base,
      wf: { status: 'succeeded', failed: [] },
      solveResult: solve,
      repairResult: repair,
    });
    expect(r.turns).toBe(6);
    expect(r.history).toHaveLength(3);
    expect(r.bestScore).toBe(1);
    expect(r.finalFeedback).toContain('role ledger: .uap/workflow-runs/team-solve-deliver-1');
  });

  it('stopped/stall propagate; alreadyDelivered only when the workflow also succeeded', () => {
    const r = aggregateTeamSolveResult({
      ...base,
      wf: { status: 'succeeded', failed: [] },
      solveResult: mkResult({ success: true, alreadyDelivered: true, stopped: true }),
    });
    expect(r.stopped).toBe(true);
    expect(r.alreadyDelivered).toBe(true);
    expect(
      aggregateTeamSolveResult({
        ...base,
        wf: { status: 'failed', failed: ['verify'] },
        solveResult: mkResult({ success: true, alreadyDelivered: true }),
      }).alreadyDelivered
    ).toBe(false);
  });
});

describe('runTeamSolveDeliver (seams driven exactly as the engine drives them)', () => {
  const logs: string[] = [];
  // A real tmp root: the wrapper mkdirs the ledger under runsDir().
  const root = mkdtempSync(join(tmpdir(), 'uap-tsd-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const mkDeps = (over: Partial<TeamSolveDeps>): TeamSolveDeps => {
    const defaults: TeamSolveDeps = {
      projectRoot: root,
      getInstruction: () => 'THE MISSION',
      setInstruction: () => undefined,
      dispatch: async () => mkResult({ success: true }),
      judgeExecutor: async (p) => `JUDGE<${p}>`,
      generatorExecutor: async (p) => `GEN<${p}>`,
      buildRepairLoop: (config) =>
        ({
          deliver: async (instruction: string) => mkResult({ success: true, finalOutput: instruction }),
          config,
        }) as unknown as ConvergenceLoop,
      loopConfig: {
        projectRoot: root,
        maxTurns: 5,
        resumeFrom: { prior: 'checkpoint' },
        onCheckpoint: () => undefined,
      } as unknown as ConvergenceConfig,
      resolveModel: () => ModelPresets['qwen38-27b'],
      runGates: async () => ({ passed: true, feedback: '', count: 4 }),
      loadWorkflow: () => mkWorkflow(),
      runWorkflow: async () => ({ status: 'succeeded', exitCode: 0, completed: [], failed: [] }) as WorkflowRunResult,
      runsDir: () => join(root, 'workflow-runs'),
      newRunId: () => 'run-1',
      log: (l) => logs.push(l),
      ...over,
    };
    return defaults;
  };

  /** Run with a capturing runWorkflow so the engine closures can be driven. */
  const captureSeams = async (over: Partial<TeamSolveDeps> = {}): Promise<RunWorkflowOptions> => {
    logs.length = 0;
    let captured: RunWorkflowOptions | undefined;
    await runTeamSolveDeliver(
      mkDeps({
        ...over,
        runWorkflow: async (opts) => {
          captured = opts;
          return { status: 'succeeded', exitCode: 0, completed: [], failed: [] } as WorkflowRunResult;
        },
      })
    );
    expect(captured).toBeDefined();
    return captured!;
  };

  it('banner names the resolved workflow source and the ledger dir', async () => {
    await captureSeams();
    expect(logs[0]).toContain('team-solve: roles direct the convergence loop');
    expect(logs[0]).toContain('source: ');
    expect(logs[0]).toContain('ledger: ');
  });

  it('role rails: judge for plan/review, generator for ideation', async () => {
    const seams = await captureSeams();
    expect(await seams.completeStep!({ id: 'plan' } as never, 'plan prompt')).toBe('JUDGE<plan prompt>');
    expect(await seams.completeStep!({ id: 'review' } as never, 'review prompt')).toBe('JUDGE<review prompt>');
    expect(await seams.completeStep!({ id: 'ideate-a' } as never, 'ideate prompt')).toBe('GEN<ideate prompt>');
  });

  it('solve seam: dispatch runs with the approach-enriched instruction, original restored after', async () => {
    const seen: string[] = [];
    const seams = await captureSeams({
      getInstruction: () => seen.at(-1) ?? 'THE MISSION',
      setInstruction: (t) => seen.push(t),
      dispatch: async () => mkResult({ success: true, turns: 2 }),
    });
    const r = await seams.runLoop!({ stepId: 'solve', prompt: 'THE APPROACH' });
    expect(r.success).toBe(true);
    expect(r.turns).toBe(2);
    expect(r.summary).toContain('gates GREEN after 2 turn(s)');
    // Enrichment applied for the dispatch, original restored after.
    expect(seen[0]).toContain('TEAM-SOLVE APPROACH');
    expect(seen[0]).toContain('THE APPROACH');
    expect(seen[0]).toContain('THE MISSION');
    expect(seen.at(-1)).toBe('THE MISSION');
  });

  it('solve seam: a declared turns bound is refused loudly, not silently dropped', async () => {
    const seams = await captureSeams();
    await seams.runLoop!({ stepId: 'solve', prompt: 'x', turns: 3 });
    expect(logs.some((l) => l.includes('turns: bound ignored'))).toBe(true);
  });

  it('repair seam: fresh checkpoint state, declared turns honored, brief as instruction', async () => {
    let repairConfig: ConvergenceConfig | undefined;
    let repairInstruction = '';
    const seams = await captureSeams({
      buildRepairLoop: (config) => {
        repairConfig = config;
        return {
          deliver: async (instruction: string) => {
            repairInstruction = instruction;
            return mkResult({ success: true });
          },
        } as unknown as ConvergenceLoop;
      },
    });
    const r = await seams.runLoop!({ stepId: 'repair', prompt: 'THE REPAIR BRIEF', turns: 3 });
    expect(r.success).toBe(true);
    expect(repairInstruction).toBe('THE REPAIR BRIEF');
    expect(repairConfig!.resumeFrom).toBeUndefined();
    expect(repairConfig!.onCheckpoint).toBeUndefined();
    expect(repairConfig!.maxTurns).toBe(3);
  });

  it('verify seam: gates-only, no executor — even when the step id says solve', async () => {
    let gatesRan = false;
    let dispatchRan = false;
    const seams = await captureSeams({
      dispatch: async () => {
        dispatchRan = true;
        return mkResult({ success: true });
      },
      runGates: async () => {
        gatesRan = true;
        return { passed: true, feedback: '', count: 4 };
      },
    });
    const r = await seams.runLoop!({ stepId: 'solve', prompt: 'x', verifyOnly: true });
    expect(gatesRan).toBe(true);
    expect(dispatchRan).toBe(false);
    expect(r.success).toBe(true);
    expect(r.turns).toBe(0);
    expect(r.summary).toContain('4 gates green (verify-only pass)');
  });

  it('a gates-red verify reports the failure honestly', async () => {
    const seams = await captureSeams({
      runGates: async () => ({ passed: false, feedback: 'typecheck: 2 errors in src/a.ts', count: 4 }),
    });
    const r = await seams.runLoop!({ stepId: 'verify', prompt: '', verifyOnly: true });
    expect(r.success).toBe(false);
    expect(r.summary).toContain('gates red');
    expect(r.summary).toContain('typecheck');
  });

  it('workflow unavailable → visible warning + the plain dispatch (never worse than default)', async () => {
    logs.length = 0;
    let dispatched = false;
    const r = await runTeamSolveDeliver(
      mkDeps({
        loadWorkflow: () => {
          throw new Error('not found in any search root');
        },
        dispatch: async () => {
          dispatched = true;
          return mkResult({ success: true });
        },
      })
    );
    expect(dispatched).toBe(true);
    expect(r.success).toBe(true);
    expect(logs.some((l) => l.includes('unusable') && l.includes('standard dispatch'))).toBe(true);
  });

  it('shape drift → refuse loudly, fall back to the plain dispatch', async () => {
    logs.length = 0;
    let dispatched = false;
    await runTeamSolveDeliver(
      mkDeps({
        loadWorkflow: () => mkWorkflow(['plan', 'ideate-a', 'ideate-b', 'solve', 'review', 'repair', 'verdict']),
        dispatch: async () => {
          dispatched = true;
          return mkResult({ success: true });
        },
      })
    );
    expect(dispatched).toBe(true);
    expect(logs.some((l) => l.includes('shape drifted'))).toBe(true);
  });

  it('an unexpected loop step id is refused (fail-closed seam mapping)', async () => {
    const seams = await captureSeams();
    await expect(seams.runLoop!({ stepId: 'mystery', prompt: 'x' })).rejects.toThrow(/unexpected loop step/);
  });
});
