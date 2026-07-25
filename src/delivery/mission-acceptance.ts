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
import { runInteractionGate } from './interaction-gate.js';
import type { ProbeMode } from './interaction/types.js';
import { resolveFidelity } from './fidelity.js';
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
  interactionGate?: typeof runInteractionGate;
  visionReview?: typeof visionAcceptanceFeedback;
  judge?: typeof runAcceptanceGate;
  userPathsNote?: typeof buildUserPathsNote;
}

/**
 * Fidelity-max aesthetic convergence. Run Y (octopus variant, 2026-07-19)
 * reached STATUS delivered while `uap verify` rejected the artifact at
 * vision 2/10 — an empty bordered canvas. Deliver ran the deterministic
 * visual floors but never the vision review that fidelity-max verify blocks
 * on, so the loop converged against a lower bar than the release gate
 * (Generator≠Evaluator). Mirrors verify's wiring: env-bridge the configured
 * endpoint, autodetect a local vision model, judge the visual gate's
 * screenshots, and return actionable feedback when the score is below the
 * threshold. Fail-open on any error and when no vision model exists (same
 * as verify); deferred on non-final epics (their UI is not assembled yet).
 */
export async function visionAcceptanceFeedback(
  root: string,
  spec: string,
  screenshots: string[]
): Promise<string | null> {
  try {
    if (process.env.UAP_EPIC_NONFINAL === '1') return null;
    if (screenshots.length === 0) return null;
    const fidelity = resolveFidelity(root);
    if (!fidelity.max) return null;
    if (fidelity.visionEndpoint && !process.env.UAP_VISION_ENDPOINT) process.env.UAP_VISION_ENDPOINT = fidelity.visionEndpoint;
    if (fidelity.visionModel && !process.env.UAP_VISION_MODEL) process.env.UAP_VISION_MODEL = fidelity.visionModel;
    const vj = await import('./vision-judge.js');
    if (!vj.visionJudgeConfigured()) await vj.autodetectLocalVision();
    if (!vj.visionJudgeConfigured()) return null;
    const verdict = await vj.judgeScreenshots(screenshots, spec, vj.readDesignContext(root));
    if (!verdict || verdict.score >= fidelity.visionMinScore) return null;
    return (
      `VISION REVIEW FAILED — the rendered UI scores ${verdict.score}/10 (max-fidelity threshold ${fidelity.visionMinScore}). ` +
      'The page runs, but what it SHOWS is not acceptable:\n' +
      verdict.findings.map((f) => `- ${f}`).join('\n') +
      "\nFix the RENDERED OUTPUT (draw the mission's visible content: title, menu, sprites, HUD) — not just the code paths."
    );
  } catch {
    return null;
  }
}

/** Build the per-turn acceptance gate the convergence loop calls with a root. */
export function buildMissionAcceptanceGate(deps: MissionAcceptanceDeps): AcceptanceGate {
  const executionGate = deps.executionGate ?? runExecutionGate;
  const visualGate = deps.visualGate ?? runVisualGate;
  const interactionGate = deps.interactionGate ?? runInteractionGate;
  const judge = deps.judge ?? runAcceptanceGate;
  const userPathsNote = deps.userPathsNote ?? buildUserPathsNote;
  // eslint-disable-next-line no-console
  const note = deps.note ?? ((line: string): void => console.log(line));
  return async (root, gateCtx) => {
    // Explicit `=== false` — an undefined ctx means the caller did not tell us,
    // which must not be read as "the ladder was green".
    const ladderRed = gateCtx?.ladderPassed === false;
    // Primary mode: the only objective rung is the trivial bootstrap, and the
    // real execution gate joins via redetect only on the NEXT turn (one-turn
    // lag). So gate the artifact's runtime HERE too — idempotent with the
    // redetected execution rung on later turns.
    //
    // SECONDARY mode (objective gates exist) under MAX FIDELITY also runs the
    // vision review here. It used to run only in primary mode, so a run whose
    // only red rung was a synthetic anti-vacuous self-gate never reached vision:
    // the ladder stayed red, the aesthetic review was skipped, and the model
    // stalled with no visual feedback while fidelity-max verify still BLOCKED
    // delivery on that same vision score (Generator≠Evaluator). Ordering is
    // preserved: the review runs only once the deliverable is OPERATIONAL
    // (execution passes) and BEHAVING as specified (user paths not failing) —
    // never grade pixels of an app that does not run or misbehaves.
    const fidelity = resolveFidelity(root);
    let visualNote = '';
    if (deps.primary || fidelity.max) {
      const exec = await executionGate(root);
      if (!exec.passed) {
        // Operational gate: a build that does not run cannot be accepted, in
        // either mode. (In secondary mode this gate only runs on a red ladder
        // under runAcceptanceDespiteLadder; returning here avoids judging /
        // grading a broken build.)
        return {
          passed: false,
          feedback: `EXECUTION FAILED — the code must run before it can be accepted:\n${exec.outputTail}`,
        };
      } else {
        // Behavioral gate: do not grade how it LOOKS while user paths FAIL —
        // fix the broken UX first (the required ordering).
        const uv = userPathsNote(root);
        const behavioralFailing = Boolean(uv?.trusted && /User-path validation FAILED/.test(uv.note));
        // Interaction gate: the loop must converge against the SAME behavioural
        // bar `uap verify` enforces. Running it only on the verify side would
        // recreate the Generator≠Evaluator divergence this file already records
        // (run Y): the loop converges happily, then the release gate rejects the
        // result with feedback the loop never saw and cannot act on.
        if (!behavioralFailing) {
          const interaction = await interactionGate(root, {
            ...(fidelity.max
              ? { modes: ['core', 'accelerated', 'soak'] as ProbeMode[], strictCoverage: true }
              : {}),
          });
          if (!interaction.skipped && !interaction.passed && (deps.primary || fidelity.max)) {
            return { passed: false, feedback: interaction.feedback };
          }
        }
        if (!behavioralFailing) {
          // Visual gate: watch the artifact RUN — the observation summary becomes
          // judge evidence (a code-evidence judge cannot see a never-started
          // animation; this can).
          const visual = await visualGate(root);
          if (!visual.skipped && !visual.passed && deps.primary) {
            return { passed: false, feedback: visual.feedback };
          }
          visualNote = visualRuntimeNote(visual);
          // Fidelity-max: the loop must converge against the SAME aesthetic bar
          // verify enforces, or "delivered" and "verified" diverge (run Y).
          // Runs in primary mode (always, as before) and in secondary mode under
          // max fidelity (the new path that breaks the self-gate catch-22).
          if (!visual.skipped && (deps.primary || fidelity.max)) {
            const visionReview = deps.visionReview ?? visionAcceptanceFeedback;
            const shots = visual.pages.flatMap((pg) => pg.screenshots.slice(-1));
            const visionFail = await visionReview(root, deps.specs.resolve(root), shots);
            if (visionFail) {
              return { passed: false, feedback: visionFail };
            }
          }
        }
      }
    }
    const resolvedSpec = deps.specs.resolve(root);
    const uvNote = userPathsNote(root);
    // The secondary-mode note asserts the objective gates passed. That was safe
    // while acceptance only ever ran on a green ladder; under
    // runAcceptanceDespiteLadder it would instruct the judge to treat FAILING
    // build/test requirements as objectively verified — a direct route to
    // accepting criteria the gates are actively rejecting.
    const baseNote = deps.primary
      ? visualNote
      : ladderRed
        ? 'Objective project gates are currently FAILING on this turn — do NOT treat build/test-related requirements as verified. Judge only what the evidence supports.'
        : 'Objective project gates (build/test suite) ALL PASSED on this turn — treat test/build-related requirements as objectively verified.';
    // The visual observation is real evidence in BOTH modes; discarding it in
    // secondary mode meant paying for a headless browser pass and then throwing
    // the result away.
    const runtimeNote = [baseNote, deps.primary ? '' : visualNote, uvNote?.note]
      .filter(Boolean)
      .join(' ');
    const r = await judge({
      spec: resolvedSpec,
      projectRoot: root,
      executor: deps.judgeExecutor,
      ...(runtimeNote ? { runtimeNote } : {}),
    });
    const verdict = resolveAcceptanceVerdict(r, deps.primary);
    // Secondary mode only: bounded consecutive judge rejections of
    // objectively-green turns hand the verdict back to the gates.
    //
    // `ladderRed` is load-bearing. The breaker's contract is "the gates say yes,
    // the judge keeps saying no — trust the gates", and it only resets its counter
    // on a PASSING verdict. Feed it red turns (as runAcceptanceDespiteLadder now
    // can) and the count climbs on turns where the gates are saying no too; once
    // it trips it never resets, so every later turn is force-accepted — including
    // the turn the ladder finally goes green, delivering with the judge still
    // holding that the spec is unmet. Red turns are simply not its business.
    if (!deps.primary && !ladderRed) {
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
