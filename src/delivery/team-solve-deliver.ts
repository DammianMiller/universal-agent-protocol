/**
 * team-solve-deliver — the wrapper that runs the bundled team-solve-deliver
 * workflow around a mission's dispatch (ADR 0014). Extracted from deliver.ts's
 * dispatch block so the aggregation is unit-testable and every closure capture
 * is an explicit dep — the same treatment the epic/phased/orchestrated cores
 * got when their closures grew risky.
 *
 * The roles: plan → parallel ideations → solve (loop) → fresh review → repair
 * (loop) → verify (loop, gates-only). The caller injects the mission's own
 * machinery as the seams: solve = the mission dispatch with the team's
 * approach enriching the instruction, repair = a bounded convergence loop
 * seeded with the reviewer's brief, verify = the tiered ladder with no
 * executor turns.
 */
import { mkdirSync } from 'fs';
import { join, relative } from 'path';
import type { ConvergenceConfig, ConvergenceLoop, DeliveryResult } from './convergence-loop.js';
import type { RunWorkflowOptions, WorkflowRunResult } from '../workflow/runner.js';
import type { LoadedWorkflow } from '../workflow/types.js';

/** The exact step ids the rail assignment and seam mapping below are keyed to. */
export const TEAM_SOLVE_DELIVER_STEPS = [
  'plan',
  'ideate-a',
  'ideate-b',
  'solve',
  'review',
  'repair',
  'verify',
] as const;

/** Roles that ride the JUDGE rail (cool, deterministic, distinct when
 * configured): planning and review. Everything else rides the generator. */
const JUDGE_RAIL_STEPS = new Set(['plan', 'review']);

export interface TeamSolveDeps {
  projectRoot: string;
  /** The mission instruction. Explicit get/set: the solve step applies the
   * approach-enriched text for the dispatch and restores the original after —
   * a contract, not an ambient mutation. */
  getInstruction(): string;
  setInstruction(text: string): void;
  /** The mission dispatch (posture chain: epics → orchestrated → phased →
   * single). The solve step runs THIS, unchanged. */
  dispatch(): Promise<DeliveryResult>;
  /** deliver's executor rails for the role steps. */
  judgeExecutor: (prompt: string) => Promise<string>;
  generatorExecutor: (prompt: string) => Promise<string>;
  /** Builds the repair loop: a bounded convergence pass over the mission's
   * gate ladder + acceptance spec (the caller closes over runExecutor/seams). */
  buildRepairLoop(config: ConvergenceConfig): ConvergenceLoop;
  /** The mission's loop config — the repair base (checkpoint state cleared:
   * a repair-brief-scoped checkpoint must not replay into the original
   * mission's resume, the CI-reconverge precedent). */
  loopConfig: ConvergenceConfig;
  /** Resolve a step pin for the engine's load-time preflight — the rails own
   * each role's model, so this is the mission's resolution. */
  resolveModel: RunWorkflowOptions['resolveModel'];
  /** Gates-only verdict: the tiered ladder over merged rungs, no executor. */
  runGates(): Promise<{ passed: boolean; feedback: string; count: number }>;
  /** Loads the workflow (throws when unavailable from any search root). */
  loadWorkflow(): LoadedWorkflow;
  /** The engine runner + run-dir helpers (injected to keep this module's
   * imports type-only). */
  runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRunResult>;
  runsDir(): string;
  newRunId(): string;
  /** Progress/log sink. */
  log(line: string): void;
}

/**
 * Fail-closed on shape drift: the rail assignment (which ids get the judge)
 * and the seam mapping (which loop step is solve/repair/verify) are keyed to
 * TEAM_SOLVE_DELIVER_STEPS. A project override that renames or adds steps
 * must NOT silently ride the wrong rail — refuse loudly instead.
 */
export function assertTeamSolveDeliverShape(loaded: LoadedWorkflow): void {
  const ids = loaded.def.steps.map((s) => s.id).join(',');
  const expected = TEAM_SOLVE_DELIVER_STEPS.join(',');
  if (ids !== expected) {
    throw new Error(
      `team-solve-deliver workflow shape drifted: expected steps [${expected}], got [${ids}] — ` +
        'the judge-rail assignment and loop-seam mapping are keyed to these ids; ' +
        'fix the overriding workflow or the drift in src/delivery/team-solve-deliver.ts'
    );
  }
}

/**
 * One line of loop outcome for the workflow ledger — sized for the reviewer's
 * dependency summary. Honest about what it carries: gate status, turns, the
 * changed-tree flag, and a feedback tail. It does NOT carry a file list (the
 * reviewer's prompt is written to match — see steps/review.md).
 */
export function loopOutcome(r: DeliveryResult): string {
  const head = r.success
    ? `gates GREEN after ${r.turns} turn(s)${r.alreadyDelivered ? ' (baseline already green)' : ''}`
    : `NOT delivered after ${r.turns} turn(s) — best ${Math.round(r.bestScore * 100)}% of gates`;
  const changed = r.changedTree ? '; tree changed' : '';
  return `${head}${changed}${r.finalFeedback ? `; ${r.finalFeedback.slice(0, 150)}` : ''}`;
}

/**
 * Aggregate the workflow run + the two loop results into the mission's
 * DeliveryResult. PURE. The final verdict is the verify pass AND the
 * workflow's own status: a failed role step means no repair brief or no
 * verdict — not delivered. Histories concatenate; the last loop-bearing
 * result carries the best score; `wf.failed` lists steps that did not
 * complete (skip-cascaded descendants included — phrased honestly).
 */
export function aggregateTeamSolveResult(input: {
  wf: Pick<WorkflowRunResult, 'status' | 'failed'>;
  solveResult?: DeliveryResult;
  repairResult?: DeliveryResult;
  verifyPassed: boolean;
  verifySummary: string;
  projectRoot: string;
  ledgerDir: string;
}): DeliveryResult {
  const inner = input.repairResult ?? input.solveResult;
  if (!inner) {
    return {
      success: false,
      alreadyDelivered: false,
      turns: 0,
      bestScore: 0,
      bestTurn: 0,
      history: [],
      finalFeedback: `team-solve roles failed before the solve loop (not completed: ${input.wf.failed.join(', ')})`,
      finalOutput: '',
      totalDurationMs: 0,
    };
  }
  const { solveResult, repairResult } = input;
  return {
    success: input.wf.status === 'succeeded' && input.verifyPassed,
    alreadyDelivered: solveResult?.alreadyDelivered === true && input.wf.status === 'succeeded',
    turns: (solveResult?.turns ?? 0) + (repairResult?.turns ?? 0),
    bestScore: inner.bestScore,
    bestTurn: inner.bestTurn,
    history: [...(solveResult?.history ?? []), ...(repairResult?.history ?? [])],
    finalFeedback:
      input.wf.status === 'succeeded'
        ? `${input.verifySummary}; role ledger: ${relative(input.projectRoot, input.ledgerDir)}`
        : `team-solve workflow ${input.wf.status}${
            input.wf.failed.length ? ` (not completed: ${input.wf.failed.join(', ')})` : ''
          }`,
    finalOutput: inner.finalOutput,
    totalDurationMs: (solveResult?.totalDurationMs ?? 0) + (repairResult?.totalDurationMs ?? 0),
    changedTree: solveResult?.changedTree || repairResult?.changedTree || undefined,
    stopped: solveResult?.stopped || repairResult?.stopped || undefined,
    stallReason: repairResult?.stallReason ?? solveResult?.stallReason,
  };
}

/**
 * Run the team-solve-deliver workflow around the mission dispatch. Falls back
 * to the plain dispatch (with a visible warning) when the workflow is not
 * installed — AUTO engagement must never make deliver worse than its default
 * posture.
 */
export async function runTeamSolveDeliver(deps: TeamSolveDeps): Promise<DeliveryResult> {
  let loaded: LoadedWorkflow;
  try {
    loaded = deps.loadWorkflow();
    assertTeamSolveDeliverShape(loaded);
  } catch (e) {
    deps.log(
      `⚠ team-solve engaged but the workflow is unusable (${e instanceof Error ? e.message : String(e)}) — running the standard dispatch`
    );
    return deps.dispatch();
  }
  const ledgerDir = join(deps.runsDir(), deps.newRunId());
  mkdirSync(ledgerDir, { recursive: true });
  // Surface the RESOLVED source: project `.uap/workflows/` shadows the
  // bundled copy (first hit wins), and an operator must be able to see which
  // one ran — the ledger dir alone does not say.
  deps.log(
    `🧠 team-solve: roles direct the convergence loop (source: ${relative(deps.projectRoot, loaded.dir) || loaded.dir}; ledger: ${relative(deps.projectRoot, ledgerDir)})`
  );
  let solveResult: DeliveryResult | undefined;
  let repairResult: DeliveryResult | undefined;
  let verifyPassed = false;
  let verifySummary = 'gates not run';
  const wf = await deps.runWorkflow({
    loaded,
    runDir: ledgerDir,
    mission: deps.getInstruction(),
    // Pins are advisory here: the executor rails below own each role's model.
    resolveModel: deps.resolveModel,
    completeStep: (step, prompt) =>
      JUDGE_RAIL_STEPS.has(step.id) ? deps.judgeExecutor(prompt) : deps.generatorExecutor(prompt),
    runLoop: async ({ stepId, prompt, turns, verifyOnly }) => {
      // verifyOnly FIRST: a gates-only verdict must never run executor turns,
      // whatever the step id says (the engine-level contract).
      if (verifyOnly) {
        const gates = await deps.runGates();
        verifyPassed = gates.passed;
        verifySummary = gates.passed
          ? `${gates.count} gates green (verify-only pass)`
          : `gates red: ${gates.feedback.slice(0, 240)}`;
        return { success: gates.passed, summary: verifySummary, turns: 0 };
      }
      if (stepId === 'solve') {
        if (turns !== undefined) {
          deps.log('⚠ solve turns: bound ignored — the mission turn budget governs the solve dispatch');
        }
        // The team's approach (planner + both ideators, assembled by the
        // workflow engine) enriches the mission; the posture chain runs
        // UNCHANGED beneath it.
        const prior = deps.getInstruction();
        deps.setInstruction(
          `${prior}\n\nTEAM-SOLVE APPROACH (the team's plan + chosen proposal — steer by it; the gates decide):\n${prompt}`
        );
        try {
          solveResult = await deps.dispatch();
        } finally {
          deps.setInstruction(prior);
        }
        return { success: solveResult.success, summary: loopOutcome(solveResult), turns: solveResult.turns };
      }
      if (stepId === 'repair') {
        // Bounded convergence loop seeded with the reviewer's brief: fresh
        // checkpoint state (a repair-scoped checkpoint must not replay into
        // the original mission's resume — the CI-reconverge precedent), the
        // SAME gate ladder + acceptance spec. A declared turns: bound caps
        // this pass. When the reviewer says NO REPAIR NEEDED, the loop's own
        // baseline check is the green confirmation — zero turns, untouched.
        const repairConfig: ConvergenceConfig = {
          ...deps.loopConfig,
          resumeFrom: undefined,
          onCheckpoint: undefined,
          ...(turns !== undefined ? { maxTurns: turns } : {}),
        };
        const repairLoop = deps.buildRepairLoop(repairConfig);
        repairResult = await repairLoop.deliver(prompt);
        return { success: repairResult.success, summary: loopOutcome(repairResult), turns: repairResult.turns };
      }
      throw new Error(`team-solve-deliver: unexpected loop step "${stepId}"`);
    },
    log: deps.log,
  });
  return aggregateTeamSolveResult({
    wf,
    solveResult,
    repairResult,
    verifyPassed,
    verifySummary,
    projectRoot: deps.projectRoot,
    ledgerDir,
  });
}
