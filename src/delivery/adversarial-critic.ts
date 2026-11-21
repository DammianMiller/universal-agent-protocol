/**
 * Clean-Context Thinking-ON Adversarial Critic (Option C1)
 *
 * Breaks self-anchoring bias by evaluating the produced artifact in a 100%
 * fresh, zero-history completion with thinking explicitly ON (`x-uap-reasoning: 1`).
 * Works identically in single-arm local mode (same model, fresh context) AND
 * asymmetric multi-arm mode (C3 role router).
 *
 * Inputs ONLY:
 *   1. Original user prompt / spec
 *   2. Phase 0 Outcome Blueprint (when present)
 *   3. Observed outputs: source evidence, static hollowness + runtime invariant
 *      telemetry, and multi-perspective screenshots (when available).
 *
 * Emits a 5-axis structured verdict (0-10 each) and severity-ranked defect
 * tickets (`blocker` > `major` > `polish`), enforcing anti-dithering (forbidding
 * cosmetic polish tweaks while structural/completeness defects remain).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractJsonObject, gatherEvidence } from './acceptance-judge.js';
import { loadOutcomeBlueprint, type OutcomeBlueprint } from './outcome-blueprint.js';
import { buildRuntimeHollownessNote } from './runtime-invariants.js';
import type { RoleExecutor } from './role-router.js';

export interface AdversarialAxes {
  completeness: number;
  craftDensity: number;
  cohesionPolish: number;
  framingErgonomics: number;
  runtimeIntegrity: number;
}

export type AdversarialSeverity = 'blocker' | 'major' | 'polish';

export interface AdversarialTicket {
  severity: AdversarialSeverity;
  axis: string;
  target: string;
  defect: string;
  fix: string;
}

export interface AdversarialCritiqueVerdict {
  axes: AdversarialAxes;
  overallScore: number;
  minAxisScore: number;
  pass: boolean;
  tickets: AdversarialTicket[];
  nextFocus: string;
  parseError?: string;
}

export interface RunAdversarialCriticOptions {
  spec: string;
  projectRoot: string;
  /** Zero-history thinking-ON executor (text + optional image data URLs). */
  executor: RoleExecutor;
  blueprint?: OutcomeBlueprint | null;
  runtimeNote?: string;
  visualNote?: string;
  interactionNote?: string;
  screenshotPaths?: string[];
  /** Override source evidence (for unit tests). */
  evidence?: string;
  /** Minimum score required on EVERY axis to pass (default 8). */
  minScore?: number;
}

const DEFAULT_MIN_SCORE = 8;
const DEFAULT_MAX_PASSES = 2;
const MAX_TICKETS = 8;
const MAX_SCREENSHOTS = 4;
const SEVERITY_RANK: Record<AdversarialSeverity, number> = { blocker: 0, major: 1, polish: 2 };

interface RawAdversarialPayload {
  axes?: Record<string, number | string | undefined>;
  tickets?: Array<Record<string, string | undefined>>;
  nextFocus?: string;
  next_focus?: string;
}

function clampAxis(val: number | string | undefined): number | null {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
}

function parseAxes(raw: Record<string, number | string | undefined> | undefined): AdversarialAxes | null {
  if (!raw || typeof raw !== 'object') return null;
  const completeness = clampAxis(raw.completeness);
  const craftDensity = clampAxis(raw.craftDensity ?? raw.craft_density);
  const cohesionPolish = clampAxis(raw.cohesionPolish ?? raw.cohesion_polish);
  const framingErgonomics = clampAxis(raw.framingErgonomics ?? raw.framing_ergonomics);
  const runtimeIntegrity = clampAxis(raw.runtimeIntegrity ?? raw.runtime_integrity);
  if (
    completeness === null ||
    craftDensity === null ||
    cohesionPolish === null ||
    framingErgonomics === null ||
    runtimeIntegrity === null
  ) {
    return null;
  }
  return { completeness, craftDensity, cohesionPolish, framingErgonomics, runtimeIntegrity };
}

function parseTickets(
  raw: Array<Record<string, string | undefined>> | undefined,
  minAxisScore: number
): AdversarialTicket[] {
  if (!Array.isArray(raw)) return [];
  const parsed: AdversarialTicket[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const sevRaw = String(item.severity ?? 'major').toLowerCase();
    const severity: AdversarialSeverity =
      sevRaw === 'blocker' || sevRaw === 'major' || sevRaw === 'polish' ? sevRaw : 'major';
    const defect = typeof item.defect === 'string' ? item.defect.trim() : '';
    const fix = typeof item.fix === 'string' ? item.fix.trim() : '';
    if (!defect && !fix) continue;
    parsed.push({
      severity,
      axis: typeof item.axis === 'string' && item.axis.trim() ? item.axis.trim() : 'completeness',
      target: typeof item.target === 'string' && item.target.trim() ? item.target.trim() : 'artifact',
      defect: defect || fix,
      fix: fix || defect,
    });
  }
  parsed.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  // Anti-dithering rule: suppress cosmetic 'polish' tickets whenever any
  // structural blocker/major exists OR any axis scores below 7.
  const hasStructural = parsed.some((t) => t.severity === 'blocker' || t.severity === 'major');
  const filtered =
    hasStructural || minAxisScore < 7
      ? parsed.filter((t) => t.severity !== 'polish')
      : parsed;
  return (filtered.length > 0 ? filtered : parsed).slice(0, MAX_TICKETS);
}

/** Parse structured JSON output from the adversarial critic into a verdict. */
export function parseAdversarialCritique(
  raw: string,
  minScore = DEFAULT_MIN_SCORE
): AdversarialCritiqueVerdict | null {
  const obj = extractJsonObject(raw) as RawAdversarialPayload | null;
  if (!obj) return null;
  const axes = parseAxes(obj.axes);
  if (!axes) return null;

  const scores = [
    axes.completeness,
    axes.craftDensity,
    axes.cohesionPolish,
    axes.framingErgonomics,
    axes.runtimeIntegrity,
  ];
  const minAxisScore = Math.min(...scores);
  const overallScore = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
  const tickets = parseTickets(obj.tickets, minAxisScore);
  const hasBlockingTicket = tickets.some(
    (t) => t.severity === 'blocker' || t.severity === 'major'
  );
  const pass = minAxisScore >= minScore && !hasBlockingTicket;
  const nextFocusRaw = obj.nextFocus ?? obj.next_focus;
  const nextFocus =
    typeof nextFocusRaw === 'string' && nextFocusRaw.trim()
      ? nextFocusRaw.trim()
      : tickets[0]
        ? `${tickets[0].target}: ${tickets[0].fix}`
        : pass
          ? 'Deliverable meets the quality bar across all 5 axes.'
          : 'Address the lowest-scoring axis first.';

  return { axes, overallScore, minAxisScore, pass, tickets, nextFocus };
}

/** Build the fresh-context adversarial critique prompt (zero builder history). */
export function buildAdversarialCriticPrompt(opts: {
  spec: string;
  blueprint?: OutcomeBlueprint | null;
  hollownessNote: string;
  evidence: string;
  hasScreenshots: boolean;
  minScore: number;
}): string {
  const bpBlock = opts.blueprint
    ? [
        '=== PHASE 0 OUTCOME BLUEPRINT ===',
        `Summary: ${opts.blueprint.summary}`,
        opts.blueprint.subsystems.length
          ? 'Subsystems: ' + opts.blueprint.subsystems.map((s) => `${s.name} (${s.purpose})`).join('; ')
          : '',
        opts.blueprint.fidelityTargets.length
          ? 'Fidelity targets:\n' + opts.blueprint.fidelityTargets.map((t) => `- ${t}`).join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return [
    'You are an independent, adversarial quality reviewer seeing this deliverable for the FIRST time with zero builder history.',
    'Do NOT rationalize away missing features, hollow stubs, broken lookups, or bare-bones implementations.',
    'Score the deliverable honestly on 5 independent axes (0-10 each; target >= ' + opts.minScore + ' on EVERY axis):',
    '  1. completeness — every required subsystem, feature, and invariant from the spec/blueprint is genuinely implemented (not omitted or stubbed).',
    '  2. craftDensity — flagship richness, depth, and structural craft rather than a minimal placeholder or toy draft.',
    '  3. cohesionPolish — unified architecture, clean aesthetics/interfaces, consistent ergonomics and finish.',
    '  4. framingErgonomics — clarity of presentation, usability, layout/framing/API ergonomics without clipping, clutter, or awkwardness.',
    '  5. runtimeIntegrity — zero static hollowness defects (undefined constant lookups, dead stubs), zero runtime errors, verified real execution.',
    '',
    'Emit severity-ranked defect tickets ("blocker" > "major" > "polish").',
    'STRICT ANTI-DITHERING RULE: Do NOT emit "polish" cosmetic tweaks while ANY "blocker" or "major" defect exists or ANY axis is below 7.',
    'Every ticket must cite a concrete file/subsystem target, the observed defect, and an actionable fix.',
    opts.hasScreenshots ? 'Rendered screenshots are attached — inspect them critically alongside the source code.' : '',
    '',
    '=== ORIGINAL SPECIFICATION ===',
    opts.spec.slice(0, 6000),
    bpBlock,
    opts.hollownessNote ? `=== RUNTIME INVARIANTS & HOLLOWNESS SCAN ===\n${opts.hollownessNote}` : '',
    '=== OBSERVED SOURCE EVIDENCE ===',
    opts.evidence.slice(0, 56000),
    '',
    'Respond with ONLY a JSON object:',
    '{"axes":{"completeness":0,"craftDensity":0,"cohesionPolish":0,"framingErgonomics":0,"runtimeIntegrity":0},"tickets":[{"severity":"blocker|major|polish","axis":"<axis>","target":"<file/subsystem>","defect":"<observed defect>","fix":"<concrete fix>"}],"nextFocus":"<single highest-leverage structural upgrade>"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function loadScreenshotDataUrls(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const urls: string[] = [];
  for (const p of paths.slice(0, MAX_SCREENSHOTS)) {
    if (!existsSync(p)) continue;
    try {
      const b64 = readFileSync(p).toString('base64');
      urls.push(`data:image/png;base64,${b64}`);
    } catch {
      /* ignore unreadable screenshot */
    }
  }
  return urls;
}

/** Run the clean-context thinking-ON adversarial critic. Fails open on infra/parse errors. */
export async function runAdversarialCritic(
  opts: RunAdversarialCriticOptions
): Promise<AdversarialCritiqueVerdict> {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const fallbackPass = (parseError: string): AdversarialCritiqueVerdict => ({
    axes: {
      completeness: minScore,
      craftDensity: minScore,
      cohesionPolish: minScore,
      framingErgonomics: minScore,
      runtimeIntegrity: minScore,
    },
    overallScore: minScore,
    minAxisScore: minScore,
    pass: true,
    tickets: [],
    nextFocus: '',
    parseError,
  });

  const evidence = opts.evidence ?? gatherEvidence(opts.projectRoot, 40, 56_000, opts.spec);
  if (!evidence.trim()) return fallbackPass('no source evidence found');

  const blueprint = opts.blueprint !== undefined ? opts.blueprint : loadOutcomeBlueprint(opts.projectRoot);
  const hollownessNote = buildRuntimeHollownessNote(opts.projectRoot, {
    execNote: opts.runtimeNote,
    visualNote: opts.visualNote,
    interactionNote: opts.interactionNote,
  });
  const images = loadScreenshotDataUrls(opts.screenshotPaths);
  const prompt = buildAdversarialCriticPrompt({
    spec: opts.spec,
    blueprint,
    hollownessNote,
    evidence,
    hasScreenshots: images.length > 0,
    minScore,
  });

  let raw: string;
  try {
    raw = await opts.executor(prompt, images.length > 0 ? images : undefined);
  } catch (err) {
    return fallbackPass(`critic executor error: ${String(err).slice(0, 140)}`);
  }

  const verdict = parseAdversarialCritique(raw, minScore);
  return verdict ?? fallbackPass('unparseable adversarial critique verdict');
}

/** Format prioritized upgrade feedback for ConvergenceLoop when the critic rejects a pass. */
export function formatAdversarialFeedback(
  verdict: AdversarialCritiqueVerdict,
  minScore = DEFAULT_MIN_SCORE
): string {
  const a = verdict.axes;
  const lines: string[] = [
    `ADVERSARIAL CRITIC UPGRADE REQUIRED — min axis ${verdict.minAxisScore}/10 (target >= ${minScore}, overall ${verdict.overallScore}/10).`,
    `Axes: completeness=${a.completeness} craftDensity=${a.craftDensity} cohesionPolish=${a.cohesionPolish} framingErgonomics=${a.framingErgonomics} runtimeIntegrity=${a.runtimeIntegrity}`,
    `Highest-leverage focus: ${verdict.nextFocus}`,
  ];
  if (verdict.tickets.length > 0) {
    lines.push('Prioritized structural upgrade tickets (do NOT do cosmetic micro-tweaks until these are fixed):');
    for (const t of verdict.tickets) {
      lines.push(`  - [${t.severity.toUpperCase()}/${t.axis}] ${t.target}: ${t.defect} -> FIX: ${t.fix}`);
    }
  }
  return lines.join('\n');
}

/** Human-readable summary report for `uap verify --critic`. */
export function formatAdversarialReport(
  verdict: AdversarialCritiqueVerdict,
  minScore = DEFAULT_MIN_SCORE
): string {
  if (verdict.parseError) {
    return `ADVERSARIAL CRITIC: skipped (${verdict.parseError})`;
  }
  const a = verdict.axes;
  const status = verdict.pass ? '✓ PASS' : '✗ UPGRADE NEEDED';
  const lines = [
    `ADVERSARIAL CRITIC ${status} (overall ${verdict.overallScore}/10, min axis ${verdict.minAxisScore}/10, target >= ${minScore})`,
    `  axes: completeness=${a.completeness} | craftDensity=${a.craftDensity} | cohesionPolish=${a.cohesionPolish} | framingErgonomics=${a.framingErgonomics} | runtimeIntegrity=${a.runtimeIntegrity}`,
  ];
  for (const t of verdict.tickets) {
    lines.push(`  [${t.severity.toUpperCase()}/${t.axis}] ${t.target}: ${t.defect} — Fix: ${t.fix}`);
  }
  if (!verdict.pass && verdict.nextFocus) {
    lines.push(`  next focus: ${verdict.nextFocus}`);
  }
  return lines.join('\n');
}

export interface CriticBudgetConfig {
  maxPasses: number;
  minScore: number;
}

/** Read critic pass budget + target score from env / `.uap.json` (defaults: 2 passes, score 8). */
export function resolveCriticBudget(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env
): CriticBudgetConfig {
  let cfgMaxPasses: number | undefined;
  let cfgMinScore: number | undefined;
  const mainRoot = projectRoot.split('/.worktrees/')[0];
  for (const dir of [projectRoot, mainRoot]) {
    const file = join(dir, '.uap.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
        delivery?: { maxCriticPasses?: number; criticMinScore?: number };
        deliver?: { maxCriticPasses?: number; criticMinScore?: number };
      };
      const d = parsed.deliver ?? parsed.delivery;
      if (typeof d?.maxCriticPasses === 'number') cfgMaxPasses = d.maxCriticPasses;
      if (typeof d?.criticMinScore === 'number') cfgMinScore = d.criticMinScore;
      break;
    } catch {
      /* ignore */
    }
  }

  const envPasses = env.UAP_DELIVER_MAX_CRITIC_PASSES;
  const envScore = env.UAP_CRITIC_MIN_SCORE;
  const rawPasses = envPasses !== undefined ? Number(envPasses) : (cfgMaxPasses ?? DEFAULT_MAX_PASSES);
  const rawScore = envScore !== undefined ? Number(envScore) : (cfgMinScore ?? DEFAULT_MIN_SCORE);

  return {
    maxPasses: Number.isFinite(rawPasses) ? Math.max(0, Math.min(5, Math.floor(rawPasses))) : DEFAULT_MAX_PASSES,
    minScore: Number.isFinite(rawScore) ? Math.max(1, Math.min(10, rawScore)) : DEFAULT_MIN_SCORE,
  };
}

/** Bounded per-root polish-pass tracker for the convergence loop. */
export function createBoundedCriticController(maxPasses = DEFAULT_MAX_PASSES): {
  canRequestUpgrade(root: string): boolean;
  recordUpgrade(root: string): number;
  passesUsed(root: string): number;
} {
  const counts = new Map<string, number>();
  return {
    canRequestUpgrade(root: string): boolean {
      return (counts.get(root) ?? 0) < maxPasses;
    },
    recordUpgrade(root: string): number {
      const next = (counts.get(root) ?? 0) + 1;
      counts.set(root, next);
      return next;
    },
    passesUsed(root: string): number {
      return counts.get(root) ?? 0;
    },
  };
}

export interface BoundedUpgradeInput {
  verdict: { passed: boolean; feedback: string; score?: number };
  ladderRed: boolean;
  root: string;
  spec: string;
  runtimeNote: string;
  visualNote: string;
  screenshotPaths: string[];
  executor?: RoleExecutor;
  runner?: typeof runAdversarialCritic;
  maxPasses?: number;
  minScore?: number;
  note: (line: string) => void;
  controllers: Map<string, ReturnType<typeof createBoundedCriticController>>;
}

/**
 * Run a bounded clean-context thinking-ON adversarial critique ONLY after
 * objective/acceptance gates pass. Returns prioritized blocker/major feedback
 * while upgrade passes remain, or passes through the finalized verdict.
 */
export async function maybeRunAdversarialUpgrade(
  input: BoundedUpgradeInput
): Promise<{ passed: boolean; feedback: string; score?: number }> {
  const { verdict, ladderRed, root, executor } = input;
  if (!verdict.passed || ladderRed || !executor) return verdict;
  if (process.env.UAP_EPIC_NONFINAL === '1') return verdict;
  const resolved = resolveCriticBudget(root);
  const maxPasses = input.maxPasses ?? resolved.maxPasses;
  const minScore = input.minScore ?? resolved.minScore;
  if (maxPasses <= 0) return verdict;
  let ctrl = input.controllers.get(root);
  if (!ctrl) {
    ctrl = createBoundedCriticController(maxPasses);
    input.controllers.set(root, ctrl);
  }
  if (!ctrl.canRequestUpgrade(root)) return verdict;
  const run = input.runner ?? runAdversarialCritic;
  const critique = await run({
    spec: input.spec,
    projectRoot: root,
    executor,
    runtimeNote: input.runtimeNote,
    visualNote: input.visualNote,
    screenshotPaths: input.screenshotPaths,
    minScore,
  });
  if (critique.pass || critique.parseError) return verdict;
  const used = ctrl.recordUpgrade(root);
  input.note(
    `🔍 adversarial critic (pass ${used}/${maxPasses}): ${critique.overallScore}/10 (min axis ${critique.minAxisScore}/10 < ${minScore}) — requesting focused structural upgrade`
  );
  return {
    passed: false,
    score: critique.overallScore / 10,
    feedback: formatAdversarialFeedback(critique, minScore),
  };
}

