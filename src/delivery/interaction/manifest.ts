/**
 * Interaction manifest — persistence, validation and the coverage ledger.
 *
 * The manifest lives OUTSIDE the deliverable (`.uap/interaction/manifest.json`)
 * for the same reason a test suite is not shipped inside the thing it tests: an
 * agent that can edit its own acceptance criteria will eventually edit them
 * instead of fixing the defect. `.uap/interaction/` is added to the self-protect
 * enforcer's deny list so a delivering agent cannot rewrite its own probes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CoverageLedger,
  InteractionManifest,
  Probe,
  Requirement,
  Step,
} from './types.js';

export const MANIFEST_DIR = join('.uap', 'interaction');
export const MANIFEST_FILE = 'manifest.json';

/** Probe ids become evidence filenames — no separators, no traversal. */
export const PROBE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** Hard ceiling on nested `repeat` so validation cannot be blown up by depth. */
export const MAX_STEP_DEPTH = 6;

/**
 * Reject observation expressions that can MUTATE the artifact.
 *
 * The `inject`-only-in-accelerated rule is worthless on its own, because a JS
 * *expression* can assign: `{expect:'gte', expr:'(kills = 5)', value:5}` writes
 * the state it then grades, passes validation as a `core` probe, and proves
 * exactly nothing. The rule has to cover every string that reaches an
 * evaluation slot — assertions, `eval` steps and watch expressions alike.
 *
 * Honest about its limits: this is syntactic, and no string inspection can
 * *prove* a JS expression is side-effect-free (a getter or a called function can
 * mutate). It raises the cost of the obvious bypass; the observation-level
 * invariant (watched values must not change across a read) is what catches the
 * rest, and the manifest's write-protection is what makes both meaningful.
 */
export function expressionMutates(expr: string): string | null {
  const text = String(expr);
  // Assignment that is not a comparison: `=` not preceded by = ! < > and not
  // followed by =. Covers `x = 1`, `x += 1`, `x ||= 1`.
  if (/(?<![=!<>+\-*/%&|^])(?:[+\-*/%&|^]|\*\*|<<|>>>?|\|\||&&|\?\?)?=(?!=)/.test(text)) {
    return 'contains an assignment';
  }
  if (/\+\+|--/.test(text)) return 'contains an increment/decrement';
  // `delete x.y`, and the comma operator used to sequence a side effect.
  if (/\bdelete\s/.test(text)) return 'contains a delete';
  // A TOP-LEVEL comma is the sequence operator (`hp = 1, true`). Commas nested
  // inside a call or literal — `Math.min(a, b)`, `[1, 2].length` — are ordinary.
  if (hasTopLevelComma(text)) return 'contains a comma sequence';
  return null;
}

/** True when `text` has a comma outside every (), [] and {} and outside strings. */
export function hasTopLevelComma(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth <= 0) return true;
  }
  return false;
}

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_DIR, MANIFEST_FILE);
}

/** Stable short hash of the requirements text a manifest was mined from. */
export function hashSpec(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

/** Walk nested `repeat` blocks so validation cannot be bypassed by nesting. */
export function flattenSteps(steps: Step[], depth = 0): Step[] {
  const out: Step[] = [];
  // Depth-capped: a deeply nested manifest would otherwise blow the stack
  // inside validation, turning a malformed input into a crash.
  if (depth > MAX_STEP_DEPTH || !Array.isArray(steps)) return out;
  for (const s of steps) {
    out.push(s);
    if (s.do === 'repeat') out.push(...flattenSteps(s.steps, depth + 1));
  }
  return out;
}

/**
 * Structural validation + the anti-cheat invariants. Returns the problems found;
 * empty means valid.
 *
 * The load-bearing rule is the `inject` restriction: a probe that writes
 * `score = 100` and then asserts `score >= 100` proves nothing at all. State
 * injection is therefore legal ONLY in `accelerated` probes, whose results are
 * reported separately and never counted as evidence of natural progression.
 */
export function validateManifest(m: unknown): string[] {
  const problems: string[] = [];
  const man = m as Partial<InteractionManifest> | null;
  if (!man || typeof man !== 'object') return ['manifest is not an object'];
  if (man.version !== 1) problems.push(`unsupported manifest version: ${String(man.version)}`);
  if (!man.kind || !['web', 'cli', 'http'].includes(man.kind)) {
    problems.push(`unknown artifact kind: ${String(man.kind)}`);
  }
  if (!Array.isArray(man.requirements)) problems.push('requirements must be an array');
  if (!Array.isArray(man.probes)) problems.push('probes must be an array');
  if (problems.length > 0) return problems;

  const reqIds = new Set((man.requirements as Requirement[]).map((r) => r.id));
  const seenProbeIds = new Set<string>();
  for (const p of man.probes as Probe[]) {
    if (!p.id) problems.push('probe with no id');
    // The probe id becomes a FILENAME (the evidence screenshot), and the
    // manifest is untrusted by construction — it is kept behind the
    // self-protect deny list precisely because an agent would otherwise edit
    // it. An id of `../../../etc/x` would write outside the evidence dir.
    else if (!PROBE_ID_RE.test(p.id)) {
      problems.push(
        `probe ${p.id}: id must be filename-safe (letters, digits, dot, dash, underscore)`
      );
    }
    if (seenProbeIds.has(p.id)) problems.push(`duplicate probe id: ${p.id}`);
    seenProbeIds.add(p.id);
    if (!Array.isArray(p.steps) || p.steps.length === 0) {
      problems.push(`probe ${p.id}: no steps`);
    }
    if (!Array.isArray(p.asserts) || p.asserts.length === 0) {
      // A probe with no assertions is theatre: it drives input and claims a pass
      // no matter what the artifact did.
      problems.push(`probe ${p.id}: no assertions — a probe that asserts nothing cannot fail`);
    }
    for (const rid of p.requirementIds ?? []) {
      if (!reqIds.has(rid)) problems.push(`probe ${p.id}: unknown requirement id ${rid}`);
    }
    const steps = flattenSteps(p.steps ?? []);
    if (p.mode !== 'accelerated') {
      const injects = steps.filter((s) => s.do === 'inject');
      if (injects.length > 0) {
        problems.push(
          `probe ${p.id}: state injection is only allowed in 'accelerated' probes ` +
            `(a probe that injects the state it then asserts proves nothing)`
        );
      }
      // Every OTHER evaluation slot has to obey the same rule, or the rule is
      // theatre: an assertion of `(kills = 5)` mutates and then grades itself.
      for (const s of steps) {
        if (s.do !== 'eval') continue;
        const why = expressionMutates(s.expr);
        if (why) problems.push(`probe ${p.id}: eval expression ${why} — observations must not mutate`);
      }
    }
    for (const a of p.asserts ?? []) {
      if (!('expr' in a) || typeof a.expr !== 'string') continue;
      const why = expressionMutates(a.expr);
      if (why) {
        problems.push(
          `probe ${p.id}: assertion expression ${why} — an assertion that mutates grades its own write`
        );
      }
    }
  }
  for (const w of (man as InteractionManifest).watch ?? []) {
    const why = typeof w === 'string' ? expressionMutates(w) : 'is not a string';
    if (why) problems.push(`watch expression ${why} — the watchdog must only observe`);
  }
  return problems;
}

/**
 * Load result that distinguishes ABSENT from INVALID.
 *
 * Collapsing the two is how a tampered manifest reads as a fresh project: the
 * gate says "no manifest — run `uap interaction mine`", the operator re-mines,
 * and the tamper is laundered into a clean skip.
 */
export type ManifestLoad =
  | { status: 'ok'; manifest: InteractionManifest }
  | { status: 'absent' }
  | { status: 'invalid'; problems: string[] };

export function loadManifestDetailed(projectRoot: string): ManifestLoad {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) return { status: 'absent' };
  let parsed: InteractionManifest;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as InteractionManifest;
  } catch (e) {
    return { status: 'invalid', problems: [`manifest is not valid JSON: ${String(e).slice(0, 160)}`] };
  }
  const problems = validateManifest(parsed);
  return problems.length === 0 ? { status: 'ok', manifest: parsed } : { status: 'invalid', problems };
}

export function loadManifest(projectRoot: string): InteractionManifest | null {
  const r = loadManifestDetailed(projectRoot);
  return r.status === 'ok' ? r.manifest : null;
}

export function saveManifest(projectRoot: string, manifest: InteractionManifest): string {
  const path = manifestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Which requirements have at least one probe. This is what turns "all
 * requirements are present and active" from a claim into a check: an unmapped
 * requirement is a coverage gap, and under max fidelity a gap blocks DONE.
 */
export function coverageOf(
  manifest: InteractionManifest,
  /**
   * The probes that will ACTUALLY run this invocation. Counting the whole
   * manifest reports a requirement as covered when its only probe belongs to a
   * mode that was not run — "covered" would mean "has a probe somewhere",
   * not "was verified".
   */
  ranProbes?: Probe[]
): CoverageLedger {
  const covered = new Set<string>();
  for (const p of ranProbes ?? manifest.probes) {
    // Accelerated probes reach their path by INJECTING state, so they are not
    // evidence that a user can get there. Counting them as coverage would let
    // "every requirement is covered" mean "every requirement has a probe that
    // wrote its own preconditions".
    if (p.mode === 'accelerated') continue;
    for (const rid of p.requirementIds ?? []) covered.add(rid);
  }
  const uncovered = manifest.requirements.filter((r) => !covered.has(r.id));
  return {
    total: manifest.requirements.length,
    covered: manifest.requirements.length - uncovered.length,
    uncovered,
  };
}

/** True when the manifest was mined from different requirements than the current text. */
export function manifestIsStale(manifest: InteractionManifest, specText: string): boolean {
  return manifest.specHash !== hashSpec(specText);
}
