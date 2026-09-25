/**
 * Plan-time acceptance-criteria lint — the C workstream of the
 * evidence-gates uplift (docs/plans carried in the PR body).
 *
 * Measured failure (paired-qwen38-games, 2026-09-24): the epic planner emits
 * criteria like "the user can rotate faces and the stickers update" — a
 * BEHAVIORAL claim with no machine-checkable anchor. At acceptance time the
 * judge can only grade such a criterion against whatever runtime evidence
 * exists, and the model-authored user journeys that supply it are allowed to
 * be shallow ("page loads, no console errors"). The loop then delivers work
 * whose own spec was never executable.
 *
 * This module classifies each planner-emitted criterion deterministically:
 *
 *   executable  — carries a machine-checkable anchor (a command, a file
 *                 path, an exact string/number/regex, an exit code, a
 *                 user-paths journey reference). The judge CAN grade it
 *                 against objective output.
 *   behavioral  — asserts a runtime interaction/effect (click, rotate,
 *                 updates, animates, responds…) with NO executable anchor.
 *   static      — everything else (structural/source claims a code-reading
 *                 judge can grade directly).
 *
 * Behavioral criteria are REWRITTEN in place with an explicit evidence
 * requirement: the criterion itself now demands an executable check (a deep
 * user-paths journey or a script/test), so the builder knows up front that
 * "page loads without errors" will not satisfy it — and the delivery-evidence
 * gate (delivery-evidence.ts) enforces that demand at acceptance time.
 * Rewriting (not rejecting) keeps the planner loop cheap: a 27B-class model
 * regenerating a whole plan over a lint complaint is far more expensive than
 * an appended clause it can simply honor.
 *
 * Knob: UAP_DELIVER_CRITERIA_LINT (env) > .uap.json `deliver.criteriaLint` >
 * default ON. `0`/`false`/`off` disables.
 */

import { resolveDeliverToggle } from './deliver-toggle.js';

/** Marker appended to rewritten criteria; also the idempotence guard. */
export const EVIDENCE_CLAUSE_MARKER = 'ACCEPTANCE EVIDENCE REQUIRED';

const EVIDENCE_CLAUSE =
  ` — ${EVIDENCE_CLAUSE_MARKER}: prove this with an executable check — a ` +
  '.uap/user-paths.json journey that PERFORMS the interaction (click/fill/' +
  'press/request/run) and then ASSERTS its observable effect, or a test/' +
  'script that exercises it. "Page loads without console errors" or code ' +
  'inspection alone do NOT satisfy this criterion.';

export type CriterionClass = 'executable' | 'behavioral' | 'static';

export interface CriterionAssessment {
  criterion: string;
  class: CriterionClass;
  /** True when the returned criterion text carries the evidence clause. */
  rewritten: boolean;
}

export interface CriteriaLintResult {
  /** The linted criteria (behavioral ones rewritten in place). */
  criteria: string[];
  assessments: CriterionAssessment[];
  stats: { executable: number; behavioral: number; static: number; rewritten: number };
}

/** Anchors that make a criterion machine-checkable as written. */
const EXECUTABLE_ANCHORS: RegExp[] = [
  /`[^`]+`/, // backticked literal (command, file, symbol)
  // A quoted literal only counts WITH a checking verb in the same sentence —
  // 'the page displays the exact text "X"' is checkable; 'clicking "X"
  // randomizes the cube' is a behavioral claim wearing a quoted UI label
  // (correctness-review finding 4).
  /(?:display|show|contain|output|print|match|title|text|read)s?[^.\n]{0,80}("[^"]{2,}"|'[^']{2,}')/i,
  /("[^"]{2,}"|'[^']{2,}')[^.\n]{0,80}\b(?:is displayed|is shown|appears?|is printed|is emitted)\b/i,
  // No `.` in the repeated class (it would overlap the required literal dot
  // and force quadratic backtracking on pathological input — security-review
  // finding 4). Path-like token: word chars/dashes, then / or extension.
  /\b[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|jsx|mjs|html|css|py|json|ya?ml|sh|rs|go|c|h|java|rb)\b/,
  // Bare `make`/`sh` over-matched prose ("should make use of") — require a
  // non-prose argument or drop the word (correctness-review finding 5).
  /\b(?:npm|npx|node|bun|deno|pytest|python3?|pip|cargo|grep|curl|bash)\s/,
  /\b(?:make|mvn|gradle|go test)\s+[\w:-]*(?:build|test|check|lint|compile|install|run|verify|all|clean)\b/,
  /\bexit(?:s|ed|ing)?(?:\s+code)?\s+0\b/i,
  /\bstatus\s+(?:code\s+)?[1-5]\d\d\b/i,
  /\b(?:stdout|stderr)\b/i,
  /\/[^/\n]+\/[gimsuy]*/, // regex literal
  /\b(?:>=|<=|>|<|≥|≤)\s*\d/,
  // `(?!\w)` instead of `\b`: `%` is a non-word char, so "100%" never had a
  // trailing word boundary (correctness-review finding 6).
  /\b\d+\s*(?:ms|s|sec|seconds|bytes|kb|mb|px|%)(?!\w)/i,
  /\buser-paths\.json\b/,
  /\bverify\.sh\b/,
];

/** Interaction/effect verbs that make a criterion a runtime-behavior claim. */
const BEHAVIORAL_VERBS =
  /\b(?:click(?:s|ing)?|press(?:es|ing)?|drag(?:s|ging)?|hover(?:s|ing)?|tap(?:s|ping)?|swipe(?:s)?|type(?:s|ing)?|scroll(?:s|ing)?|fill(?:s|ing)?\s+in|toggle(?:s|d)?|select(?:s|ing)?|submit(?:s|ting)?|double-?click(?:s|ing)?|keyboard|mouse|input|user\s+interaction|interact(?:s|ing|ive)?|respond(?:s|ing)?|react(?:s|ing)?\s+to|updat(?:e|es|ing)\s+(?:the\s+)?(?:display|ui|screen|view|state|layout|scene|canvas|cube|board|score|counter)|animat(?:e|es|ing|ion)|transition(?:s|ing)?|render(?:s|ing)?\s+(?:on|after|when)|rotat(?:e|es|ing|ion)|scrambl(?:e|es|ing)|randomiz(?:e|es|ing)|reset(?:s|ting)?\s+(?:the\s+)?(?:cube|board|game|state|scene)|spawn(?:s|ing)?|shoot(?:s|ing)?|collid(?:e|es|ing|ision)|bounce(?:s|ing)?|play(?:s|ing)?\s+(?:sound|audio|music)|pause(?:s|d)?|resum(?:e|es|ing)|win|lose|game\s+over|score\s+(?:increas|chang|updat)|follows?\s+the\s+cursor|real[\s-]?time|live\s+updat)/i;

/** Subject-then-verb order ("the display updates after each move") — the
 * verb-first list above misses this phrasing (correctness-review finding 7). */
const BEHAVIORAL_SUBJECT_VERB =
  /\b(?:display|ui|screen|view|state|layout|scene|canvas|cube|board|score|counter)\s+(?:updates?|changes?|animates?|responds?|reacts?|rotates?|randomizes?)\b/i;

/** Criteria are unbounded planner output; cap before any regex runs so a
 * pathological criterion cannot buy CPU (security-review finding 4). */
const CRITERION_SCAN_CAP = 4000;

/** Classify one criterion. PURE. */
export function classifyCriterion(criterion: string): CriterionClass {
  // Idempotence via the FULL appended clause at the END of the criterion —
  // the bare marker string must NOT count, or the planner can mint it inline
  // ("... — ACCEPTANCE EVIDENCE REQUIRED") and skip the rewrite entirely
  // (security-review finding 1).
  if (criterion.endsWith(EVIDENCE_CLAUSE)) return 'executable';
  const scan = criterion.length > CRITERION_SCAN_CAP ? criterion.slice(0, CRITERION_SCAN_CAP) : criterion;
  if (EXECUTABLE_ANCHORS.some((re) => re.test(scan))) return 'executable';
  if (BEHAVIORAL_VERBS.test(scan) || BEHAVIORAL_SUBJECT_VERB.test(scan)) return 'behavioral';
  return 'static';
}

/** Append the evidence clause, idempotently. */
export function withEvidenceClause(criterion: string): string {
  return criterion.endsWith(EVIDENCE_CLAUSE) ? criterion : criterion + EVIDENCE_CLAUSE;
}

/**
 * Lint a planner-emitted criteria list. Behavioral criteria gain the
 * executable-evidence clause; executable/static pass through untouched.
 * PURE — the caller decides whether to use the result (knob) and where the
 * stats get reported.
 */
export function lintCriteria(criteria: string[]): CriteriaLintResult {
  const assessments: CriterionAssessment[] = criteria.map((criterion) => {
    const cls = classifyCriterion(criterion);
    return {
      criterion,
      class: cls,
      rewritten: cls === 'behavioral' && !criterion.endsWith(EVIDENCE_CLAUSE),
    };
  });
  return {
    criteria: assessments.map((a) => (a.rewritten ? withEvidenceClause(a.criterion) : a.criterion)),
    assessments,
    stats: {
      executable: assessments.filter((a) => a.class === 'executable').length,
      behavioral: assessments.filter((a) => a.class === 'behavioral').length,
      static: assessments.filter((a) => a.class === 'static').length,
      rewritten: assessments.filter((a) => a.rewritten).length,
    },
  };
}

/**
 * Effective on/off for the lint: env `UAP_DELIVER_CRITERIA_LINT` > the
 * caller-provided `deliver.criteriaLint` > (only when no deliverCfg was
 * passed) the config file at `cwd` > default ON. See deliver-toggle.ts for
 * why a provided-but-keyless deliverCfg must NOT fall through to the file.
 */
export function resolveCriteriaLint(
  deliverCfg?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): boolean {
  return resolveDeliverToggle(env, 'UAP_DELIVER_CRITERIA_LINT', deliverCfg, 'criteriaLint', cwd);
}
