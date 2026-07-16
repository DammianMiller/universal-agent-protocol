/**
 * Mission acceptance gate — the per-turn judge composition extracted from
 * deliver.ts (the spec registry's consumer twin): execution + visual gates in
 * primary mode, spec resolution per root, judge invocation with runtime
 * evidence, and the secondary-mode churn breaker. deliver.ts keeps only the
 * wiring decision (acceptance on? primary or secondary?).
 *
 * Modes:
 * - PRIMARY (no real project gates): the judge IS the convergence target, so
 *   the artifact must actually RUN before completeness is judged — the
 *   execution gate closes the gap where a 1-turn build could be declared
 *   delivered on the judge alone, and the visual gate watches it run (blank
 *   canvas / static rAF scene / runtime errors block acceptance).
 * - SECONDARY (objective gates exist): this gate is reached ONLY on turns
 *   whose objective gates all passed; that fact is handed to the judge as
 *   evidence, and a bounded number of consecutive judge rejections hands the
 *   verdict back to the gates (churn breaker) instead of wedging.
 */

import type { AcceptanceGate, LoopExecutor } from './convergence-loop.js';
import {
  runAcceptanceGate,
  formatAcceptanceReport,
  type AcceptanceResult,
} from './acceptance-judge.js';
import { runExecutionGate } from './execution-gate.js';
import { runVisualGate, visualRuntimeNote } from './visual-gate.js';
import { buildUserPathsNote } from './user-validation.js';
import type { SpecRegistry } from './spec-registry.js';

/**
 * Fold a raw judge result into the loop-facing verdict, honoring primary vs
 * secondary mode. PURE — unit-tested in isolation from the model call.
 *
 * - Genuine fully-met verdict → pass.
 * - PRIMARY (acceptance is the sole convergence target): an inconclusive /
 *   no-evidence verdict is NOT "done" — fail so the loop keeps building.
 *   A parse error also omits the score: runAcceptanceGate reports score:1 on
 *   its fail-open paths, which would otherwise saturate the loop's
 *   acceptance-progress (bestAcceptance) and mask real per-criterion gains.
 * - SECONDARY (real objective gates exist): fail OPEN on judge flakiness — a
 *   green objective delivery is never blocked by the judge's nondeterminism.
 */
export function resolveAcceptanceVerdict(
  r: AcceptanceResult,
  acceptancePrimary: boolean
): { passed: boolean; feedback: string; score?: number } {
  if (r.passed && !r.parseError) return { passed: true, score: r.score, feedback: '' };
  const gaps = `ACCEPTANCE GAPS — implement these to complete the spec:\n${formatAcceptanceReport(r)}`;
  if (acceptancePrimary) {
    if (r.parseError) {
      return {
        passed: false,
        feedback: `Acceptance inconclusive (${r.parseError}). Keep implementing the spec — ensure the source files exist and are complete.`,
      };
    }
    return { passed: false, score: r.score, feedback: gaps };
  }
  return { passed: r.passed, score: r.score, feedback: r.passed ? '' : gaps };
}

export interface MissionAcceptanceDeps {
  /** Primary mode: the judge is the convergence target (no real gates). */
  primary: boolean;
  /** Spec + evidence + churn-breaker owner (see spec-registry.ts). */
  specs: SpecRegistry;
  /** The judge model call (JSON-verdict executor). */
  judgeExecutor: LoopExecutor;
  /** Breaker-override warning line — the one operator signal that the judge
   * was overruled. Defaults to console.log; callers decorate with chalk. */
  note?: (line: string) => void;
  /** Test seams — default to the real gates. */
  executionGate?: typeof runExecutionGate;
  visualGate?: typeof runVisualGate;
  judge?: typeof runAcceptanceGate;
  userPathsNote?: typeof buildUserPathsNote;
}

/** Build the per-turn acceptance gate the convergence loop calls with a root. */
export function buildMissionAcceptanceGate(deps: MissionAcceptanceDeps): AcceptanceGate {
  const executionGate = deps.executionGate ?? runExecutionGate;
  const visualGate = deps.visualGate ?? runVisualGate;
  const judge = deps.judge ?? runAcceptanceGate;
  const userPathsNote = deps.userPathsNote ?? buildUserPathsNote;
  // eslint-disable-next-line no-console
  const note = deps.note ?? ((line: string): void => console.log(line));
  return async (root) => {
    // Primary mode: the only objective rung is the trivial bootstrap, and the
    // real execution gate joins via redetect only on the NEXT turn (one-turn
    // lag). So gate the artifact's runtime HERE too — idempotent with the
    // redetected execution rung on later turns.
    let visualNote = '';
    if (deps.primary) {
      const exec = await executionGate(root);
      if (!exec.passed) {
        return {
          passed: false,
          feedback: `EXECUTION FAILED — the code must run before it can be accepted:\n${exec.outputTail}`,
        };
      }
      // Visual gate: watch the artifact RUN — the observation summary becomes
      // judge evidence (a code-evidence judge cannot see a never-started
      // animation; this can).
      const visual = await visualGate(root);
      if (!visual.skipped && !visual.passed) {
        return { passed: false, feedback: visual.feedback };
      }
      visualNote = visualRuntimeNote(visual);
    }
    const resolvedSpec = deps.specs.resolve(root);
    const uvNote = userPathsNote(root);
    const baseNote = deps.primary
      ? visualNote
      : 'Objective project gates (build/test suite) ALL PASSED on this turn — treat test/build-related requirements as objectively verified.';
    const runtimeNote = [baseNote, uvNote?.note].filter(Boolean).join(' ');
    const r = await judge({
      spec: resolvedSpec,
      projectRoot: root,
      executor: deps.judgeExecutor,
      ...(runtimeNote ? { runtimeNote } : {}),
    });
    const verdict = resolveAcceptanceVerdict(r, deps.primary);
    // Secondary mode only: bounded consecutive judge rejections of
    // objectively-green turns hand the verdict back to the gates.
    if (!deps.primary) {
      const checked = deps.specs.breaker(resolvedSpec, root).check(resolvedSpec, verdict);
      if (checked.overridden) {
        note(
          '⚖ acceptance: judge rejected consecutive objectively-green turns — accepting on gates (raise UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT to let the judge argue longer)'
        );
      }
      return checked;
    }
    return verdict;
  };
}
