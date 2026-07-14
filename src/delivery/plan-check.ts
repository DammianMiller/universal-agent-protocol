/**
 * Pre-execution plan validation (the ATG-style "thought experiment").
 *
 * Adapted from "Atomic Task Graph: A Unified Framework for Agentic Planning
 * and Execution" (arXiv 2607.01942) — see docs/ATTRIBUTION.md for full credits.
 *
 * Two layers, both run BEFORE any phase executes:
 *
 *  1. `validatePhaseGraph` — structural: duplicate ids, unknown/self deps,
 *     dependency cycles, empty goals. Pure, no model.
 *  2. `runPlanThoughtExperiment` — one evaluator call that mentally executes
 *     the decomposition ("will these phases, in this dependency order, deliver
 *     the mission?") and returns a pass/fail verdict with findings. The judge
 *     did not author the plan — the same generator≠evaluator separation the
 *     acceptance gate uses.
 *
 * `reviewPlanText` is the free-text sibling used by `uap plan validate` on
 * markdown plan artifacts (the validate-plan-on-change gate's `validate the
 * plan` step becomes a real review, not just a stamp).
 *
 * Everything is fail-soft: a validator or model error forfeits the check, it
 * never blocks delivery — decomposition and the plan gate must never wedge.
 *
 * SECURITY NOTE: because of that fail-soft design (and because the judged text
 * is authored by the same party the gate constrains), a PASS verdict is an
 * anti-sloppiness signal, NOT an adversarial guarantee — never build
 * enforcement that treats a PASS as proof of review.
 */

// Both imports MUST stay type-only: decompose.ts runtime-imports this module,
// so a runtime import back into decompose (e.g. reusing topoOrder here) would
// create a real ESM cycle. This module is a pure leaf.
import type { LoopExecutor } from './convergence-loop.js';
import type { DeliveryPhase } from './decompose.js';

export interface PhaseGraphValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Structural validation of a phase/epic DAG. Pure — safe to call anywhere. */
export function validatePhaseGraph(phases: DeliveryPhase[]): PhaseGraphValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const p of phases) {
    if (ids.has(p.id)) errors.push(`duplicate phase id '${p.id}'`);
    ids.add(p.id);
    if (!p.goal || !p.goal.trim()) errors.push(`phase '${p.id}' has an empty goal`);
  }
  for (const p of phases) {
    for (const d of p.deps ?? []) {
      if (d === p.id) errors.push(`phase '${p.id}' depends on itself`);
      else if (!ids.has(d)) warnings.push(`phase '${p.id}' depends on unknown phase '${d}' (dropped at execution)`);
    }
  }
  // Cycle detection (DFS with recursion stack) over known-id edges only —
  // unknown and self deps are already reported above.
  const visited = new Set<string>();
  const stack = new Set<string>();
  const byId = new Map(phases.map((p) => [p.id, p]));
  const hasCycle = (id: string): boolean => {
    visited.add(id);
    stack.add(id);
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d) || d === id) continue;
      if (!visited.has(d) && hasCycle(d)) return true;
      if (stack.has(d)) return true;
    }
    stack.delete(id);
    return false;
  };
  for (const p of phases) {
    if (!visited.has(p.id) && hasCycle(p.id)) {
      errors.push('dependency cycle detected — cycle members can never become ready and their subtree is skipped at execution');
      break;
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export interface PlanReviewVerdict {
  verdict: 'pass' | 'fail';
  findings: string[];
}

/** Extract a {verdict,findings} JSON verdict from model output. Anything
 * unparseable is a PASS — a garbled judge must not block delivery. */
export function parsePlanVerdict(text: string): PlanReviewVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { verdict: 'pass', findings: [] };
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; findings?: unknown };
    const verdict = parsed.verdict === 'fail' ? 'fail' : 'pass';
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          // Model output reaches terminals and prompts — strip control/ANSI bytes.
          .map((f) => f.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 300))
          .slice(0, 8)
      : [];
    return { verdict, findings };
  } catch {
    return { verdict: 'pass', findings: [] };
  }
}

function describePhases(phases: DeliveryPhase[]): string {
  return phases
    .map(
      (p, i) =>
        `${i + 1}. [${p.id}] ${p.title} — ${p.goal}${p.deps?.length ? ` (deps: ${p.deps.join(', ')})` : ''}`
    )
    .join('\n');
}

/**
 * ATG thought experiment: ask the evaluator to mentally execute the phase plan
 * before anything real runs, hunting for the defects that sink multi-phase
 * missions (missing prerequisites, wrong dependency order, phases consuming
 * artifacts no earlier phase produces, invented scope). One call; fail-soft.
 */
export async function runPlanThoughtExperiment(
  mission: string,
  phases: DeliveryPhase[],
  executor: LoopExecutor
): Promise<PlanReviewVerdict> {
  const prompt = [
    'You are a plan validator. Mentally EXECUTE the phase plan below, in its',
    'dependency order, before anything real runs. You did not author this plan;',
    'judge it adversarially.',
    '',
    `MISSION: ${mission.slice(0, 4000)}`,
    '',
    'PHASE PLAN:',
    describePhases(phases),
    '',
    'Check ONLY for defects that would make execution fail or deliver the wrong thing:',
    '- a phase that needs an artifact/decision no earlier phase (per its deps) produces',
    '- missing prerequisite phases (setup, shared contracts, migrations)',
    '- dependency edges that are wrong or missing (a later phase silently assumes an independent one ran first)',
    '- phases that invent scope the mission does not imply, or mission parts no phase covers',
    'Do NOT fail a plan for style, granularity taste, or improvements that are merely nice.',
    '',
    'Respond with ONLY JSON: {"verdict": "pass" | "fail", "findings": ["<specific defect>", ...]}',
    '"fail" requires at least one concrete, execution-breaking finding.',
  ].join('\n');
  try {
    return parsePlanVerdict(await executor(prompt));
  } catch {
    return { verdict: 'pass', findings: [] }; // model unavailable ⇒ check forfeited, never blocked
  }
}

/**
 * Free-text plan review for `uap plan validate` over a markdown plan artifact.
 * Same verdict contract and fail-soft rules as the phase thought experiment.
 */
export async function reviewPlanText(planText: string, executor: LoopExecutor): Promise<PlanReviewVerdict> {
  const truncated = planText.length > 12000;
  const prompt = [
    'You are a plan validator. Review the implementation plan below as if you',
    'had to execute it exactly as written. You did not author it; judge it',
    'adversarially.',
    '',
    'PLAN:' + (truncated ? ' (truncated to the first 12,000 characters — judge only what you see)' : ''),
    planText.slice(0, 12000),
    '',
    'Check ONLY for defects that would make executing the plan fail or produce the wrong result:',
    '- steps in an impossible order (a step consumes what a later step produces)',
    '- missing prerequisite or verification steps for risky/irreversible actions',
    '- load-bearing assumptions stated nowhere and likely false',
    '- internal contradictions between sections',
    'Do NOT fail a plan for style, brevity, or missing nice-to-haves.',
    '',
    'Respond with ONLY JSON: {"verdict": "pass" | "fail", "findings": ["<specific defect>", ...]}',
    '"fail" requires at least one concrete, execution-breaking finding.',
  ].join('\n');
  try {
    return parsePlanVerdict(await executor(prompt));
  } catch {
    return { verdict: 'pass', findings: [] };
  }
}
