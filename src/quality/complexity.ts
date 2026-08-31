/**
 * Built-in complexity fallback scanner.
 *
 * When lizard / rust-code-analysis are installed their numbers are used
 * instead (see tools.ts). This heuristic exists so the gate is not toothless
 * on machines without external tooling. It is deliberately conservative:
 * function-region detection is generic (brace-balance for C-family, indent
 * for Python), and decision counting follows McCabe (cc = 1 + decisions) and
 * the SonarSource cognitive rules (decisions weighted by nesting depth).
 *
 * Accuracy note: it can disagree with lizard on exotic syntax. That is fine
 * for a ratcheted gate — the baseline freezes whatever the scanner reports,
 * and a project needing exact numbers installs lizard.
 *
 * PARITY: quality_metrics_gate.py mirrors this file decision-for-decision.
 * Change one, change both, and extend the parity corpus in
 * test/quality/quality-gate-enforcer.test.ts.
 */
import { LanguageFacts, stripNoise } from './languages.js';

export interface FunctionMetric {
  name: string;
  line: number;
  cyclomatic: number;
  cognitive: number;
  nloc: number;
}

export interface FileComplexity {
  functions: FunctionMetric[];
  /** Non-blank, non-comment lines of code in the whole file. */
  loc: number;
}

/** Count non-empty lines of comment-stripped content. */
export function countLoc(stripped: string): number {
  let n = 0;
  for (const line of stripped.split('\n')) if (line.trim()) n++;
  return n;
}

/** Boolean/ternary ops get a flat +1 cognitive (no nesting bump). */
const BOOL_OPS = new Set(['&&', '||', '?', 'and', 'or']);

function countDecisions(
  segment: string,
  facts: LanguageFacts,
  initialDepth = 0
): { cyclomatic: number; cognitive: number } {
  let cyclomatic = 1;
  let cognitive = 0;
  // Region segments include the function's own opening brace; callers pass
  // initialDepth = -1 there so nesting depth counts from INSIDE the function
  // (SonarSource convention), not from the header line.
  let depth = initialDepth;
  // Normalize modern TS before tokenizing: `??` counts as ONE decision (a
  // coalescing branch), `?.` counts as none (optional chaining is a guard,
  // not a branch SonarSource-style). Without this `a?.b ?? c` reads as three
  // phantom decisions. Keep in lockstep with quality_metrics_gate.py.
  const normalized = segment.replace(/\?\?/g, ' ? ').replace(/\?\./g, '.');
  // Word + operator scan in source order so cognitive nesting weighting works.
  const tokenRe = /[A-Za-z_][A-Za-z0-9_]*|&&|\|\||[?{}]/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(normalized)) !== null) {
    const tok = m[0];
    if (tok === '{') { depth++; continue; }
    if (tok === '}') { depth = Math.max(0, depth - 1); continue; }
    const isDecision =
      facts.decisionWords.includes(tok) || facts.decisionOps.includes(tok);
    if (isDecision) {
      cyclomatic++;
      // SonarSource cognitive: +1 for the decision, +1 per nesting level.
      // Binary boolean ops add 1 flat (no nesting bump). Keep BOOL_OPS in
      // lockstep with quality_metrics_gate.py (_BOOL_OPS).
      cognitive += BOOL_OPS.has(tok) ? 1 : 1 + Math.max(0, depth);
    }
  }
  return { cyclomatic, cognitive };
}

/**
 * Function-header detection, tried in order per line. Deliberately simple:
 * keyword forms first (including generators `function*`), then arrow
 * functions assigned to consts (pervasive in modern TS — missing them dumps
 * their bodies into the <module> score), then a method-style fallback that
 * rejects control-flow keywords. Built from strings (not regex literals) so
 * this module's own <module> score does not count the patterns' `?`s —
 * string contents are stripped before scanning.
 */
const RE_FUNC_KW = new RegExp('\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)\\s*\\(');
const RE_NAMED_KW = new RegExp('\\b(?:def|fn|func|fun)\\s+([A-Za-z_]\\w*)\\s*\\(');
const RE_ARROW = new RegExp(
  '^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=]+?)?=' +
    '\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{'
);
const RE_METHOD = new RegExp(
  '^\\s*(?:(?:public|private|protected|static|final|abstract|override|readonly|async|inline|virtual' +
    '|constexpr|pub|unsafe|extern|internal|sealed|partial|suspend|open|export|default|get|set)\\s+)*' +
    '([A-Za-z_$][\\w$]*)\\s*\\([^;{}]*\\)\\s*(?::\\s*[^{;]+?)?\\s*\\{'
);

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'case',
  'with', 'synchronized', 'lock', 'using', 'foreach', 'when', 'unless', 'until',
]);

/** Name of the function declared on this line, or null. */
export function functionHeader(line: string): string | null {
  let m = RE_FUNC_KW.exec(line) ?? RE_NAMED_KW.exec(line) ?? RE_ARROW.exec(line);
  if (m) return m[1];
  m = RE_METHOD.exec(line);
  if (m && !CONTROL_WORDS.has(m[1])) return m[1];
  return null;
}

interface BraceRegion {
  name: string;
  startLine: number;
  /** Depth at which the body sits. */
  startDepth: number;
  /** Whether the opening brace has been seen (false for multi-line
   * signatures whose `{` is on a later line). */
  entered: boolean;
}

function braceDelta(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '{') n++;
    else if (line[i] === '}') n--;
  }
  return n;
}

function scoreRegion(
  seg: string,
  facts: LanguageFacts,
  name: string,
  line: number,
  initialDepth: number
): FunctionMetric {
  const d = countDecisions(seg, facts, initialDepth);
  return { name, line, cyclomatic: d.cyclomatic, cognitive: d.cognitive, nloc: countLoc(seg) };
}

/** Module-level decisions score as a pseudo-function, so module-level
 * tangles are still gated (and stay in TS/Python signature parity). */
function moduleMetric(modLines: string[], facts: LanguageFacts): FunctionMetric | null {
  const seg = modLines.join('\n');
  const d = countDecisions(seg, facts);
  if (d.cyclomatic <= 1) return null;
  return { name: '<module>', line: 1, cyclomatic: d.cyclomatic, cognitive: d.cognitive, nloc: countLoc(seg) };
}

/** Python-style: a region starts at `def name(` and ends at the first
 * subsequent line whose indent <= the def's indent. */
function analyzeIndentRegions(lines: string[], loc: number, facts: LanguageFacts): FileComplexity {
  const functions: FunctionMetric[] = [];
  const modBuf: string[] = [];
  let open: { name: string; startLine: number; indent: number } | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!open) return;
    functions.push(scoreRegion(buf.join('\n'), facts, open.name, open.startLine, 0));
    open = null;
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dm = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
    if (dm) {
      flush();
      open = { name: dm[2], startLine: i + 1, indent: dm[1].length };
      buf.push(line);
      continue;
    }
    if (!open) {
      modBuf.push(line);
      continue;
    }
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (line.trim() && indent <= open.indent) {
      flush();
      modBuf.push(line); // the dedent line itself is module-level
      continue;
    }
    buf.push(line);
  }
  flush();
  const mod = moduleMetric(modBuf, facts);
  if (mod) functions.push(mod);
  return { functions, loc };
}

/** Classify a detected header line: open a region for it, or score it
 * in place (one-line functions) and stay at module level. */
function startBraceRegion(
  name: string,
  line: string,
  lineNo: number,
  depth: number,
  delta: number,
  facts: LanguageFacts,
  functions: FunctionMetric[]
): { region: BraceRegion | null; depth: number } {
  if (delta > 0) {
    return { region: { name, startLine: lineNo, startDepth: depth + delta, entered: true }, depth: depth + delta };
  }
  if (!line.includes('{')) {
    // Multi-line signature — the opening brace is on a later line. Open the
    // region now, anticipating the body one level above current depth (TS
    // overload signatures collapse into their implementation; fine for a
    // heuristic).
    return { region: { name, startLine: lineNo, startDepth: depth + 1, entered: false }, depth };
  }
  // One-line function (`function f() { ... }` on one line): the brace
  // balance never dips below startDepth, so without this branch the region
  // stays open and swallows the REST OF THE FILE into this function's
  // metrics. Score the header line alone.
  functions.push(scoreRegion(line, facts, name, lineNo, 0));
  return { region: null, depth: Math.max(0, depth + delta) };
}

/** Brace languages: find candidate headers, then brace-balance the region. */
function analyzeBraceRegions(lines: string[], loc: number, facts: LanguageFacts): FileComplexity {
  const functions: FunctionMetric[] = [];
  const fileBuf: string[] = [];
  let depth = 0;
  let open: BraceRegion | null = null;
  let buf: string[] = [];
  const closeRegion = () => {
    if (!open) return;
    functions.push(scoreRegion(buf.join('\n'), facts, open.name, open.startLine, -1));
    open = null;
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      buf.push(line);
      const d = braceDelta(line);
      depth += d;
      if (!open.entered) {
        if (d > 0) open.entered = true;
        continue; // never close-check before the body opens
      }
      if (depth < open.startDepth) closeRegion();
      continue;
    }
    const name = functionHeader(line);
    const delta = braceDelta(line);
    if (!name) {
      fileBuf.push(line);
      depth = Math.max(0, depth + delta);
      continue;
    }
    const started = startBraceRegion(name, line, i + 1, depth, delta, facts, functions);
    if (started.region) {
      open = started.region;
      buf = [line];
    }
    depth = started.depth;
  }
  // Unbalanced braces — score what we saw rather than dropping it.
  closeRegion();
  const mod = moduleMetric(fileBuf, facts);
  if (mod) functions.push(mod);
  return { functions, loc };
}

/** Split source into function-ish regions and score each. */
export function analyzeComplexity(content: string, facts: LanguageFacts): FileComplexity {
  const stripped = stripNoise(content, facts.commentStyle);
  const lines = stripped.split('\n');
  const loc = countLoc(stripped);
  return facts.indentBased
    ? analyzeIndentRegions(lines, loc, facts)
    : analyzeBraceRegions(lines, loc, facts);
}
