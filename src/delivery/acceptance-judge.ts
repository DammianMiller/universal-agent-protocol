/**
 * Acceptance judge — behavioral completeness, beyond "does it crash".
 *
 * The execution gate proves the artifact RUNS; it cannot tell whether the spec
 * was actually implemented. A generated game can load cleanly yet never call
 * particles.draw(), render octopi with smooth arcs instead of pixel grids, or
 * skip the boss every 5 levels. This gate extracts the spec's explicit
 * requirements and judges each against the produced code (+ an optional runtime
 * note), via a text LLM — so it works with the local model (no vision needed).
 *
 * It is a JUDGMENT, not a deterministic check: callers treat it as advisory or
 * gate on it explicitly. The executor is injected (a prompt→text function), so
 * the logic is fully unit-testable with a mock.
 */

import { lstatSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import type { LoopExecutor } from './convergence-loop.js';

export interface AcceptanceCriterion {
  requirement: string;
  met: boolean;
  reason: string;
}

export interface AcceptanceResult {
  passed: boolean;
  /** Fraction of criteria met (1 when none were extracted). */
  score: number;
  criteria: AcceptanceCriterion[];
  /** Set when the model output could not be parsed (fail-open → passed:true). */
  parseError?: string;
}

export interface AcceptanceOptions {
  spec: string;
  projectRoot: string;
  /** Model call: prompt → text. */
  executor: LoopExecutor;
  /** Pre-gathered evidence (overrides the file walk; for tests). */
  evidence?: string;
  /** One-line runtime observation (e.g. the execution gate's outputTail). */
  runtimeNote?: string;
  /** Max source files to include as evidence (default 40). */
  maxFiles?: number;
  /** Max total evidence chars (default 60000). */
  maxChars?: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.uap', '.uap-deliver', 'agents', '.worktrees']);
const SRC_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|py|go|rs|java|rb|md|txt)$/i;
/** Never ship likely-secret files into the LLM prompt (esp. for remote endpoints). */
const SECRET_FILE_RE = /(^\.env)|secret|credential|\.pem$|\.key$|id_rsa/i;
const DEFAULT_MAX_FILES = 40;
// Generous by default — modern local models have very large context windows
// (e.g. qwen3.6 ≈ 184K tokens), and truncating implementation files causes the
// judge to report implemented features as "not visible" (false MISS).
const DEFAULT_MAX_CHARS = 60_000;
const PER_FILE_CHARS = 20_000;
/** Data/doc files are context, not implementation — a small head suffices. */
const DATA_FILE_CHARS = 1_500;

/**
 * Evidence priority. Alphabetical walk order let big flat data files (e.g.
 * data/*.txt walked before src/) consume the ENTIRE evidence budget, so the
 * judge never saw package.json or src/ and correctly reported every
 * requirement "not visible" — rejecting objectively-green turns forever.
 * Priority 0 = configs + implementation source, 1 = tests + structured data,
 * 2 = docs/plain data (head-only).
 */
function evidencePriority(name: string): number {
  if (/^(package\.json|tsconfig.*\.json|pyproject\.toml|cargo\.toml|go\.mod|gemfile)$/i.test(name)) return 0;
  if (/\.(test|spec)\.[a-z]+$/i.test(name)) return 1;
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|html|css)$/i.test(name)) return 0;
  if (/\.json$/i.test(name)) return 1;
  return 2; // md, txt, misc data
}

/**
 * Path-like tokens the spec explicitly names (files or directories). These are
 * what the judge is being asked to verify, so they get guaranteed evidence
 * slots: at repo scale the alphabetical candidate walk fills its pool long
 * before late-alphabet directories — observed live 2026-07-11, a mission whose
 * whole deliverable lived under web/dash/ was judged 0/4 with "no such file"
 * while every file sat on disk, because web/ never entered the candidate pool.
 */
function specReferencedPaths(spec: string): string[] {
  const out = new Set<string>();
  for (const m of spec.matchAll(/[\w.@-]+(?:\/[\w.@*-]+)+/g)) {
    // Strip trailing punctuation from prose (e.g. "web/dash/styles.css —").
    const p = m[0].replace(/[.,;:)]+$/, '');
    if (!p.includes('//') && !p.startsWith('http')) out.add(p);
  }
  return [...out];
}

/** Bounded walk gathering source-file evidence (path-labelled, truncated). */
export function gatherEvidence(
  projectRoot: string,
  maxFiles = DEFAULT_MAX_FILES,
  maxChars = DEFAULT_MAX_CHARS,
  spec?: string
): string {
  const root = projectRoot;
  // Collect a generous candidate pool FIRST, then priority-order and cut to
  // maxFiles — so neither walk order nor a data-heavy directory can starve
  // the implementation out of the evidence.
  const candidateCap = maxFiles * 10;
  const files: Array<{ abs: string; prio: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || files.length >= candidateCap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= candidateCap) return;
      if (SKIP_DIRS.has(e) || (e.startsWith('.') && e !== '.')) continue;
      const abs = join(dir, e);
      let st;
      try {
        st = lstatSync(abs); // lstat: do NOT follow symlinks (avoid cycles + escaping projectRoot)
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile() && SRC_EXT.test(e) && e !== 'package-lock.json' && !SECRET_FILE_RE.test(e) && st.size <= 200_000) {
        files.push({ abs, prio: evidencePriority(e) });
      }
    }
  };
  // Spec-referenced paths first: exact files at priority -1 (uncuttable),
  // spec-named directories walked before the root walk so their contents make
  // the candidate pool even in huge repos.
  if (spec) {
    for (const rel of specReferencedPaths(spec)) {
      if (rel.includes('..')) continue; // stay inside projectRoot
      const abs = join(root, rel);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // spec mentions it but it doesn't exist (yet) — nothing to show
      }
      if (st.isFile() && SRC_EXT.test(abs) && !SECRET_FILE_RE.test(abs) && st.size <= 200_000) {
        files.push({ abs, prio: -1 });
      } else if (st.isDirectory()) {
        walk(abs, 1);
      }
    }
  }
  walk(root, 0);
  // Dedupe (a spec-referenced file can also be found by a walk) keeping the
  // best (lowest) priority per path.
  const best = new Map<string, { abs: string; prio: number }>();
  for (const f of files) {
    const cur = best.get(f.abs);
    if (!cur || f.prio < cur.prio) best.set(f.abs, f);
  }
  const deduped = [...best.values()];
  deduped.sort((a, b) => a.prio - b.prio); // stable: insertion order preserved within a class
  const chosen = deduped.slice(0, maxFiles);

  let out = '';
  let used = 0;
  for (const f of chosen) {
    if (used >= maxChars) break;
    let content: string;
    try {
      content = readFileSync(f.abs, 'utf-8');
    } catch {
      continue;
    }
    const rel = relative(root, f.abs);
    const perFileCap = f.prio === 2 ? DATA_FILE_CHARS : PER_FILE_CHARS;
    const budget = Math.min(content.length, maxChars - used, perFileCap);
    out += `\n=== ${rel} ===\n${content.slice(0, budget)}\n`;
    used += budget;
  }
  return out.trim();
}

function buildPrompt(spec: string, evidence: string, runtimeNote?: string): string {
  return [
    'You are a strict acceptance reviewer. Decide whether the IMPLEMENTATION satisfies',
    'the EXPLICIT, checkable requirements in the SPEC. Judge ONLY from the code shown',
    '(and the runtime note if given) — do not assume anything not visible.',
    '',
    'Extract each concrete, verifiable requirement from the spec (ignore vague aesthetic',
    'wishes). For each, decide if the code clearly implements it. Be conservative: if the',
    'code does not show it, mark it not met.',
    '',
    '=== SPEC ===',
    spec.slice(0, 6_000),
    '',
    runtimeNote ? `=== RUNTIME OBSERVATION ===\n${runtimeNote}\n` : '',
    '=== IMPLEMENTATION (code) ===',
    evidence.slice(0, 64_000),
    '',
    'Respond with ONLY a JSON object, no prose, no code fences:',
    '{"criteria":[{"requirement":"<short>","met":true|false,"reason":"<short>"}],"pass":true|false}',
    'Set "pass" to true only if every important requirement is met.',
  ].join('\n');
}

/**
 * Extract the first PARSEABLE balanced top-level JSON object from model text.
 * If a balanced object fails to parse (e.g. a stray `{…}` fragment in the
 * preamble), it resumes scanning from the next `{` rather than giving up.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  let from = text.indexOf('{');
  while (from !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return null; // no balanced close — give up
    try {
      return JSON.parse(text.slice(from, end + 1)) as Record<string, unknown>;
    } catch {
      from = text.indexOf('{', from + 1); // malformed — try the next candidate
    }
  }
  return null;
}

/**
 * Run the acceptance gate. Fails OPEN (passed:true, parseError set) when the
 * model output is unparseable or the executor throws — a judgment gate must
 * never wedge delivery on its own nondeterminism.
 */
export async function runAcceptanceGate(opts: AcceptanceOptions): Promise<AcceptanceResult> {
  const evidence = opts.evidence ?? gatherEvidence(opts.projectRoot, opts.maxFiles, opts.maxChars, opts.spec);
  if (!evidence.trim()) {
    return { passed: true, score: 1, criteria: [], parseError: 'no source evidence found' };
  }

  let raw: string;
  try {
    raw = await opts.executor(buildPrompt(opts.spec, evidence, opts.runtimeNote));
  } catch (e) {
    return { passed: true, score: 1, criteria: [], parseError: `executor error: ${String(e).slice(0, 120)}` };
  }

  const parsed = extractJsonObject(raw);
  const rawCriteria = Array.isArray(parsed?.criteria) ? (parsed!.criteria as unknown[]) : null;
  if (!parsed || !rawCriteria) {
    return { passed: true, score: 1, criteria: [], parseError: 'unparseable judge verdict' };
  }

  const criteria: AcceptanceCriterion[] = rawCriteria
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        requirement: String(o.requirement ?? o.text ?? '').slice(0, 300),
        met: o.met === true,
        reason: String(o.reason ?? '').slice(0, 300),
      };
    })
    .filter((c) => c.requirement);

  if (criteria.length === 0) {
    return { passed: true, score: 1, criteria: [], parseError: 'no criteria extracted' };
  }

  const metCount = criteria.filter((c) => c.met).length;
  const score = metCount / criteria.length;
  // Ignore the model's self-reported "pass" (unreliable) and require every
  // extracted criterion to be met — conservative, matching the gate's purpose.
  const passed = metCount === criteria.length;

  return { passed, score, criteria };
}

/** Render a short human report of an acceptance result. */
export function formatAcceptanceReport(result: AcceptanceResult): string {
  if (result.parseError && result.criteria.length === 0) {
    return `ACCEPTANCE: skipped (${result.parseError})`;
  }
  const head = result.passed
    ? `ACCEPTANCE ✓ (${result.criteria.length}/${result.criteria.length} requirements met)`
    : `ACCEPTANCE ✗ (${result.criteria.filter((c) => c.met).length}/${result.criteria.length} requirements met)`;
  const lines = result.criteria.map((c) => `  [${c.met ? 'MET ' : 'MISS'}] ${c.requirement}${c.met ? '' : ` — ${c.reason}`}`);
  return [head, ...lines].join('\n');
}

/**
 * Churn breaker for the SECONDARY acceptance judge (objective gates exist and
 * passed; the judge only advises). Small local judges reject objectively-green
 * turns indefinitely when the spec contains process-shaped criteria they can't
 * verify from code ("read the files first", prior-attempt feedback) — wedging
 * the loop at 100% gates. This bounds consecutive judge flips per spec: after
 * `limit` consecutive rejections of green turns, the objective gates win.
 *
 * NOT for primary mode — there the judge IS the convergence target and the
 * loop's stagnation guard provides the bound.
 */
export function createAcceptanceChurnBreaker(
  limit: number,
  hasChangeEvidence?: () => boolean
): {
  check(
    spec: string,
    verdict: { passed: boolean; feedback: string; score?: number }
  ): { passed: boolean; feedback: string; score?: number; overridden?: boolean };
} {
  const cap = Math.max(1, Math.floor(limit));
  let flips = 0;
  let currentSpec: string | undefined;
  return {
    check(spec, verdict) {
      if (currentSpec !== spec) {
        currentSpec = spec;
        flips = 0;
      }
      if (verdict.passed) {
        flips = 0;
        return verdict;
      }
      flips++;
      // Zero-diff guard: "objectively green" only means PROGRESS when this
      // spec's turns actually changed something. On a green-at-rest baseline a
      // no-op turn is green by construction, and the breaker rubber-stamped
      // four hollow epics in a row (observed live 2026-07-10). Without change
      // evidence the judge keeps the verdict — a genuinely already-satisfied
      // goal must win the judge on evidence, not outlast it.
      if (hasChangeEvidence && !hasChangeEvidence()) {
        return verdict;
      }
      if (flips >= cap) {
        return {
          passed: true,
          overridden: true,
          score: verdict.score,
          feedback:
            `accepted on objective gates after ${flips} consecutive acceptance-judge rejections of ` +
            `objectively-green turns; last judge feedback (advisory): ${verdict.feedback.slice(0, 300)}`,
        };
      }
      return verdict;
    },
  };
}
