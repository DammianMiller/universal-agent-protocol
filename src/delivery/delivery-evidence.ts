/**
 * Delivery-evidence gate + over-claim metric — workstreams B and D of the
 * evidence-gates uplift.
 *
 * Measured failure (paired-qwen38-games, 2026-09-24): all 4 self-declared
 * "delivered" rubiks cells failed external verification, while both
 * verify-passing cells never self-declared. The acceptance JUDGE was passing
 * turns whose only runtime evidence was a green page load plus model-authored
 * journeys that never exercised the behavior they were named after. The
 * runtime rail existed end-to-end (browser, screenshots, journeys); what did
 * not exist was a check that the evidence the judge relied on could
 * DISTINGUISH working software from a loadable page.
 *
 * B — anti-vacuous delivery: when the judge (or the churn breaker) says PASS,
 * audit the evidence that was actually on the table. A pass is only
 * deliverable when at least one EXECUTABLE signal ran green this turn:
 *
 *   deep-journeys  — a trusted user-paths report passed AND ≥1 journey is
 *                    deep (state-changing interaction + subsequent assertion;
 *                    journey-depth.ts)
 *   interaction    — the interaction gate ran (not skipped) and passed
 *   ladder         — secondary mode with the objective ladder green (real
 *                    build/test rungs executed and passed)
 *
 * When the deliverable is a web artifact (an entry page rendered or a
 * user-paths manifest exists) and NONE of those hold, the pass is refused
 * with feedback that demands a deep journey — returning `passed:false` makes
 * the convergence loop take another turn while budget remains (the "force
 * another turn" half of D; the loop already owns budget/stall policy).
 *
 * Scope discipline: non-web missions (no entry page, no manifest, no ladder)
 * stay judge-gated — a docs/config mission has no executable surface to
 * demand, and blocking it would recreate the unsatisfiable-gate class the
 * epic controller already solved for. Those passes are still RECORDED as
 * weak evidence so the metric sees them.
 *
 * D — over-claim metric: every judge-pass decision is appended to
 * `.uap/delivery-evidence.jsonl` with the evidence basis. An event with
 * `sufficient:false` IS a caught over-claim (judge passed on vacuous
 * evidence); the bench harness cross-joins this log with external verifyCmd
 * results to compute the delivered ∧ ¬verify rate.
 *
 * Knob: UAP_DELIVER_EVIDENCE_GATE (env) > .uap.json `deliver.evidenceGate` >
 * default ON.
 */

import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDeliverToggle } from './deliver-toggle.js';
import { sanitizeJourneyIds, type ManifestDepth } from './journey-depth.js';

export const EVIDENCE_LOG_FILE = join('.uap', 'delivery-evidence.jsonl');

export interface DeliveryEvidenceInput {
  /** Primary mode (judge is the convergence target, no real gates). */
  primary: boolean;
  /** The objective ladder ran green this turn (gateCtx.ladderPassed === true). */
  ladderGreen: boolean;
  /** Interaction gate outcome this turn; null when it never ran. */
  interaction: { skipped: boolean; passed: boolean } | null;
  /** Visual gate outcome this turn; null when it never ran. */
  visual: { skipped: boolean; passed: boolean } | null;
  /** User-paths report (trusted only) + manifest depth; null when absent. */
  userPaths: {
    verdict: 'pass' | 'fail' | 'na';
    trusted: boolean;
    depth?: ManifestDepth;
    /** Manifest changed after the validated run — remediation is RE-RUNNING
     * validation, not authoring journeys (architect-review finding 3). */
    stale?: boolean;
  } | null;
}

export type EvidenceBasis =
  | 'deep-journeys'
  | 'interaction'
  | 'ladder'
  | 'judge-only' // non-web deliverable: no executable surface exists to demand
  | 'vacuous'; // executable surface exists but nothing exercised it

export interface EvidenceAssessment {
  sufficient: boolean;
  basis: EvidenceBasis;
  /** Feedback for the next turn when insufficient; empty otherwise. */
  feedback: string;
}

/** The web-deliverable test: a page rendered, or journeys were declared. */
function hasExecutableSurface(input: DeliveryEvidenceInput): boolean {
  return (
    (input.visual !== null && !input.visual.skipped) ||
    (input.userPaths !== null && input.userPaths.trusted && input.userPaths.verdict !== 'na')
  );
}

/**
 * Audit the evidence behind a judge PASS. PURE — the caller supplies the
 * gate outcomes it already observed this turn.
 */
export function assessDeliveryEvidence(input: DeliveryEvidenceInput): EvidenceAssessment {
  const up = input.userPaths;
  if (up?.trusted && up.verdict === 'pass' && (up.depth?.deep ?? 0) >= 1) {
    return { sufficient: true, basis: 'deep-journeys', feedback: '' };
  }
  if (input.interaction && !input.interaction.skipped && input.interaction.passed) {
    return { sufficient: true, basis: 'interaction', feedback: '' };
  }
  if (!input.primary && input.ladderGreen) {
    return { sufficient: true, basis: 'ladder', feedback: '' };
  }
  // Static-content web missions (landing page, docs site) have no
  // state-changing control to exercise. The honest escape is an EXPLICIT
  // declaration: an empty/NA user-paths manifest — the runner then reports
  // 'na' and the judge sees the declaration in the note. Without it a
  // primary-mode static site would be refused forever demanding an
  // interaction that does not exist (correctness-review finding 3). The
  // declaration is model-authored like everything here; the point is that it
  // is explicit, logged, and judge-visible instead of silent.
  if (up?.trusted && up.verdict === 'na') {
    return { sufficient: true, basis: 'judge-only', feedback: '' };
  }
  if (!hasExecutableSurface(input)) {
    // No page, no journeys, no ladder — there is nothing executable to
    // demand. Judge-gated, and recorded as weak by the caller.
    return { sufficient: true, basis: 'judge-only', feedback: '' };
  }
  const gap =
    up?.trusted && up.stale
      ? 'the user-paths manifest CHANGED after validation ran — re-run user validation so the journeys execute against the current manifest (the report on disk is stale)'
      : up?.trusted && up.verdict === 'pass' && (up.depth?.total ?? 0) > 0
      ? `all ${up.depth?.total} user journey(s) are SHALLOW (${sanitizeJourneyIds(up.depth?.shallowIds ?? [])}): none performs the interaction it is named after`
      : up?.trusted && up.verdict === 'fail'
        ? 'the trusted user-paths report FAILED — fix the failing journeys first'
        : 'no trusted user-paths report exercised the artifact';
  return {
    sufficient: false,
    basis: 'vacuous',
    feedback:
      'DELIVERY EVIDENCE INSUFFICIENT — acceptance passed, but no EXECUTABLE check exercised the ' +
      `deliverable's behavior (${gap}). The page loading without errors is not behavioral ` +
      'verification. To complete delivery: author at least one .uap/user-paths.json journey that ' +
      'PERFORMS a state-changing interaction (click/fill/press/request/run on the real control the ' +
      'mission specifies) and then ASSERTS its observable effect (text/DOM/state change, status, or ' +
      'output), and make it pass. If the deliverable genuinely has NO interactive behavior (static ' +
      'content), say so explicitly with an empty paths list so the runner reports not-applicable. ' +
      'Then re-attempt delivery.',
  };
}

/** Effective on/off. env `UAP_DELIVER_EVIDENCE_GATE` > the caller-provided
 * `deliver.evidenceGate` > (only when no deliverCfg was passed) the config
 * file at `cwd` > default ON. See deliver-toggle.ts. */
export function resolveEvidenceGate(
  deliverCfg?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): boolean {
  return resolveDeliverToggle(env, 'UAP_DELIVER_EVIDENCE_GATE', deliverCfg, 'evidenceGate', cwd);
}

export interface EvidenceEvent {
  ts: string;
  /** The judge (or breaker) said PASS. */
  judgePassed: true;
  sufficient: boolean;
  basis: EvidenceBasis;
  primary: boolean;
  /** Depth rollup at decision time, when a manifest existed. */
  journeys?: { total: number; deep: number };
}

/**
 * Append one judge-pass evidence record to `.uap/delivery-evidence.jsonl`
 * (best-effort: a logging failure must never change a gate verdict). This is
 * the over-claim metric's raw stream — `sufficient:false` rows are caught
 * over-claims; the bench cross-joins rows with external verify outcomes.
 */
export function appendEvidenceEvent(root: string, event: EvidenceEvent): void {
  try {
    const file = join(root, EVIDENCE_LOG_FILE);
    mkdirSync(dirname(file), { recursive: true });
    // `.uap/` lives inside the project root, which the builder model writes
    // with host privileges — never follow a planted symlink to an arbitrary
    // path outside the root (security-review finding 2; defense in depth).
    try {
      if (lstatSync(file).isSymbolicLink()) return;
    } catch {
      // ENOENT: the common case — the log does not exist yet.
    }
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // telemetry must never gate delivery
  }
}
