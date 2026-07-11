/**
 * Mission Decomposition — split a genuinely epic instruction into sequential
 * delivery phases, each driven through its own convergence loop.
 *
 * The phase plan is authored by the EVALUATOR model (one call), guided by the
 * ExpertOrchestrator's lifecycle chain (plan → design → implement → review →
 * release) so the split follows the canonical delivery lifecycle rather than
 * an arbitrary chunking. Fail-soft everywhere: any planning failure returns a
 * single-phase plan, i.e. the classic undecomposed loop.
 */

import type { LoopExecutor } from './convergence-loop.js';

/**
 * Optional provider of delivery-lifecycle routing hints (e.g. the
 * ExpertOrchestrator's phase/droid chain) — injected by the CLI so this
 * module stays a delivery-layer leaf with no coordination dependency.
 */
export type LifecycleHintProvider = (instruction: string) => string | null;

export interface DeliveryPhase {
  id: string;
  title: string;
  /** What this phase must accomplish (imperative, gate-verifiable). */
  goal: string;
  /** Phase ids this phase depends on (DAG). Execution is topologically
   * ordered; independent phases are candidates for future parallel dispatch. */
  deps?: string[];
  /**
   * True for a CONTRACTS phase: it establishes the mission's shared types /
   * interfaces / registries first, and once accepted the files it created are
   * LOCKED (read-only) for every later phase. Prevents the observed failure
   * mode where a weak model rewrites the shared type system differently in
   * each later phase (a live mission compounded 47 → 653 compile errors by
   * re-inventing its registry API module by module).
   */
  contracts?: boolean;
}

const MIN_PHASES = 2;
/**
 * Phase-count ceiling. Raised from the original 5 and made operator-tunable via
 * UAP_DELIVER_MAX_PHASES so genuinely epic missions (design → build →
 * operational readiness) can decompose into more than five stages. Bounded to a
 * hard ceiling so a bad env value can't explode the planning surface.
 */
const MAX_PHASES_HARD_CEILING = 20;
function maxPhases(): number {
  const raw = Number(process.env.UAP_DELIVER_MAX_PHASES);
  if (Number.isFinite(raw) && raw >= MIN_PHASES) return Math.min(Math.floor(raw), MAX_PHASES_HARD_CEILING);
  // (#4a) Default 8→10: a huge mission was being squeezed into ≤8 phases, each
  // then too big for a rail. Still bounded by the hard ceiling; env overrides up
  // to 20 for the largest missions.
  return 10;
}
/** Only instructions this long are epic-shaped enough to auto-decompose. */
const AUTO_DECOMPOSE_MIN_CHARS = 200;

/**
 * Auto-decomposition policy: complex-classified AND long enough to plausibly
 * contain multiple deliverables. Short complex tasks stay single-loop — the
 * decomposition overhead (a planning call + per-phase baseline work) only
 * pays off on genuinely multi-part missions.
 */
export function shouldDecompose(instruction: string, complexity?: string): boolean {
  return complexity === 'complex' && instruction.trim().length >= AUTO_DECOMPOSE_MIN_CHARS;
}

/** Extract the first JSON array of {id,title,goal} objects from model output. */
export function parsePhaseArray(text: string): DeliveryPhase[] {
  let parsed: unknown;
  for (const re of [/\[\s*\{[\s\S]*?\}\s*\]/, /\[\s*\{[\s\S]*\}\s*\]/]) {
    const match = text.match(re);
    if (!match) continue;
    try {
      parsed = JSON.parse(match[0]);
      break;
    } catch {
      parsed = undefined;
    }
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const phases: DeliveryPhase[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title, goal } = entry as { id?: unknown; title?: unknown; goal?: unknown };
    if (typeof title !== 'string' || typeof goal !== 'string' || !title.trim() || !goal.trim()) continue;
    const rawId = typeof id === 'string' && id.trim() ? id : title;
    const slug = rawId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const rawDeps = (entry as { deps?: unknown }).deps;
    const deps = Array.isArray(rawDeps)
      ? rawDeps.filter((d): d is string => typeof d === 'string').map((d) => d.trim().toLowerCase()).slice(0, maxPhases())
      : undefined;
    const contracts = (entry as { contracts?: unknown }).contracts === true;
    phases.push({
      id: slug,
      title: title.trim().slice(0, 120),
      goal: goal.trim().slice(0, 600),
      ...(deps && deps.length > 0 ? { deps } : {}),
      ...(contracts ? { contracts: true } : {}),
    });
    if (phases.length >= maxPhases()) break;
  }
  return topoOrder(phases);
}

/**
 * Topologically order phases by their declared deps (unknown deps dropped;
 * a cycle degrades to the original order — decomposition must never wedge).
 * Insertion order is the tie-break, preserving the planner's intent.
 */
export function topoOrder(phases: DeliveryPhase[]): DeliveryPhase[] {
  const ids = new Set(phases.map((p) => p.id));
  const cleaned = phases.map((p) => ({
    ...p,
    ...(p.deps ? { deps: p.deps.filter((d) => ids.has(d) && d !== p.id) } : {}),
  }));
  const done = new Set<string>();
  const out: DeliveryPhase[] = [];
  const remaining = [...cleaned];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((p) => (p.deps ?? []).every((d) => done.has(d)));
    if (idx === -1) return phases; // cycle — fail soft to planner order
    const [next] = remaining.splice(idx, 1);
    done.add(next.id);
    out.push(next);
  }
  return out;
}

export interface PlanPhasesOptions {
  /**
   * Per-session (per-rail) token budget each phase must complete within. When
   * set, the planner is told to scope phases so a fresh agent session —
   * prompt + code it reads + tool output + its own edits — finishes inside
   * this budget, preferring more, smaller phases over fewer large ones.
   */
  sessionTokenBudget?: number;
  /**
   * Ask the planner to emit a CONTRACTS phase first (shared types/interfaces,
   * later locked read-only) when the mission spans modules that share types.
   */
  contractsFirst?: boolean;
}

function buildDecomposePrompt(
  instruction: string,
  hintProvider?: LifecycleHintProvider,
  opts?: PlanPhasesOptions
): string {
  // Lifecycle hints (phases + experts) shape the split. Fail-soft — a
  // throwing provider just omits the hints.
  let lifecycleHint = '';
  try {
    const hint = hintProvider?.(instruction);
    if (hint && hint.trim()) {
      lifecycleHint = ['', 'Delivery-lifecycle expert routing for this task (use it to shape the phases):', hint.trim()].join('\n');
    }
  } catch {
    lifecycleHint = '';
  }

  // Rail sizing: each phase runs in ONE fresh agent session with a hard
  // context ceiling, so the planner must scope phases to fit it.
  const budgetHint = opts?.sessionTokenBudget
    ? [
        '',
        `CONTEXT LIMIT: each phase is delivered by an autonomous agent in ONE fresh session with a hard context budget of ~${opts.sessionTokenBudget} tokens (roughly ${opts.sessionTokenBudget * 4} characters — the phase prompt, every file the agent reads, all tool output, and its own edits ALL count against it). Scope every phase so it completes comfortably within that budget: prefer MORE, SMALLER phases over fewer large ones, and never bundle broad multi-file refactors into a single phase.`,
      ].join('\n')
    : '';

  const contractsHint = opts?.contractsFirst
    ? [
        '',
        'CONTRACTS FIRST: if the mission spans multiple modules/files that share',
        'types, interfaces, registries, or schemas, the FIRST phase must be a',
        'CONTRACTS phase (set "contracts": true on it): it defines the complete',
        'shared type signatures / interfaces / registry APIs the later phases',
        'build against — compiling, with minimal stub bodies. Later phases must',
        'treat those contract files as READ-ONLY (they will be locked) and list',
        'the contracts phase in their deps. A single-module mission needs no',
        'contracts phase.',
      ].join('\n')
    : '';

  return [
    'You are a delivery planner. Split the mission below into SEQUENTIAL phases',
    `(${MIN_PHASES}-${maxPhases()}), each independently verifiable by the project's build/test`,
    'gates. Every phase must leave the project in a working state — no phase may',
    'end with intentionally broken builds. Order phases so later ones build on',
    'earlier ones. Do NOT invent scope the mission does not imply.',
    budgetHint,
    contractsHint,
    lifecycleHint,
    '',
    `MISSION: ${instruction}`,
    '',
    'Respond with ONLY a JSON array. Each phase may declare deps (ids of',
    'phases it builds on); phases without deps between them are independent:',
    '[{"id": "<kebab-slug>", "title": "<short name>", "goal": "<what this phase must accomplish>", "deps": ["<id>"], "contracts": false}]',
  ].join('\n');
}

/**
 * Plan sequential delivery phases via one evaluator-model call. Returns [] on
 * any failure or a degenerate (<2 phase) plan, so callers fall back to the
 * classic single-loop delivery.
 */
export async function planDeliveryPhases(
  instruction: string,
  executor: LoopExecutor,
  hintProvider?: LifecycleHintProvider,
  opts?: PlanPhasesOptions
): Promise<DeliveryPhase[]> {
  try {
    const raw = await executor(buildDecomposePrompt(instruction, hintProvider, opts));
    const phases = parsePhaseArray(raw);
    return phases.length >= MIN_PHASES ? phases : [];
  } catch {
    return [];
  }
}

/**
 * Compose the instruction a phase's convergence loop receives: full mission
 * for context, this phase's goal as the actual task, and one-line summaries
 * of completed phases so the model knows what already exists.
 */
export function phaseInstruction(
  mission: string,
  phases: DeliveryPhase[],
  index: number,
  priorSummaries: string[]
): string {
  const phase = phases[index];
  const sections = [
    `FULL MISSION (context — being delivered in ${phases.length} phases): ${mission}`,
    '',
    `CURRENT PHASE ${index + 1}/${phases.length} — ${phase.title}:`,
    phase.goal,
  ];
  if (priorSummaries.length > 0) {
    sections.push('', 'COMPLETED PHASES (already implemented — build on them, do not redo):');
    priorSummaries.forEach((sum, i) => sections.push(`${i + 1}. ${sum}`));
  }
  sections.push('', 'Deliver ONLY this phase. All gates must pass at the end of the phase.');
  return sections.join('\n');
}
