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
import { execSync } from 'child_process';
import { basename, join, relative, dirname } from 'path';
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
const SPEC_STOPWORDS = new Set([
  'the', 'and', 'with', 'that', 'this', 'from', 'must', 'should', 'when', 'have', 'has',
  'are', 'not', 'for', 'its', 'each', 'can', 'will', 'use', 'uses', 'using', 'all', 'any',
  'into', 'than', 'then', 'else', 'only', 'been', 'was', 'were', 'their', 'there', 'which',
  'while', 'shall', 'does', 'other', 'after', 'before', 'over', 'under', 'more', 'less',
  'least', 'most', 'some', 'such', 'very', 'them', 'they', 'your', 'you', 'file', 'files',
  'code', 'spec', 'requirement', 'requirements', 'implement', 'implemented', 'correct',
  'implementation', 'correctly', 'ensure', 'specified', 'specify', 'via', 'per', 'both',
  'same', 'also', 'see', 'shown', 'show', 'page', 'user', 'class', 'function', 'method',
  'const', 'true', 'false', 'null', 'return', 'value', 'values', 'object', 'array',
]);

/** Content keywords mined from a spec, most-frequent first. Exported for tests. */
export function specKeywords(spec: string, cap = 24): string[] {
  const counts = new Map<string, number>();
  for (const m of spec.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
    const w = m[0].toLowerCase();
    if (SPEC_STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([w]) => w);
}

/**
 * Keyword-matched regions from the UNSHOWN remainder of a truncated file.
 * Run Y (octopus variant, 2026-07-19): missile spawning existed at
 * player.js:241 but the evidence head ended long before it — the judge
 * (correctly fail-closed on truncation) reported "not visible" and MISSed
 * three requirements against implemented code, burning two split pieces of
 * 3 attempts x ~15 turns each. Slices show the judge the exact regions its
 * requirements name.
 */
function keywordSlices(
  content: string,
  shownChars: number,
  keywords: string[],
  maxRegions = 3,
  ctxLines = 2
): Array<{ startLine: number; text: string; matched: string }> {
  if (keywords.length === 0 || shownChars >= content.length) return [];
  const lines = content.split('\n');
  // First line index fully or partially beyond the shown prefix.
  let offset = 0;
  let firstHidden = 0;
  for (let i = 0; i < lines.length; i++) {
    offset += lines[i].length + 1;
    if (offset > shownChars) {
      firstHidden = i;
      break;
    }
  }
  const lower = keywords.map((k) => k.toLowerCase());
  const regions: Array<{ from: number; to: number; matched: string }> = [];
  for (let i = firstHidden; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    const hit = lower.find((k) => ll.includes(k));
    if (hit === undefined) continue;
    const from = Math.max(firstHidden, i - ctxLines);
    const to = Math.min(lines.length - 1, i + ctxLines + 1);
    const last = regions[regions.length - 1];
    if (last && from <= last.to + 1) {
      last.to = to;
    } else {
      if (regions.length >= maxRegions) break;
      regions.push({ from, to, matched: hit });
    }
  }
  return regions.map((r) => ({
    startLine: r.from + 1,
    text: lines.slice(r.from, r.to + 1).join('\n'),
    matched: r.matched,
  }));
}

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
      // Sorted: readdir returns filesystem hash order, which made evidence
      // content (and therefore judge verdicts) vary between machines/runs.
      entries = readdirSync(dir).sort();
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
  // the candidate pool even in huge repos. In BOTH cases the parent directory
  // is walked too: specs routinely reference files in template form
  // ("web/dash/tab-<name>.js") whose literal token never resolves, and the
  // siblings of a named file are usually the rest of the deliverable —
  // observed live 2026-07-11: 8 tab files sat next to the spec-named
  // styles.css yet were judged "not present" (4/7 MET instead of 7/7).
  if (spec) {
    const dirsToWalk = new Set<string>();
    for (const rel of specReferencedPaths(spec)) {
      if (rel.includes('..')) continue; // stay inside projectRoot
      const abs = join(root, rel);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        // Token doesn't resolve (template form / not created yet) — its
        // parent directory is still the best evidence lead.
        const parent = dirname(abs);
        if (parent.startsWith(root) && parent !== root) dirsToWalk.add(parent);
        continue;
      }
      if (st.isFile() && SRC_EXT.test(abs) && !SECRET_FILE_RE.test(abs) && st.size <= 200_000) {
        files.push({ abs, prio: -1 });
        const parent = dirname(abs);
        if (parent.startsWith(root) && parent !== root) dirsToWalk.add(parent);
      } else if (st.isDirectory()) {
        dirsToWalk.add(abs);
      }
    }
    for (const d of dirsToWalk) {
      try {
        if (lstatSync(d).isDirectory()) walk(d, 1);
      } catch {
        /* parent doesn't exist either — nothing to walk */
      }
    }
  }
  walk(root, 0);
  // Suffix-resolution pass: specs routinely name files by a SHORT relative
  // path ("signal_processing/mod.rs") while the file lives deeper in the tree
  // ("src/rust-pg-ext/src/signal_processing/mod.rs"). The literal join above
  // then misses, the file stays at prio 0 among dozens of siblings, and the
  // judge sees only its 600-char head — reporting implemented code as
  // "not visible" (observed live 2026-08-23: biquad DC-gain normalization at
  // signal_processing/mod.rs:42-51 judged MISS because the spec's
  // "signal_processing/mod.rs" never resolved to the real path). For every
  // spec-referenced path that did NOT resolve literally, promote any walked
  // file whose path ENDS WITH that suffix to prio -1.
  if (spec) {
    const unresolved = specReferencedPaths(spec).filter((rel) => {
      if (rel.includes('..')) return false;
      try {
        return !lstatSync(join(root, rel)).isFile();
      } catch {
        return true;
      }
    });
    if (unresolved.length > 0) {
      for (const f of files) {
        if (f.prio < 0) continue; // already promoted
        const rel = relative(root, f.abs);
        for (const rel2 of unresolved) {
          if (rel === rel2 || rel.endsWith('/' + rel2)) {
            f.prio = -2;
            break;
          }
        }
      }
    }
  }
  // User-validation report: agents/ is in SKIP_DIRS so the walk never reaches
  // it — inject explicitly at prio -2 (beats even spec-referenced files). The
  // report shows the judge what a REAL USER observed (per-step evidence,
  // console errors, HTTP statuses), the strongest signal for user-facing
  // requirements. Trust for the "ALL PASSED" claim is enforced separately via
  // the runtime note (buildUserPathsNote hash check), not here — as raw
  // evidence the judge may weigh even an unverified report's step detail.
  try {
    const reportAbs = join(root, 'agents', 'data', 'validation', 'latest.json');
    const st = lstatSync(reportAbs);
    if (st.isFile() && st.size <= 200_000) files.push({ abs: reportAbs, prio: -2 });
  } catch {
    /* no validation report — nothing to inject */
  }
  // Symbol-aware priority: sub-epic specs routinely say "the Player class"
  // without ever writing "player.js" — the literal-path pass above then
  // leaves the ONE file the epic is about at prio 0, where alphabetical
  // extension starves it (observed live, run H 2026-07-17: a player epic's
  // evidence granted player.js only its 600-char head; the judge truthfully
  // reported the file "ends at the imports" and failed 6 straight attempts
  // against implemented code). If a source file's basename appears as a word
  // in the spec, it IS the deliverable — promote it.
  if (spec) {
    const specLower = spec.toLowerCase();
    // Separator-insensitive too: specs say "ScoreManager" while the file is
    // score-manager.js — the word-boundary match on the hyphenated basename
    // never fires and the deliverable starves to its head anyway (run I,
    // 2026-07-17: judge honestly reported score-manager.js "truncated at 600
    // characters" and failed the epic against implemented code).
    const specSquashed = specLower.replace(/[-_\s]/g, '');
    for (const f of files) {
      if (f.prio !== 0) continue;
      const base = basename(f.abs).replace(/\.[^.]+$/, '').toLowerCase();
      if (base.length < 3) continue;
      const wordHit = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(specLower);
      const squashedHit = base.replace(/[-_]/g, '').length >= 5 && specSquashed.includes(base.replace(/[-_]/g, ''));
      if (wordHit || squashedHit) {
        f.prio = -1;
      }
    }
  }
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

  // Two-pass assembly. The old single pass `break`-ed when the char budget
  // ran out, so a few large early files silently erased every file after
  // them — the judge then reported those files as "not present" (observed
  // live 2026-07-11: four 9-20K spec-named modules exhausted the 60K budget
  // and eight 600-byte sibling stubs vanished from evidence; which files
  // starved even varied with readdir hash order). Pass 1 guarantees EVERY
  // chosen file a head (existence + its opening lines — enough to verify
  // "file X exists and registers Y"); pass 2 spends the remaining budget
  // extending files in priority order.
  const contents = new Map<string, string>();
  for (const f of chosen) {
    try {
      contents.set(f.abs, readFileSync(f.abs, 'utf-8'));
    } catch {
      /* unreadable — skip */
    }
  }
  const HEAD_CHARS = 600;
  const granted = new Map<string, number>();
  let used = 0;
  for (const f of chosen) {
    const content = contents.get(f.abs);
    if (content === undefined || used >= maxChars) continue;
    const head = Math.min(content.length, HEAD_CHARS, maxChars - used);
    granted.set(f.abs, head);
    used += head;
  }
  for (const f of chosen) {
    const content = contents.get(f.abs);
    if (content === undefined || used >= maxChars) continue;
    const perFileCap = f.prio === 2 ? DATA_FILE_CHARS : PER_FILE_CHARS;
    const cur = granted.get(f.abs) ?? 0;
    const extra = Math.min(content.length, perFileCap) - cur;
    if (extra <= 0) continue;
    const grant = Math.min(extra, maxChars - used);
    granted.set(f.abs, cur + grant);
    used += grant;
  }
  let out = '';
  for (const f of chosen) {
    const content = contents.get(f.abs);
    const take = granted.get(f.abs) ?? 0;
    if (content === undefined || take <= 0) continue;
    const rel = relative(root, f.abs);
    const marker =
      take < content.length
        ? `\n…[TRUNCATED by evidence budget: showing ${take} of ${content.length} chars — this file CONTINUES beyond this point]`
        : '';
    out += `\n=== ${rel} ===\n${content.slice(0, take)}${marker}\n`;
  }
  // Criterion-aware slices: keyword-matched regions from beyond each
  // truncated file's cutoff, in a bounded overdraft (<=15% of maxChars) so
  // the main-budget behavior above stays byte-identical. Without these, the
  // judge fail-closes on exactly the code its requirements name (run Y,
  // 2026-07-19: missile spawning at player.js:241, invisible past the head).
  if (spec) {
    const keywords = specKeywords(spec);
    let sliceBudget = Math.floor(maxChars * 0.15);
    let sliceOut = '';
    for (const f of chosen) {
      if (sliceBudget <= 0) break;
      const content = contents.get(f.abs);
      const take = granted.get(f.abs) ?? 0;
      if (content === undefined || take <= 0 || take >= content.length) continue;
      for (const slice of keywordSlices(content, take, keywords)) {
        const block = `\n--- ${relative(root, f.abs)} @ line ${slice.startLine} (matched: ${slice.matched}) ---\n${slice.text}\n`;
        if (block.length > sliceBudget) break;
        sliceOut += block;
        sliceBudget -= block.length;
      }
    }
    if (sliceOut) {
      out += `\n=== RELEVANT SLICES — regions from BEYOND the truncation point of the files above, matched to the spec's own terms. These are part of the same files; use them before judging anything "not visible". ===\n${sliceOut}`;
    }
  }
  return out.trim();
}

/**
 * Change summary for the judge prompt (C1, deliver-hardening 2026-07-13): the
 * judge used to re-derive the run's scope from a whole-tree evidence walk,
 * with no idea what the run actually TOUCHED. `git status --porcelain` covers
 * modified AND untracked files (a brand-new deliverable is untracked until
 * committed); `git diff HEAD --stat` gives magnitude. Empty when git is
 * unavailable — the deterministic empty-diff rail lives in the convergence
 * loop, so a missing note is never the only guard against a no-op.
 */
export function gitChangeSummary(projectRoot: string): string {
  const git = (args: string): string => {
    try {
      return execSync(`git ${args}`, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
    } catch {
      return '';
    }
  };
  const files = git('status --porcelain')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, 200);
  if (files.length === 0) return '';
  const stat = git('diff HEAD --stat').split('\n').slice(-40).join('\n');
  return [`Changed files (${files.length}):`, ...files.map((f) => `  ${f}`), '', stat]
    .join('\n')
    .slice(0, 4_000);
}

function buildPrompt(spec: string, evidence: string, runtimeNote?: string, changeNote?: string): string {
  return [
    'You are a strict acceptance reviewer. Decide whether the IMPLEMENTATION satisfies',
    'the EXPLICIT, checkable requirements in the SPEC. Judge ONLY from the code shown',
    '(and the runtime/change notes if given) — do not assume anything not visible.',
    '',
    'Extract each concrete, verifiable requirement from the spec (ignore vague aesthetic',
    'wishes). For each, decide if the code clearly implements it. Be conservative: if the',
    'code does not show it, mark it not met.',
    '',
    'EXCEPTION — truncated evidence: a file whose excerpt ends with "[TRUNCATED by',
    'evidence budget…]" CONTINUES beyond what is shown. Never describe such a file as',
    'incomplete, cut off, or "ending abruptly", and never treat content absent AFTER the',
    'cut as proof it does not exist — judge those requirements from the visible portion',
    'and any other files that reference the symbol.',
    '',
    '=== SPEC ===',
    spec.slice(0, 6_000),
    '',
    runtimeNote ? `=== RUNTIME OBSERVATION ===\n${runtimeNote}\n` : '',
    // The diff is against HEAD, not against run start: in a SHARED worktree
    // (several agents on one tree) it lists other agents' uncommitted work
    // too, so it is labeled as the tree's current change-set, not "this run's"
    // — attributing it to the run would steer the judge to grade the spec
    // against work this run never made (review fix, 2026-07-13).
    changeNote ? `=== UNCOMMITTED CHANGES IN THIS TREE (git) ===\n${changeNote}\nThis is the tree's current uncommitted change-set — in a shared worktree it may include work by other agents, not only this run's. The spec's requirements should be addressed by these changes — if none of the changed files relate to a requirement, that is strong evidence it is not met.\n` : '',
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
    raw = await opts.executor(buildPrompt(opts.spec, evidence, opts.runtimeNote, gitChangeSummary(opts.projectRoot) || undefined));
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
