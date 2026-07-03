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
}

const MIN_PHASES = 2;
const MAX_PHASES = 5;
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
    phases.push({ id: slug, title: title.trim().slice(0, 120), goal: goal.trim().slice(0, 600) });
    if (phases.length >= MAX_PHASES) break;
  }
  return phases;
}

function buildDecomposePrompt(instruction: string, hintProvider?: LifecycleHintProvider): string {
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

  return [
    'You are a delivery planner. Split the mission below into SEQUENTIAL phases',
    `(${MIN_PHASES}-${MAX_PHASES}), each independently verifiable by the project's build/test`,
    'gates. Every phase must leave the project in a working state — no phase may',
    'end with intentionally broken builds. Order phases so later ones build on',
    'earlier ones. Do NOT invent scope the mission does not imply.',
    lifecycleHint,
    '',
    `MISSION: ${instruction}`,
    '',
    'Respond with ONLY a JSON array:',
    '[{"id": "<kebab-slug>", "title": "<short name>", "goal": "<what this phase must accomplish>"}]',
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
  hintProvider?: LifecycleHintProvider
): Promise<DeliveryPhase[]> {
  try {
    const raw = await executor(buildDecomposePrompt(instruction, hintProvider));
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
