/**
 * Journey-depth classification — the A2 workstream of the evidence-gates
 * uplift.
 *
 * Measured failure (paired-qwen38-games, 2026-09-24, kept workdir
 * rubiks-cube-onvukh): the model-authored `.uap/user-paths.json` contained a
 * journey NAMED "scramble-control" whose steps were `goto → wait →
 * expect_visible body → expect_no_console_errors` — it never clicked the
 * scramble control and never asserted a state change. Every journey passed;
 * nothing was behaviorally verified. The runner honestly executes whatever
 * the manifest declares, so depth must be judged from the manifest's STEP
 * SHAPE, not from the journey's name or rule text.
 *
 * A journey is DEEP when it performs a state-changing interaction and then
 * asserts an observable effect AFTER that interaction:
 *
 *   browser — click / fill / press, followed by an expect_* step
 *   http    — request, followed by expect_status / expect_json_contains /
 *             expect_body_matches
 *   cli     — run, followed by expect_exit / expect_stdout_matches /
 *             expect_stderr_matches
 *
 * `goto`, `wait_ms`, and assertion-only steps are scaffolding: a journey
 * built from them alone proves "the page loads and does not throw", which is
 * the shallow class the measured failure exploited.
 *
 * Pure module: classification only. Consumers (buildUserPathsNote's advisory
 * note, the delivery-evidence gate's blocking decision) read the manifest
 * from disk themselves and call in here.
 */

import type { UserPath, UserPathStep, UserPathsManifest } from './user-paths.js';

export type JourneyDepth = 'deep' | 'shallow';

export interface ManifestDepth {
  /** Total journeys in the manifest. */
  total: number;
  /** Journeys with a state-changing interaction + subsequent assertion. */
  deep: number;
  /** Ids of the shallow journeys (for feedback text). */
  shallowIds: string[];
}

const BROWSER_INTERACTIONS: ReadonlyArray<keyof UserPathStep> = ['click', 'fill', 'press'];
const ASSERTION_KEYS: ReadonlyArray<keyof UserPathStep> = [
  'expect_visible',
  'expect_text',
  'expect_status',
  'expect_json_contains',
  'expect_body_matches',
  'expect_exit',
  'expect_stdout_matches',
  'expect_stderr_matches',
];

function isAssertion(step: UserPathStep): boolean {
  return ASSERTION_KEYS.some((k) => step[k] !== undefined);
}

/**
 * One journey's depth. The interaction must PRECEDE at least one assertion —
 * "assert, then click" observes nothing about the click.
 */
export function classifyJourney(path: UserPath): JourneyDepth {
  const steps = path.steps ?? [];
  if (path.client === 'http') {
    const i = steps.findIndex((s) => s.request !== undefined);
    return i >= 0 && steps.slice(i + 1).some(isAssertion) ? 'deep' : 'shallow';
  }
  if (path.client === 'cli') {
    const i = steps.findIndex((s) => s.run !== undefined);
    return i >= 0 && steps.slice(i + 1).some(isAssertion) ? 'deep' : 'shallow';
  }
  const i = steps.findIndex((s) => BROWSER_INTERACTIONS.some((k) => s[k] !== undefined));
  return i >= 0 && steps.slice(i + 1).some(isAssertion) ? 'deep' : 'shallow';
}

/** Depth rollup for a whole manifest. PURE. */
export function assessManifestDepth(manifest: UserPathsManifest): ManifestDepth {
  const shallowIds = (manifest.paths ?? [])
    .filter((p) => classifyJourney(p) === 'shallow')
    .map((p) => p.id);
  return { total: (manifest.paths ?? []).length, deep: (manifest.paths ?? []).length - shallowIds.length, shallowIds };
}

/**
 * Journey ids are MODEL-AUTHORED (the manifest is builder output) and land in
 * judge/builder prompt text — sanitize before interpolation: allowlist
 * charset, capped length, capped list (security-review finding 3).
 */
export function sanitizeJourneyIds(ids: string[], max = 5): string {
  const clean = ids.slice(0, max).map((id) => id.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40));
  const more = ids.length > max ? `, +${ids.length - max} more` : '';
  return clean.join(', ') + more;
}

/**
 * Human-facing clause appended to the acceptance runtime note when a PASSING
 * report rests on shallow journeys only. Worded as judge instructions: the
 * point is to stop the judge from treating "journeys passed" as behavioral
 * verification.
 */
export function shallowDepthNote(depth: ManifestDepth): string {
  return (
    `HOWEVER every one of the ${depth.total} journey(s) is SHALLOW — none performs a state-changing ` +
    `interaction (click/fill/press/request/run) followed by an assertion of its effect ` +
    `(shallow: ${sanitizeJourneyIds(depth.shallowIds)}). "Loads without errors" does NOT verify interactive ` +
    'behavior; treat all user-facing behavioral requirements as UNVERIFIED by these journeys.'
  );
}
