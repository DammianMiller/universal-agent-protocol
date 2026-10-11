/**
 * B1 · Plan comprehension gate — deterministic readability rules for
 * markdown plan artifacts.
 *
 * After Lynch's "agents suck at communicating plans" (mtlynch.io,
 * "Why Are Coding Agents So Dumb?"): agents enumerate low-level details and
 * call it a plan. A competent developer starts at a high level and works
 * toward the minutiae; a human reading the artifact top-down should be able to
 * skim WHAT is being built before HOW. These rules are the deterministic floor
 * under that expectation.
 *
 * Enforcement posture (mirrors `runPlanThoughtExperiment`'s adjudicated-hints
 * contract in src/delivery/plan-check.ts): findings are HINTS the judge-model
 * review confirms or dismisses on the merits — pattern-matched heuristics do
 * not hard-block on their own. Operators who want deterministic teeth set
 * `strict: true` (config or UAP_PLAN_READABILITY_STRICT=1): then error-severity
 * findings fail `uap plan validate` outright, subject to the existing --force
 * escape hatch.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface PlanReadabilityConfig {
  /** Master switch. Default true; `UAP_PLAN_READABILITY=0` disables. */
  enabled?: boolean;
  /**
   * Error-severity findings block the `uap plan validate` stamp (before the
   * model review's verdict is even consulted) instead of being adjudicated
   * hints. Default false — the plan gate must never deadlock a legitimate
   * build on a heuristic. `UAP_PLAN_READABILITY_STRICT=1` forces strict.
   */
  strict?: boolean;
  /** Minimum prose words between the title and the first section. Default 20. */
  minSummaryWords?: number;
  /** Soft word budget per section before a warning. Default 300. */
  maxWordsPerSection?: number;
  /** Jargon tokens / prose words above which a warning fires. Default 0.35. */
  jargonDensityThreshold?: number;
  /**
   * Task items at which a data-flow diagram (mermaid or image) is required.
   * 0 disables the rule. Default 5.
   */
  requireDiagramAtTasks?: number;
}

export interface PlanReadabilityFinding {
  /** Stable rule id: summary-first | abstraction-progress | section-budget | jargon-density | diagram-required */
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PlanReadabilityReport {
  /** True when no error-severity findings fired (warnings are advisory). */
  passed: boolean;
  findings: PlanReadabilityFinding[];
  /** Rendered lines to embed into the judge-model review prompt. */
  hintBlock: string[];
  /** Count of checklist/ordered-list task items the diagram rule saw. */
  taskItemCount: number;
  /** True when the scan was disabled via config/env (report is a no-op). */
  disabled: boolean;
  /** True when error-severity findings should block the stamp. */
  strict: boolean;
}

export const DEFAULT_PLAN_READABILITY: Required<Omit<PlanReadabilityConfig, 'enabled' | 'strict'>> = {
  minSummaryWords: 20,
  maxWordsPerSection: 300,
  jargonDensityThreshold: 0.35,
  requireDiagramAtTasks: 5,
};

/**
 * Merge caller overrides, `.uap.json` `plan.readability`, and env kill
 * switches over the defaults. Pure with respect to `partial`; env and config
 * file reads happen here so the analysis itself stays pure and unit-testable.
 */
export function resolvePlanReadabilityConfig(
  partial?: PlanReadabilityConfig,
  projectDir?: string
): Required<PlanReadabilityConfig> {
  let fromFile: PlanReadabilityConfig = {};
  const dir = projectDir ?? process.cwd();
  const configPath = join(dir, '.uap.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (parsed?.plan?.readability && typeof parsed.plan.readability === 'object') {
        fromFile = parsed.plan.readability as PlanReadabilityConfig;
      }
    } catch {
      // Config parse failure is non-fatal — defaults apply.
    }
  }
  const merged: Required<PlanReadabilityConfig> = {
    enabled: true,
    strict: false,
    ...DEFAULT_PLAN_READABILITY,
    ...fromFile,
    ...partial,
  };
  if (process.env.UAP_PLAN_READABILITY === '0') merged.enabled = false;
  if (process.env.UAP_PLAN_READABILITY_STRICT === '1') merged.strict = true;
  return merged;
}

// ---------------------------------------------------------------------------
// Markdown micro-parser (line-based, deliberately simple and deterministic)
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  level: number;
  lines: string[];
}

const HEADING_RE = /^(#{1,6}) (.+)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const CHECKBOX_RE = /^\s*[-*]\s+\[[ xX]\]\s+/;
const ORDERED_RE = /^\s*\d+[.)]\s+/;
const IMAGE_RE = /!\[[^\]]*\]\(/;
const MERMAID_FENCE_RE = /^\s*(```|~~~)\s*mermaid\b/i;

function splitSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: '', level: 0, lines: [] };
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (current.lines.length > 0 || current.heading) sections.push(current);
      current = { heading: m[2].trim(), level: m[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((s) => s.heading !== '' || s.lines.some((l) => l.trim() !== ''));
}

/** Lines outside code fences — fences are detail, not prose. */
function proseLines(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

function countWords(lines: string[]): number {
  let words = 0;
  for (const line of lines) {
    for (const tok of line.split(/\s+/)) {
      if (/[A-Za-z0-9]/.test(tok)) words += 1;
    }
  }
  return words;
}

/** Strips list markers so "1. build" counts as prose word "build", not list scaffolding. */
function stripListMarkers(line: string): string {
  return line.replace(CHECKBOX_RE, '').replace(ORDERED_RE, '');
}

function detailMarkers(lines: string[]): number {
  let markers = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // Count a fenced block once (on its opening line), not per fence marker.
      if (!inFence) markers += 1;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    markers += (line.match(/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/g) ?? []).length;
    markers += (line.match(/`[^`]+`/g) ?? []).length;
  }
  return markers;
}

const JARGON_RES = [
  // Flattened, deliberately non-nested camelCase shape (security review: the
  // nested `\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b` variant backtracks
  // exponentially on crafted input and hung `uap plan validate` at ~30 chars).
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
  /\b[a-z]+_[a-z0-9]+\b/g, // snake_case
  /\b[A-Z]{2,}\b/g, // acronyms
];

/**
 * Clip a plan-authored fragment before it is echoed into a finding message
 * (which later ships to the judge-model endpoint): bounded length, no
 * control characters. Plan text is untrusted input — the messages carry it,
 * so the messages must not carry MORE of it than the rule needs.
 */
function clip(s: string, max = 80): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the point
  const clean = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkSummaryFirst(
  preambleLines: string[],
  firstContent: Section | undefined,
  minWords: number,
  findings: PlanReadabilityFinding[]
): void {
  const prose = proseLines(preambleLines);
  const fenceBeforeProse = preambleLines.findIndex((l) => FENCE_RE.test(l)) !== -1 &&
    preambleLines.findIndex((l) => FENCE_RE.test(l)) <
      preambleLines.findIndex((l) => l.trim() !== '' && !FENCE_RE.test(l));
  if (fenceBeforeProse) {
    findings.push({
      rule: 'summary-first',
      severity: 'error',
      message: 'plan opens with a code block — the executive summary must come before any code or configuration detail',
    });
  }
  const words = countWords(prose.map(stripListMarkers));
  if (words >= minWords) return;
  // The common `# Title` + `## Summary` shape has an EMPTY preamble by
  // construction (code-review finding: strict mode must not hard-block it).
  // When the first section IS a summary, it satisfies the rule; when it is
  // merely long prose, the plan is readable but front-loads the summary in
  // the wrong place — warn instead of blocking.
  const firstWords = firstContent
    ? countWords(proseLines(firstContent.lines).map(stripListMarkers))
    : 0;
  if (firstContent && firstWords >= minWords) {
    const summaryLike = /summary|overview|goal|objective|intent/i.test(firstContent.heading);
    if (!summaryLike) {
      findings.push({
        rule: 'summary-first',
        severity: 'warning',
        message: `the executive summary should sit in the preamble, before the first section ("${clip(firstContent.heading)}") — move it up so a reader skims top-down`,
      });
    }
    return;
  }
  findings.push({
    rule: 'summary-first',
    severity: 'error',
    message: `plan must open with a ${minWords}-word executive summary before the first section (found ${words} word${words === 1 ? '' : 's'} of prose) — a reader should learn WHAT is being built before HOW`,
  });
}

function checkAbstractionProgress(
  sections: Section[],
  findings: PlanReadabilityFinding[]
): void {
  const headed = sections.filter((s) => s.heading !== '');
  // The title section carries the preamble prose, so its detail density is low
  // by construction — the rule compares CONTENT sections, i.e. everything
  // after the document title.
  const content = headed[0]?.level === 1 ? headed.slice(1) : headed;
  if (content.length < 2) return;
  const first = detailMarkers(content[0].lines);
  const last = detailMarkers(content[content.length - 1].lines);
  if (first >= 2 && first > last) {
    findings.push({
      rule: 'abstraction-progress',
      severity: 'warning',
      message: `detail density is front-loaded (section "${clip(content[0].heading)}" has ${first} detail markers, the last section "${clip(content[content.length - 1].heading)}" has ${last}) — start at a high level of abstraction and progress toward the minutiae`,
    });
  }
}

function checkSectionBudget(
  sections: Section[],
  maxWords: number,
  findings: PlanReadabilityFinding[]
): void {
  const flagged: string[] = [];
  for (const s of sections) {
    const words = countWords(proseLines(s.lines).map(stripListMarkers));
    if (words > maxWords) flagged.push(`"${clip(s.heading || '(preamble)')}" (${words} words)`);
  }
  if (flagged.length > 0) {
    findings.push({
      rule: 'section-budget',
      severity: 'warning',
      message: `section(s) exceed the ${maxWords}-word budget: ${flagged.slice(0, 3).join(', ')}${flagged.length > 3 ? `, +${flagged.length - 3} more` : ''} — split them so each section makes one point`,
    });
  }
}

function checkJargonDensity(
  lines: string[],
  threshold: number,
  findings: PlanReadabilityFinding[]
): void {
  // Headings are navigation, not prose — a token-dense heading must not move
  // the prose density either way.
  const prose = proseLines(lines)
    .filter((l) => !HEADING_RE.test(l))
    .map(stripListMarkers)
    .join(' ');
  const words = countWords([prose]);
  if (words < 30) return; // too little text for a density to mean anything
  const samples = new Set<string>();
  let jargon = 0;
  for (const re of JARGON_RES) {
    const matches = prose.match(re);
    if (matches) {
      jargon += matches.length;
      matches.slice(0, 5).forEach((m) => samples.add(m));
    }
  }
  const density = jargon / words;
  if (density > threshold) {
    const list = [...samples].slice(0, 5).map((m) => clip(m, 40)).join(', ');
    findings.push({
      rule: 'jargon-density',
      severity: 'warning',
      message: `jargon density ${(100 * density).toFixed(0)}% exceeds the ${(100 * threshold).toFixed(0)}% budget (${jargon} jargon tokens in ${words} words; e.g. ${list}) — define or replace identifiers a reviewer may not share`,
    });
  }
}

function checkDiagramRequired(
  lines: string[],
  atTasks: number,
  findings: PlanReadabilityFinding[]
): { taskItemCount: number } {
  if (atTasks <= 0) return { taskItemCount: 0 };
  let taskItemCount = 0;
  let inFence = false;
  let hasDiagram = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (MERMAID_FENCE_RE.test(line)) hasDiagram = true;
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      if (CHECKBOX_RE.test(line) || ORDERED_RE.test(line)) taskItemCount += 1;
      if (IMAGE_RE.test(line)) hasDiagram = true;
    }
  }
  if (taskItemCount >= atTasks && !hasDiagram) {
    findings.push({
      rule: 'diagram-required',
      severity: 'error',
      message: `${taskItemCount} task items but no diagram — plans with ≥${atTasks} tasks require a data-flow diagram (mermaid or image) so a reader can see the moving parts before the steps`,
    });
  }
  return { taskItemCount };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Pure readability analysis of a markdown plan artifact. No I/O; config
 * resolution (`.uap.json`, env) happens in `resolvePlanReadabilityConfig`,
 * and callers may pass a pre-resolved config to pin behavior in tests.
 */
export function analyzePlanReadability(
  text: string,
  config: PlanReadabilityConfig = {}
): PlanReadabilityReport {
  const cfg = {
    ...DEFAULT_PLAN_READABILITY,
    enabled: true,
    strict: false,
    ...config,
  };
  if (!cfg.enabled) {
    return { passed: true, findings: [], hintBlock: [], taskItemCount: 0, disabled: true, strict: false };
  }
  const lines = text.split('\n');
  const sections = splitSections(lines);
  // Preamble = the prose between the title heading and the FIRST section
  // heading (or the whole document when there are no headings at all). It is
  // deliberately bounded: a plan whose body contains plenty of words but
  // whose OPENING is empty still fails summary-first.
  const titleIdx = lines.findIndex((l) => HEADING_RE.test(l));
  const after = titleIdx === -1 ? lines : lines.slice(titleIdx + 1);
  const nextHeadingIdx = after.findIndex((l) => HEADING_RE.test(l));
  const preambleLines = nextHeadingIdx === -1 ? after : after.slice(0, nextHeadingIdx);

  const findings: PlanReadabilityFinding[] = [];
  const headed = sections.filter((s) => s.heading !== '');
  // First CONTENT section: after the title section when a title heading
  // exists, else the first heading section (the doc then opens with prose).
  const firstContent = titleIdx === -1 ? headed[0] : headed[1];
  checkSummaryFirst(preambleLines, firstContent, cfg.minSummaryWords, findings);
  checkAbstractionProgress(sections, findings);
  checkSectionBudget(sections, cfg.maxWordsPerSection, findings);
  checkJargonDensity(lines, cfg.jargonDensityThreshold, findings);
  const { taskItemCount } = checkDiagramRequired(lines, cfg.requireDiagramAtTasks, findings);

  const errors = findings.filter((f) => f.severity === 'error');
  const hintBlock =
    findings.length > 0
      ? [
          '',
          'AUTOMATED READABILITY FINDINGS (a cheap static check flagged these — treat as',
          'leads to verify, NOT as verdicts; confirm or dismiss each on the merits):',
          ...findings.map((f, i) => `  ${i + 1}. [${f.severity}] ${f.rule}: ${f.message}`),
        ]
      : [];
  return {
    passed: errors.length === 0,
    findings,
    hintBlock,
    taskItemCount,
    disabled: false,
    strict: cfg.strict === true,
  };
}
