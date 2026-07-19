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
import { validatePhaseGraph, runPlanThoughtExperiment } from './plan-check.js';

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
  /**
   * True for a SCAFFOLD phase: it creates compiling module skeletons — full
   * public signatures with todo!()/NotImplementedError bodies — that later
   * FILL phases (declaring it in deps) implement WITHOUT changing signatures.
   * Splits "design the shape" from "write the logic", the two things a weak
   * model cannot do simultaneously at scale.
   */
  scaffold?: boolean;
  /**
   * Optional VERIFIABLE acceptance criteria for this phase/epic — the epic
   * judge grades against them ("Acceptance criteria:" in the epic spec).
   * The planner is ASKED for at most 3; the parse cap (6 × 200 chars) is
   * deliberate headroom so a slightly-chatty planner still lands, while a
   * rambling one can't bloat specs.
   */
  criteria?: string[];
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
/**
 * parsePhaseArray + how many entries the planner actually emitted. When
 * emitted > phases.length the plan was CAP-TRUNCATED: the tail phases exist
 * in the raw text and can be recovered by re-parsing at a higher cap — no
 * new model call. Run Z (octopus variant, 2026-07-19): the planner emitted
 * 21 scaffold/fill phases, the cap kept 10 (ending at player-scaffold, no
 * UI/engine/HTML), and the plan-check thought experiment PASSED the
 * truncated plan — the loud log alone changed nothing.
 */
export function parsePhaseArrayWithMeta(
  text: string,
  cap: number = maxPhases()
): { phases: DeliveryPhase[]; emitted: number } {
  return parsePhaseArrayInner(text, cap);
}

export function parsePhaseArray(text: string, cap: number = maxPhases()): DeliveryPhase[] {
  return parsePhaseArrayInner(text, cap).phases;
}

function parsePhaseArrayInner(text: string, cap: number): { phases: DeliveryPhase[]; emitted: number } {
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
  if (!Array.isArray(parsed)) return { phases: [], emitted: 0 };

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
      ? rawDeps.filter((d): d is string => typeof d === 'string').map((d) => d.trim().toLowerCase()).slice(0, cap)
      : undefined;
    const contracts = (entry as { contracts?: unknown }).contracts === true;
    const scaffold = (entry as { scaffold?: unknown }).scaffold === true;
    const rawCriteria = (entry as { criteria?: unknown }).criteria;
    const criteria = Array.isArray(rawCriteria)
      ? rawCriteria
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map((c) => c.trim().slice(0, 200))
          .slice(0, 6)
      : undefined;
    phases.push({
      id: slug,
      title: title.trim().slice(0, 120),
      goal: goal.trim().slice(0, 600),
      ...(deps && deps.length > 0 ? { deps } : {}),
      ...(contracts ? { contracts: true } : {}),
      ...(scaffold ? { scaffold: true } : {}),
      ...(criteria && criteria.length > 0 ? { criteria } : {}),
    });
    if (phases.length >= cap) {
      // SILENT truncation here is how a 14-deliverable mission became a
      // 10-phase plan that always ended at player-scaffold (octopus,
      // 2026-07-16): the model DID emit the tail phases; the parser dropped
      // them and plan-check then chased gaps the cap guaranteed could never
      // close.
      const total = (parsed as unknown[]).length; // parsed is an array here (guarded above)
      if (total > cap) {
        console.log(
          `  plan: planner emitted ${total} entries; kept the first ${cap} valid phase(s) (cap) — raise UAP_DELIVER_MAX_PHASES if the mission genuinely needs more`
        );
      }
      break;
    }
  }
  return { phases: topoOrder(phases), emitted: (parsed as unknown[]).length };
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
  /**
   * Ask the planner to structure large implementation work as SCAFFOLD phases
   * (compiling skeletons, todo!() bodies) followed by FILL phases.
   */
  scaffoldFirst?: boolean;
  /**
   * Pre-execution plan validation (ATG thought experiment): after planning,
   * one evaluator call mentally executes the phase plan and a failed verdict
   * triggers ONE re-plan with the findings appended. Defaults to ON;
   * disable per-run with `false` or globally with UAP_DELIVER_PLAN_CHECK=0.
   */
  thoughtExperiment?: boolean;
}

export function buildDecomposePrompt(
  instruction: string,
  hintProvider?: LifecycleHintProvider,
  opts?: PlanPhasesOptions,
  cap: number = maxPhases()
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

  const scaffoldHint = opts?.scaffoldFirst
    ? [
        '',
        'SCAFFOLD THEN FILL: for LARGE implementation phases (a whole module /',
        'many functions), prefer a pair: first a SCAFFOLD phase (set',
        '"scaffold": true) that creates the compiling skeleton — complete',
        'public signatures, wired imports/exports, todo!()-style stub bodies —',
        'then FILL phase(s) depending on it that implement the stub bodies',
        'WITHOUT changing any signature. Small phases need no scaffold.',
      ].join('\n')
    : '';

  return [
    'You are a delivery planner. Split the mission below into SEQUENTIAL phases',
    `(${MIN_PHASES}-${cap}), each independently verifiable by the project's build/test`,
    'gates. Every phase must leave the project in a working state — no phase may',
    'end with intentionally broken builds. Order phases so later ones build on',
    'earlier ones. Do NOT invent scope the mission does not imply.',
    '',
    'FILE OWNERSHIP — CRITICAL: every concrete file the mission requires must be',
    'CREATED by EXACTLY ONE phase. Never let two phases CREATE the same file. (A',
    "SCAFFOLD phase creating a file and its paired FILL phase later EDITING that",
    'same file is expected — that is one owner across the pair, not two creators.)',
    'A CONTRACTS or types phase owns ONLY the shared type/interface file(s) it',
    "declares — it must NOT list another module's file as a criterion; the later",
    "scaffold/fill phase for that module then OWNS that module's file.",
    'For every file named in the mission, exactly one phase must create it — a',
    'file no phase creates is never delivered (the gates and acceptance judge',
    "check the mission's file layout, so an unowned file fails the run).",
    budgetHint,
    contractsHint,
    scaffoldHint,
    lifecycleHint,
    '',
    `MISSION: ${instruction}`,
    '',
    'Respond with ONLY a JSON array. Each phase may declare deps (ids of',
    'phases it builds on); phases without deps between them are independent:',
    '[{"id": "<kebab-slug>", "title": "<short name>", "goal": "<what this phase must accomplish>", "deps": ["<id>"], "contracts": false, "scaffold": false, "criteria": ["<verifiable acceptance criterion (optional, max 3)>"]}]',
  ].join('\n');
}

/**
 * Plan sequential delivery phases via one evaluator-model call, then VALIDATE
 * the plan before anything executes (structural DAG check + ATG thought
 * experiment, with one re-plan on a failed verdict — see plan-check.ts).
 * Returns [] on any failure or a degenerate (<2 phase) plan, so callers fall
 * back to the classic single-loop delivery.
 */
export async function planDeliveryPhases(
  instruction: string,
  executor: LoopExecutor,
  hintProvider?: LifecycleHintProvider,
  opts?: PlanPhasesOptions
): Promise<DeliveryPhase[]> {
  // A weak planner intermittently emits unparseable JSON; one silent miss used
  // to collapse a genuinely multi-part mission into a monolithic single epic
  // with no trace in the log (octopus retest, 2026-07-16: "1 epic(s): Mission"
  // for a 7k-char mission). Retry the planning call once, and NARRATE the
  // degradation when it still fails — silent fallbacks read as decisions.
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let phases: DeliveryPhase[] = [];
    try {
      const raw = await executor(buildDecomposePrompt(instruction, hintProvider, opts));
      const first = parsePhaseArrayWithMeta(raw);
      phases = first.phases;
      // Cap-truncation recovery: the planner emitting MORE entries than the
      // cap IS the evidence the mission needs more phases — the tail is
      // already in `raw`, so re-parse at a raised cap (bounded by the hard
      // ceiling) instead of hoping the thought experiment notices the holes
      // (run Z, 2026-07-19: it didn't — a 21-phase plan shipped as 10 with
      // no UI/engine/HTML phases and plan-check passed it).
      if (first.emitted > phases.length && phases.length >= maxPhases()) {
        const raised = Math.min(first.emitted, MAX_PHASES_HARD_CEILING);
        if (raised > phases.length) {
          const reparsed = parsePhaseArrayWithMeta(raw, raised);
          if (reparsed.phases.length > phases.length) {
            console.log(
              `  plan: cap-truncation recovery — re-parsed the SAME planner output at cap ${raised} ` +
                `(${reparsed.phases.length} phases kept${first.emitted > raised ? `; ${first.emitted - raised} beyond the hard ceiling still dropped` : ''})`
            );
            phases = reparsed.phases;
          }
        }
      }
    } catch {
      phases = [];
    }
    if (phases.length >= MIN_PHASES) {
      try {
        return await validateAndRepairPlan(instruction, phases, executor, hintProvider, opts);
      } catch {
        return phases; // validation is best-effort; the parsed plan stands
      }
    }
    console.log(
      `  plan: attempt ${attempt} produced ${phases.length} usable phase(s) (need ≥${MIN_PHASES}) — ` +
        (attempt < attempts ? 'retrying the planner' : 'falling back to single-loop delivery')
    );
  }
  return [];
}

/**
 * Pre-execution plan validation: structural issues are logged (never fatal —
 * decomposition must not wedge), then the evaluator dry-runs the plan; a
 * failed verdict triggers ONE re-plan with the findings appended to the
 * planning prompt. Never returns a worse plan than it was given: on any
 * validator/model trouble, or an unusable re-plan, the original plan stands.
 */
async function validateAndRepairPlan(
  instruction: string,
  phases: DeliveryPhase[],
  executor: LoopExecutor,
  hintProvider?: LifecycleHintProvider,
  opts?: PlanPhasesOptions
): Promise<DeliveryPhase[]> {
  const structural = validatePhaseGraph(phases);
  for (const msg of structural.warnings) console.log(`  plan-check: ${msg}`);

  // What (if anything) demands a re-plan: structural errors always do (they
  // are deterministic and free to detect — a cycle under the orchestrator
  // means its whole subtree gets skipped); otherwise the evaluator's thought
  // experiment decides, unless disabled.
  let findings: string[];
  let fromThoughtExperiment = false;
  if (!structural.ok) {
    for (const msg of structural.errors) console.log(`  plan-check: ${msg}`);
    findings = structural.errors;
    console.log('  plan-check: structural validation FAILED — re-planning once');
  } else {
    const teWanted = opts?.thoughtExperiment ?? process.env.UAP_DELIVER_PLAN_CHECK !== '0';
    if (!teWanted) return phases;
    const verdict = await runPlanThoughtExperiment(instruction, phases, executor);
    if (verdict.verdict === 'pass') return phases;
    findings = verdict.findings;
    fromThoughtExperiment = true;
    console.log(
      `  plan-check: thought experiment FAILED — re-planning once (${findings.slice(0, 3).join('; ') || 'no findings given'})`
    );
  }

  const revised =
    `${instruction}\n\nPLAN REVIEW FINDINGS (a prior phase plan was rejected for these; the new plan MUST address them):\n` +
    findings.map((f, i) => `${i + 1}. ${f}`).join('\n');
  // Cap-bound escalation: a set of phases sitting exactly AT the ceiling with
  // missing-phase findings is almost certainly parser-truncated, not
  // under-planned — re-planning at the same ceiling reproduces the same
  // truncation forever. Give the re-plan head-room (bounded by the hard
  // ceiling) so the tail phases can actually land.
  const capBound = fromThoughtExperiment && phases.length >= maxPhases();
  const replanCap = capBound
    ? Math.min(maxPhases() * 2, MAX_PHASES_HARD_CEILING)
    : maxPhases();
  if (capBound && replanCap > maxPhases()) {
    console.log(
      `  plan-check: cap-bound at ${phases.length} with review findings — raising the re-plan ceiling to ${replanCap}`
    );
  }
  try {
    const raw = await executor(buildDecomposePrompt(revised, hintProvider, opts, replanCap));
    const replanned = parsePhaseArray(raw, replanCap);
    if (replanned.length >= MIN_PHASES && validatePhaseGraph(replanned).ok) {
      // The re-plan is adopted on structural validity alone — but the review
      // findings were BEHAVIORAL. Re-judge it once (one evaluator call): a
      // re-plan that still misses deliverables otherwise sails through and
      // the mission is unwinnable again (run C, 2026-07-16: "re-planned into
      // 10 phases addressing the findings" — it hadn't). If the verdict
      // still fails, ride the residual findings in a gap-closure phase.
      if (fromThoughtExperiment) {
        try {
          const verdict = await runPlanThoughtExperiment(instruction, replanned, executor);
          if (verdict.verdict !== 'pass' && verdict.findings.length > 0) {
            const withGap = appendGapClosurePhase(replanned, verdict.findings);
            if (withGap) {
              console.log(
                `  plan-check: re-plan still incomplete — appended '${GAP_CLOSURE_ID}' phase carrying ${verdict.findings.length} residual finding(s)`
              );
              return withGap;
            }
          }
        } catch {
          // re-judge is best-effort; the structurally-valid re-plan stands
        }
      }
      console.log(`  plan-check: re-planned into ${replanned.length} phases addressing the findings`);
      return replanned;
    }
  } catch {
    // fall through to the original plan
  }
  // A phase-plan PROVEN incomplete by the review must not proceed as-is: a
  // mission whose phases omit whole deliverables is unwinnable no matter how
  // well each epic runs (octopus_invaders_v3, 2026-07-16 — the 10-phase run
  // ended at player-scaffold with no player-fill/ui/game phases, plan-check
  // said so, and the run proceeded anyway). When the re-plan is unusable,
  // append a deterministic gap-closure phase that carries the review
  // findings, depends on every existing phase, and therefore runs last —
  // where the whole-mission gates fire. Structural failures (cycles, bad
  // deps) are not closable by an extra phase, so those keep the original.
  if (fromThoughtExperiment && findings.length > 0) {
    const withGap = appendGapClosurePhase(phases, findings);
    if (withGap) {
      console.log(
        `  plan-check: re-plan unusable — appended '${GAP_CLOSURE_ID}' phase carrying ${findings.length} review finding(s)`
      );
      return withGap;
    }
  }
  console.log('  plan-check: re-plan unusable — keeping the original plan');
  return phases;
}

export const GAP_CLOSURE_ID = 'plan-gap-closure';

/**
 * Append a final phase that closes the review findings: it depends on every
 * existing phase (topologically last, so it becomes the FINAL epic and the
 * whole-mission gates run there) and its goal is to deliver everything the
 * reviewed phases left uncovered. Returns null when the phase cannot be
 * added safely (id collision, or the augmented graph fails validation).
 */
export function appendGapClosurePhase(
  phases: DeliveryPhase[],
  findings: string[]
): DeliveryPhase[] | null {
  if (phases.length === 0 || phases.some((p) => p.id === GAP_CLOSURE_ID)) return null;
  const gapList = findings
    .map((f, i) => `${i + 1}. ${f}`)
    .join('\n')
    .slice(0, 2400);
  const gap: DeliveryPhase = {
    id: GAP_CLOSURE_ID,
    title: 'Plan Gap Closure',
    goal:
      'Complete the mission: the review found the existing phases leave parts of the mission ' +
      'undelivered. Close ALL of the following gaps so the FULL mission is satisfied:\n' +
      gapList,
    deps: phases.map((p) => p.id),
    criteria: ['Every gap listed in the goal is delivered and verifiable in the tree'],
  };
  const augmented = [...phases, gap];
  return validatePhaseGraph(augmented).ok ? augmented : null;
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
