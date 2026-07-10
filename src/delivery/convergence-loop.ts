/**
 * Convergence Loop
 *
 * Drives an underlying model through execute → apply → verify → feedback
 * iterations until the project's completion gates (verifier ladder) pass or
 * the turn budget is exhausted.
 *
 * The loop owns pluggable seams so phases extend without breaking changes:
 *  - executor: how a prompt becomes model output
 *  - applier: how model output is materialized into the project tree
 *  - promptBuilder: how instruction/feedback/critique compose a prompt
 *  - ladderRunner: how gates are verified
 *  - explorer (Phase 2): best-of-N candidate exploration with judge tie-break
 *  - critic (Phase 3): structured repair plans replacing raw gate dumps
 *  - onIteration: per-turn control hook (Phase 5 escalation controllers)
 */

import type { GateRung, LadderResult, LadderOptions } from './verifier-ladder.js';
import { detectRungs, runLadder, tierOf } from './verifier-ladder.js';
import type { Applier, ApplyOptions, ApplyResult } from './applier.js';
import { applyFileBlocks } from './applier.js';
import { snapshotProtection } from './spec-imports.js';
import { captureIntegrity, verifyAndRestore, integrityViolationFeedback } from './integrity.js';
import type { StrategySeed } from './explorer.js';
import { exploreAndCommit } from './explorer.js';
import type { Judge } from './judge.js';
import type { Critic } from './critic.js';
import { CONTEXT_BUDGET_MARKER } from './context-budget.js';

export type LoopExecutor = (prompt: string) => Promise<string>;

/** Pluggable ladder runner — production uses runLadder, tests inject a stub. */
export type LadderRunner = (
  rungs: GateRung[],
  projectRoot: string,
  options?: LadderOptions
) => LadderResult | Promise<LadderResult>;

export interface PromptContext {
  instruction: string;
  /** 1-based turn about to execute */
  turn: number;
  /** Model output from the previous turn (truncated) */
  previousOutput?: string;
  /** Gate feedback from the previous turn's ladder run */
  feedback?: string;
  /** Apply-stage error from the previous turn (e.g. no file blocks found) */
  applyError?: string;
  /** Files written by the previous turn */
  previousFiles?: string[];
  /** Structured repair steps from the critic (Phase 3) */
  critique?: string[];
  /** Best-practice guidance retrieved for this task (Phase 4) */
  practices?: string[];
  /** Pre-existing test/oracle files the applier will refuse to modify */
  protectedFiles?: string[];
  /**
   * Operator guidance injected mid-run — steers the mission without stopping
   * it. Per-turn transient (re-polled each turn): unlike `practices`/
   * `protectedFiles`, it is NOT carried forward, so clearing the source on a
   * later turn removes it. Custom prompt builders should treat it as such.
   */
  guidance?: string;
  /** Include the autonomy policy in the prompt (default true; false opts out). */
  autonomous?: boolean;
}

export type PromptBuilder = (context: PromptContext) => string;

export interface CandidateSummary {
  id: string;
  strategy: string;
  passed: boolean;
  score: number;
  error?: string;
}

export interface IterationRecord {
  /** Real 1-based loop turn (executor-error turns are recorded too) */
  turn: number;
  passed: boolean;
  /** Fraction of gates passed this iteration (0 when the turn never reached verification) */
  score: number;
  gateResults: LadderResult['results'];
  /** Files the applier wrote this turn */
  filesApplied: string[];
  /** Executor failure, if the model call itself errored */
  executorError?: string;
  /** Apply failure, if output could not be materialized */
  applyError?: string;
  /** Strategy seed of the committed candidate (explorer mode) */
  strategy?: string;
  /** All candidates evaluated this turn (explorer mode) */
  candidates?: CandidateSummary[];
  /** Judge rationale when a tie-break decided the winner (explorer mode) */
  judgeRationale?: string;
  /** Fraction of spec criteria met when the acceptance gate ran (0..1); undefined
   *  when no acceptance gate is configured or objective gates didn't pass. */
  acceptanceMet?: number;
  /**
   * True when this turn's executor session was hard-stopped by its context
   * token budget (rail sizing — see delivery/context-budget.ts). Callers use
   * this to route budget-exhausted work to the epic split path.
   */
  budgetStopped?: boolean;
  durationMs: number;
}

export interface DeliveryResult {
  success: boolean;
  /** True when the baseline check found all gates already green (no turns ran) */
  alreadyDelivered: boolean;
  turns: number;
  /** Highest gate score observed across iterations */
  bestScore: number;
  /** Turn that achieved bestScore (0 when no iterations reached verification) */
  bestTurn: number;
  history: IterationRecord[];
  /** Feedback from the final ladder run (or apply/executor error context) */
  finalFeedback: string;
  /** Raw model output from the final turn */
  finalOutput: string;
  totalDurationMs: number;
}

export interface ExplorerSettings {
  /** Candidates per turn (default 3) */
  candidates?: number;
  seeds?: StrategySeed[];
  judge?: Judge;
  /** Per-candidate isolated workspaces → concurrent candidate verification. */
  workspaceProvider?: import('./candidate-workspace.js').WorkspaceProvider;
}

/**
 * Directive returned from onIteration to steer the loop (Phase 5).
 * All fields are optional; an empty object (or void) means "continue".
 * 'stop' (string) remains supported for backward compatibility.
 */
export interface IterationDirective {
  /** Abort the loop after this turn */
  stop?: boolean;
  /** Raise the turn budget to this absolute value (ignored if ≤ current) */
  raiseMaxTurns?: number;
  /** Enable/resize best-of-N exploration starting next turn */
  setCandidates?: number;
  /** Turn the structured critic on starting next turn */
  enableCritic?: boolean;
  /** Swap the model/executor (model escalation) */
  switchExecutor?: LoopExecutor;
  /**
   * Regenerate divergent strategy seeds (requires ConvergenceConfig.seedGenerator).
   * Used by the escalation ladder when the loop stagnates: fresh, feedback-aware
   * seeds re-diversify exploration instead of retrying the same failed strategies.
   */
  regenerateSeeds?: boolean;
  /** Human-readable reason, surfaced in logs and the iteration record */
  note?: string;
}

export type OnIteration = (record: IterationRecord) => void | 'stop' | IterationDirective;

/**
 * Compose several onIteration hooks (progress printer, HALO tracer,
 * coordination heartbeat, escalation controller…) into one. Hooks run in
 * order; their directives merge: `stop`/`enableCritic` OR together,
 * `raiseMaxTurns` takes the max, scalar fields last-writer-wins, notes join.
 */
export function composeIterationHooks(
  ...hooks: Array<OnIteration | undefined>
): OnIteration {
  const active = hooks.filter((h): h is OnIteration => typeof h === 'function');
  return (record) => {
    const merged: IterationDirective = {};
    const notes: string[] = [];
    for (const hook of active) {
      // Isolate hook failures: the loop calls onIteration uncaught, so one
      // throwing observer (progress printer, tracer) must not abort the run
      // or starve later hooks (heartbeat, escalation) of the record.
      let directive: IterationDirective;
      try {
        directive = normalizeDirective(hook(record));
      } catch {
        continue;
      }
      if (directive.stop) merged.stop = true;
      if (directive.enableCritic) merged.enableCritic = true;
      if (directive.regenerateSeeds) merged.regenerateSeeds = true;
      if (directive.switchExecutor) merged.switchExecutor = directive.switchExecutor;
      if (typeof directive.setCandidates === 'number') merged.setCandidates = directive.setCandidates;
      if (
        typeof directive.raiseMaxTurns === 'number' &&
        directive.raiseMaxTurns > (merged.raiseMaxTurns ?? 0)
      ) {
        merged.raiseMaxTurns = directive.raiseMaxTurns;
      }
      if (directive.note) notes.push(directive.note);
    }
    if (notes.length > 0) merged.note = notes.join('; ');
    return merged;
  };
}

/** Retrieve best-practice guidance for a task (Phase 4). */
export type PracticeProvider = (instruction: string) => string[] | Promise<string[]>;

export interface ConvergenceConfig {
  /** Maximum execute→apply→verify iterations (default 5) */
  maxTurns?: number;
  /** Project whose gates define "delivered" */
  projectRoot: string;
  /** Override auto-detected gates (e.g. subset via CLI --gates) */
  rungs?: GateRung[];
  /** Ladder options forwarded to the runner */
  ladderOptions?: LadderOptions;
  /**
   * Run the ladder once before turn 1 (default true). When the baseline is
   * already green there is nothing to converge on — the loop returns
   * alreadyDelivered without calling the model, preventing false-success
   * outcomes from polluting adaptive routing.
   */
  baselineCheck?: boolean;
  /** Max characters of prior model output included in retry prompts (default 3000) */
  previousOutputChars?: number;
  /**
   * Run gates every turn even when the applier wrote no files. Required for
   * executors that mutate the project directly (e.g. the agentic tool-loop
   * executor with a no-op applier) — otherwise the "skip gates when nothing
   * applied" optimization permanently scores such turns 0%.
   */
  alwaysVerify?: boolean;
  /**
   * Re-detect gates each turn and merge any that newly become available. Gate
   * detection runs once at t0, so a FROM-SCRATCH build (empty dir) never picks
   * up the runtime execution gate or build/test gates — the artifact doesn't
   * exist yet. With this on, once the model writes files (e.g. an index.html),
   * the execution gate (and build/test/lint) join the required set and gate the
   * remaining turns. Existing rungs (incl. an authored self-gate) are preserved;
   * merge is union-by-id. Default off to keep other consumers unchanged.
   *
   * NOTE: re-detection runs at the top of each turn (before that turn's
   * execute/apply), so a freshly-written artifact is gated starting the NEXT
   * turn (one-turn lag). Multi-turn builds — the common case — are covered; a
   * task that fully passes in a single turn, before its artifact existed at
   * detection time, can still finish without the execution gate.
   */
  redetectRungs?: boolean;
  /**
   * Predicate limiting which re-detected rungs may be merged (honor the CLI's
   * tier ceiling / --gates subset / --no-integration). When omitted, only the
   * cheap always-safe tiers (fast + runtime) are merged, so re-detection never
   * silently escalates to integration/deploy-dev work.
   */
  redetectFilter?: (rung: GateRung) => boolean;
  /** Best-of-N exploration per turn (Phase 2); omit for single-candidate turns */
  explorer?: ExplorerSettings;
  /** Structured critique of failed turns (Phase 3) */
  critic?: Critic;
  /** Best-practice guidance injected into prompts (Phase 4) */
  practiceProvider?: PracticeProvider;
  /** Factory the escalation controller uses to build a critic when it
   * enables one mid-run (Phase 5). Receives the current executor so the
   * critic uses the same (possibly escalated) model as generation. */
  criticFactory?: (executor: LoopExecutor) => Critic;
  /**
   * Called after every iteration. Return 'stop' or an IterationDirective to
   * steer the loop (Phase 5 escalation controllers hook in here).
   */
  onIteration?: OnIteration;
  /**
   * Refuse model writes to pre-existing test/spec files (default true).
   * Gate integrity: rewriting the spec to satisfy the gates is not delivery.
   */
  protectTests?: boolean;
  /**
   * Extra project-relative paths to include in the runtime integrity snapshot
   * beyond the auto-detected tests/oracle — e.g. the self-authored acceptance
   * gate script (`.uap-deliver/verify.sh`), which the model could otherwise
   * rewrite via run_bash to pass vacuously (security audit X1). Restored if
   * mutated during a gate run, discarding that turn.
   */
  extraProtectedPaths?: string[];
  /**
   * Polled once before each turn for operator guidance to steer the mission
   * WITHOUT stopping it: any returned text is injected into that turn's
   * prompt as high-priority guidance. Return undefined/'' for no change.
   * Fail-soft — a throwing provider is ignored. This is the natural-language
   * steering channel; onIteration remains the execution-level control channel.
   */
  guidanceProvider?: () => string | undefined | Promise<string | undefined>;
  /**
   * Inject the mission-autonomy policy into prompts (default true): the model
   * is told to complete the whole task without stopping to ask. Set false for
   * ambiguity-sensitive tasks where "proceed on assumptions" is undesirable.
   */
  autonomous?: boolean;
  /**
   * Persist until delivered (full autonomy): keep iterating past `maxTurns`
   * until every required gate passes, the `maxTurnsCeiling` is reached, or
   * progress stalls (no score improvement for several consecutive turns).
   * Bounded by the ceiling and the stagnation guard so it cannot loop forever.
   */
  untilDelivered?: boolean;
  /**
   * Hard upper bound on turns when untilDelivered is set. Library default 50;
   * the `uap deliver --until-delivered` CLI defaults it to 30 (override with
   * `--ceiling`). Also caps escalation's raiseMaxTurns under untilDelivered.
   */
  maxTurnsCeiling?: number;
  /**
   * Called after every completed turn with serializable loop state so callers
   * can persist it (durable runs). Fail-soft: a throwing callback is ignored.
   */
  onCheckpoint?: (checkpoint: LoopCheckpoint) => void;
  /**
   * Cooperative cancel: polled before each turn. Returning true breaks the loop
   * so the caller can mark the run interrupted (dashboard/operator stop-file).
   */
  shouldStop?: () => boolean | Promise<boolean>;
  /**
   * Resume an interrupted run from a persisted checkpoint: prior history,
   * prompt context, and stagnation counters are restored and the loop
   * continues at checkpoint.turn + 1 with a fresh `maxTurns` budget.
   */
  resumeFrom?: LoopCheckpoint;
  /**
   * Regenerates divergent strategy seeds mid-run (see IterationDirective.
   * regenerateSeeds). Receives the instruction plus the latest gate feedback so
   * fresh seeds steer AWAY from the failing region of solution space.
   */
  seedGenerator?: (instruction: string, feedback?: string) => Promise<StrategySeed[]>;
}

/**
 * Serializable loop state persisted after every turn so an interrupted run can
 * be resumed (`uap deliver --resume`). Contains only harness-owned data plus
 * the truncated prompt-context strings the next turn would have received —
 * no functions, no full model transcripts.
 */
export interface LoopCheckpoint {
  /** Last completed 1-based turn. */
  turn: number;
  history: IterationRecord[];
  /** Prompt context carried into the next turn (practices/protectedFiles are re-derived on resume). */
  prevContext: {
    previousOutput?: string;
    feedback?: string;
    applyError?: string;
    previousFiles?: string[];
    critique?: string[];
  };
  bestSoFar: number;
  bestAcceptance: number;
  stagnantTurns: number;
  /** Escalation state applied mid-run, so a resumed run is NOT silently
   *  de-escalated: exploration width + seeds and the critic are restored by
   *  the loop; a model switch cannot serialize, so `modelEscalated` is a
   *  signal the CLI uses to re-bind the stronger executor before resuming. */
  candidates?: number;
  seeds?: StrategySeed[];
  criticEnabled?: boolean;
  modelEscalated?: boolean;
}

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_MAX_TURNS_CEILING = 50;
/** Consecutive non-improving turns after which untilDelivered stops extending. */
const STAGNATION_LIMIT = 4;
const DEFAULT_PREVIOUS_OUTPUT_CHARS = 3_000;

const OUTPUT_CONTRACT = [
  'You are an autonomous software delivery agent. Complete the task by emitting complete file contents.',
  '',
  'OUTPUT FORMAT — emit every file you create or modify as a fenced block:',
  '```file:relative/path/from/project/root',
  '<entire file content>',
  '```',
  'Use a longer fence (````file:path) when the file itself contains ``` sequences.',
  'Files are written to disk verbatim, then real gates (build, type-check, tests) run.',
  'Emit file blocks plus a one-line progress note: what you changed and what remains.',
].join('\n');

/**
 * Behavioral autonomy policy — included by defaultPromptBuilder unless the run
 * opts out (PromptContext.autonomous === false). Kept separate from the
 * output-format contract so consumers can disable the "proceed on sensible
 * assumptions" stance for ambiguity-sensitive tasks without replacing the
 * whole prompt builder. Default-on: this loop is unattended by construction.
 */
const AUTONOMY_CONTRACT = [
  'MISSION AUTONOMY — this loop runs unattended to completion:',
  '- Complete the ENTIRE task — every file and step needed to make the gates pass.',
  '- Never stop to ask questions or request confirmation. If a detail is unspecified, pick a sensible default, state the assumption in one line, and proceed.',
  '- Do not hand back partial work for approval or pause between steps/phases. Keep going until the whole task is done.',
  '- Do not invent requirements the task and gates do not imply — satisfy the spec, do not expand it.',
  '- Each turn, do as much complete, correct work as you can — not a single tiny step.',
].join('\n');

function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated)…`;
}

/** Coerce the onIteration return (void | 'stop' | directive) to a directive. */
function normalizeDirective(value: void | 'stop' | IterationDirective): IterationDirective {
  if (value === 'stop') return { stop: true };
  if (!value) return {};
  return value;
}

/** Render the protected pre-existing test files as a prompt section. */
function protectedSection(protectedFiles?: string[]): string[] {
  if (!protectedFiles || protectedFiles.length === 0) return [];
  const shown = protectedFiles.slice(0, 10);
  const more = protectedFiles.length - shown.length;
  return [
    '',
    'PROTECTED FILES (tests + the fixtures/helpers they use) — read-only for this run; implement the source so the existing tests pass:',
    ...shown.map((f) => `- ${f}`),
    ...(more > 0 ? [`…and ${more} more`] : []),
  ];
}

/** Include the autonomy policy unless explicitly opted out (default on). */
function autonomySection(autonomous?: boolean): string[] {
  if (autonomous === false) return [];
  return ['', AUTONOMY_CONTRACT];
}

/**
 * Render mid-run operator guidance as a high-priority prompt section. This is
 * how the mission is steered without stopping — the loop keeps running and the
 * model incorporates the guidance on its next turn.
 */
function guidanceSection(guidance?: string): string[] {
  if (!guidance || !guidance.trim()) return [];
  return ['', 'OPERATOR GUIDANCE (incorporate this now and keep going — do NOT stop):', guidance.trim()];
}

/** Render retrieved best-practice cards as a prompt section. */
function practiceSection(practices?: string[]): string[] {
  if (!practices || practices.length === 0) return [];
  const lines = ['', 'PROVEN PRACTICES for tasks like this — follow them:'];
  practices.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  return lines;
}

/** Default prompt strategy: lean contract + structured retry context. */
export const defaultPromptBuilder: PromptBuilder = (ctx) => {
  if (ctx.turn === 1) {
    return [OUTPUT_CONTRACT, ...autonomySection(ctx.autonomous), ...guidanceSection(ctx.guidance), ...protectedSection(ctx.protectedFiles), ...practiceSection(ctx.practices), '', `TASK: ${ctx.instruction}`].join('\n');
  }

  const sections = [OUTPUT_CONTRACT, ...autonomySection(ctx.autonomous), ...guidanceSection(ctx.guidance), ...protectedSection(ctx.protectedFiles), ...practiceSection(ctx.practices), '', `TASK: ${ctx.instruction}`, ''];
  sections.push(`PREVIOUS ATTEMPT (turn ${ctx.turn - 1}):`);

  if (ctx.previousFiles && ctx.previousFiles.length > 0) {
    sections.push(`Files you emitted: ${ctx.previousFiles.join(', ')}`);
  }
  if (ctx.applyError) {
    sections.push(`Your output could not be applied: ${ctx.applyError}`);
  }

  // A structured repair plan outranks the raw gate dump: one concrete action
  // per line is what small models can actually execute.
  if (ctx.critique && ctx.critique.length > 0) {
    sections.push('');
    sections.push('REPAIR PLAN — apply these fixes exactly:');
    ctx.critique.forEach((step, i) => sections.push(`${i + 1}. ${step}`));
  }

  if (ctx.feedback) {
    sections.push('');
    sections.push(ctx.feedback);
  }
  if (ctx.previousOutput) {
    sections.push('');
    sections.push('Your previous output (truncated):');
    sections.push(truncateHead(ctx.previousOutput, DEFAULT_PREVIOUS_OUTPUT_CHARS));
  }

  sections.push('');
  sections.push('Fix the issues and emit corrected file blocks.');
  return sections.join('\n');
};

interface TurnOutcome {
  output: string;
  filesApplied: string[];
  ladder: LadderResult | null;
  executorError?: string;
  applyError?: string;
  strategy?: string;
  candidates?: CandidateSummary[];
  judgeRationale?: string;
}

/**
 * Optional behavioral-completeness gate, run AFTER objective gates pass: judges
 * whether the spec's requirements are actually implemented and returns
 * `{ passed, feedback }` (feedback = the unmet criteria). Injected by the CLI so
 * the loop stays decoupled from the acceptance-judge module. The implementation
 * is expected to fail open internally (a judgment must not wedge delivery).
 */
export type AcceptanceGate = (projectRoot: string) => Promise<{
  passed: boolean;
  feedback: string;
  /** Fraction of spec criteria met (0..1); lets the loop see acceptance progress. */
  score?: number;
}>;

export class ConvergenceLoop {
  private readonly config: ConvergenceConfig;
  private readonly executor: LoopExecutor;
  private readonly ladderRunner: LadderRunner;
  private readonly applier: Applier;
  private readonly promptBuilder: PromptBuilder;
  private readonly acceptanceGate?: AcceptanceGate;

  constructor(
    config: ConvergenceConfig,
    executor: LoopExecutor,
    seams: {
      ladderRunner?: LadderRunner;
      applier?: Applier;
      promptBuilder?: PromptBuilder;
      acceptanceGate?: AcceptanceGate;
    } = {}
  ) {
    this.config = config;
    this.executor = executor;
    this.ladderRunner = seams.ladderRunner ?? runLadder;
    this.applier = seams.applier ?? applyFileBlocks;
    this.promptBuilder = seams.promptBuilder ?? defaultPromptBuilder;
    this.acceptanceGate = seams.acceptanceGate;
  }

  /**
   * Behavioral-completeness check, run ONCE on a committed verdict (the baseline
   * or a turn's final/winner ladder) — never per explorer candidate. When the
   * objective gates passed but the spec's requirements aren't all met, flip the
   * verdict to not-passed and append the gaps as feedback so the loop iterates to
   * complete the spec. Fails open (returns the objective verdict) on any error.
   * Returns the (possibly-flipped) ladder and the criteria-met fraction so the
   * caller can treat acceptance progress as forward motion for stagnation.
   */
  private async judgeAcceptance(ladder: LadderResult): Promise<{ ladder: LadderResult; acceptanceMet?: number }> {
    if (!this.acceptanceGate || !ladder.passed) return { ladder };
    let acc: { passed: boolean; feedback: string; score?: number };
    try {
      acc = await this.acceptanceGate(this.config.projectRoot);
    } catch {
      return { ladder }; // fail open — the judge must never block delivery
    }
    if (acc.passed || !acc.feedback) return { ladder, acceptanceMet: acc.score };
    return {
      ladder: { ...ladder, passed: false, feedback: `${ladder.feedback}\n\n${acc.feedback}`.trim() },
      acceptanceMet: acc.score,
    };
  }

  /**
   * Re-run gate detection and return `rungs` plus any newly-detectable gates
   * (union by id; existing rungs are kept and take precedence). Fail-soft: a
   * detection error returns the current set unchanged.
   */
  private mergeDetectedRungs(rungs: GateRung[]): GateRung[] {
    let detected: GateRung[];
    try {
      detected = detectRungs(this.config.projectRoot);
    } catch {
      return rungs;
    }
    const have = new Set(rungs.map((r) => r.id));
    // Default policy: only merge cheap always-safe tiers (fast + runtime) so
    // re-detection never silently escalates to integration/deploy-dev. A caller
    // can pass redetectFilter to enforce its own tier ceiling / --gates subset.
    const allow = this.config.redetectFilter ?? ((r: GateRung) => tierOf(r) === 'fast' || tierOf(r) === 'runtime');
    const added = detected.filter((r) => !have.has(r.id) && allow(r));
    return added.length > 0 ? [...rungs, ...added] : rungs;
  }

  /** Single-candidate turn: execute → apply → verify. */
  private async runSingleTurn(
    prompt: string,
    rungs: GateRung[],
    executor: LoopExecutor,
    ladderRunner: LadderRunner,
    applyOptions?: ApplyOptions
  ): Promise<TurnOutcome> {
    let output = '';
    let executorError: string | undefined;
    try {
      output = await executor(prompt);
    } catch (err) {
      executorError = err instanceof Error ? err.message : String(err);
    }

    let applyResult: ApplyResult | null = null;
    let applyError: string | undefined;
    if (!executorError) {
      applyResult = await this.applier(output, this.config.projectRoot, applyOptions);
      if (applyResult.error) {
        applyError = applyResult.error;
      } else if (applyResult.rejected.length > 0) {
        applyError = `Rejected blocks: ${applyResult.rejected
          .map((r) => `${r.path} (${r.reason})`)
          .join('; ')}`;
      }
    }

    // Verify — only when something was applied; otherwise the tree is
    // unchanged and re-running gates would waste minutes for no signal.
    const filesApplied = applyResult?.filesWritten ?? [];
    let ladder: LadderResult | null = null;
    if (!executorError && (filesApplied.length > 0 || this.config.alwaysVerify)) {
      ladder = await ladderRunner(rungs, this.config.projectRoot, this.config.ladderOptions);
    }

    return { output, filesApplied, ladder, executorError, applyError };
  }

  /** Explorer turn: best-of-N candidates, commit the winner (Phase 2). */
  private async runExplorerTurn(
    instruction: string,
    prompt: string,
    rungs: GateRung[],
    settings: ExplorerSettings,
    executor: LoopExecutor,
    ladderRunner: LadderRunner,
    applyOptions?: ApplyOptions
  ): Promise<TurnOutcome> {
    const exploration = await exploreAndCommit(instruction, prompt, executor, {
      candidates: settings.candidates,
      seeds: settings.seeds,
      judge: settings.judge,
      workspaceProvider: settings.workspaceProvider,
      projectRoot: this.config.projectRoot,
      rungs,
      ladderOptions: this.config.ladderOptions,
      ladderRunner,
      applyOptions,
    });

    const summaries: CandidateSummary[] = exploration.candidates.map((c) => ({
      id: c.id,
      strategy: c.strategy,
      passed: c.passed,
      score: c.score,
      error: c.error,
    }));

    const winner = exploration.winner;
    if (!winner) {
      // Distinguish executor failure (no usable model output) from apply
      // failure (output produced but no file blocks) so the retry prompt
      // carries the right guidance — matching single-turn feedback quality.
      const execErrors = exploration.candidates.map((c) => c.error).filter(Boolean);
      if (execErrors.length === exploration.candidates.length && execErrors.length > 0) {
        return {
          output: '',
          filesApplied: [],
          ladder: null,
          executorError: execErrors.join('; '),
          candidates: summaries,
        };
      }
      const applyErr =
        exploration.candidates.map((c) => c.applyResult?.error).find(Boolean) ??
        'No candidate produced applicable file blocks.';
      return {
        output: '',
        filesApplied: [],
        ladder: null,
        applyError: applyErr,
        candidates: summaries,
      };
    }

    let applyError: string | undefined;
    if (winner.applyResult?.error) {
      applyError = winner.applyResult.error;
    } else if (winner.applyResult && winner.applyResult.rejected.length > 0) {
      applyError = `Rejected blocks: ${winner.applyResult.rejected
        .map((r) => `${r.path} (${r.reason})`)
        .join('; ')}`;
    }

    return {
      output: winner.output,
      filesApplied: winner.applyResult?.filesWritten ?? [],
      ladder: exploration.ladder,
      applyError,
      strategy: winner.strategy,
      candidates: summaries,
      judgeRationale: exploration.judgeRationale,
    };
  }

  /**
   * Run the loop for an instruction until all required gates pass or the
   * turn budget is exhausted. Returns the full iteration history so callers
   * can record outcomes and inspect convergence behavior.
   */
  async deliver(instruction: string): Promise<DeliveryResult> {
    const start = Date.now();
    let rungs =
      this.config.rungs && this.config.rungs.length > 0
        ? [...this.config.rungs]
        : detectRungs(this.config.projectRoot);

    if (rungs.length === 0) {
      throw new Error(
        `No verifiable gates for ${this.config.projectRoot} — pass explicit rungs or add package.json scripts.`
      );
    }


    // Mutable run-state — a Phase 5 escalation directive can raise the budget,
    // switch the model, enable exploration, or turn on the critic mid-run.
    let maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error(`maxTurns must be a positive integer, got ${String(this.config.maxTurns)}`);
    }
    // Persist-until-delivered run-state. The ceiling is a hard stop; the
    // stagnation counter aborts a run that can no longer improve, so "loop
    // until 100% delivered" can never become an unbounded loop.
    const untilDelivered = this.config.untilDelivered ?? false;
    const maxTurnsCeiling = Math.max(maxTurns, this.config.maxTurnsCeiling ?? DEFAULT_MAX_TURNS_CEILING);
    let bestSoFar = -1;
    let bestAcceptance = -1;
    let stagnantTurns = 0;
    let executor = this.executor;
    let explorerSettings = this.config.explorer;
    let critic = this.config.critic;
    let modelEscalated = false;

    const history: IterationRecord[] = [];
    const previousOutputChars = this.config.previousOutputChars ?? DEFAULT_PREVIOUS_OUTPUT_CHARS;

    // Baseline: a green tree means there is nothing for the loop to deliver.
    // Acceptance gaps count as "not delivered", so an objective-green project
    // with an incomplete spec still runs turns instead of short-circuiting.
    if (this.config.baselineCheck ?? true) {
      const rawBaseline = await this.ladderRunner(rungs, this.config.projectRoot, this.config.ladderOptions);
      const baseline = (await this.judgeAcceptance(rawBaseline)).ladder;
      if (baseline.passed) {
        return {
          success: true,
          alreadyDelivered: true,
          turns: 0,
          bestScore: baseline.score,
          bestTurn: 0,
          history,
          finalFeedback: baseline.feedback,
          finalOutput: '',
          totalDurationMs: Date.now() - start,
        };
      }
    }

    // Gate-integrity snapshot, taken AFTER the baseline ladder run so files
    // the gates themselves create on first run (e.g. __snapshots__/*.snap)
    // are included. Test files existing now are protected for the whole run;
    // tests the model creates later remain editable. Fail-soft — an
    // unreadable tree just yields an empty set.
    const protectTests = this.config.protectTests ?? true;
    let protectedFiles: Set<string> | undefined;
    let protectedList: string[] | undefined;
    if (protectTests) {
      try {
        // Tests plus the oracle material (helpers/fixtures/data) their
        // import graphs reference — see spec-imports.ts for the scope.
        const snapshot = snapshotProtection(this.config.projectRoot);
        protectedFiles = snapshot.protectedFiles.size > 0 ? snapshot.protectedFiles : undefined;
        protectedList = snapshot.display.length > 0 ? snapshot.display : undefined;
      } catch {
        protectedFiles = undefined;
        protectedList = undefined;
      }
    }
    // Additional harness-owned paths to snapshot for integrity (security audit
    // X1): the self-authored gate script (.uap-deliver/verify.sh). The applier
    // now blocks write_file/file-block overwrites of it, but run_bash bypasses
    // the applier — snapshotting it here means a run_bash rewrite to `exit 0`
    // is detected and restored, discarding that turn like any oracle tamper.
    if (this.config.extraProtectedPaths?.length) {
      protectedList = [...(protectedList ?? []), ...this.config.extraProtectedPaths];
    }
    const applyOptions: ApplyOptions | undefined = protectTests
      ? { protectedFiles, protectGateConfigs: true }
      : undefined;

    // Runtime tamper guard: the applier filter cannot stop a model-authored
    // test file from writeFileSync-ing over a protected oracle while the
    // gates execute. Snapshot bytes now; after every gate run verify and
    // restore, discarding tampered results. Wrapping the runner here also
    // covers explorer candidate evaluations, which receive this runner.
    let ladderRunner: LadderRunner = this.ladderRunner;
    if (protectTests && protectedList && protectedList.length > 0) {
      try {
        const integrity = captureIntegrity(this.config.projectRoot, protectedList);
        const inner = this.ladderRunner;
        ladderRunner = async (gateRungs, root, opts) => {
          const ladderResult = await inner(gateRungs, root, opts);
          // Verify the tree the gates actually ran in — under workspace
          // isolation `root` is a per-candidate worktree, and checking the
          // main tree would both miss in-workspace tampering and race
          // concurrent candidates' restores.
          const check = verifyAndRestore(root, integrity);
          if (check.tampered.length > 0) {
            return {
              ...ladderResult,
              passed: false,
              feedback: `${integrityViolationFeedback(check)}\n\n${ladderResult.feedback}`,
            };
          }
          return ladderResult;
        };
      } catch {
        // Guard is fail-soft; applier-level protection still applies.
      }
    }

    // Phase 4: retrieve best-practice cards once — they are task-level and
    // stable across turns. Fail-soft so retrieval never blocks delivery.
    let practices: string[] | undefined;
    if (this.config.practiceProvider) {
      try {
        const fetched = await this.config.practiceProvider(instruction);
        practices = fetched.length > 0 ? fetched : undefined;
      } catch {
        practices = undefined;
      }
    }

    let success = false;
    let finalOutput = '';
    let finalFeedback = '';
    let prevContext: Omit<PromptContext, 'instruction' | 'turn'> = { practices, protectedFiles: protectedList };

    // Resume: restore prior history/context/counters and continue where the
    // interrupted run left off, with a fresh `maxTurns` budget on top.
    let startTurn = 1;
    const resume = this.config.resumeFrom;
    if (resume && resume.turn >= 1 && resume.history.length > 0) {
      history.push(...resume.history);
      prevContext = { ...resume.prevContext, practices, protectedFiles: protectedList };
      bestSoFar = resume.bestSoFar ?? -1;
      bestAcceptance = resume.bestAcceptance ?? -1;
      stagnantTurns = resume.stagnantTurns ?? 0;
      startTurn = resume.turn + 1;
      // Restore mid-run escalation state so resume is not a silent downgrade.
      if (typeof resume.candidates === 'number' && resume.candidates >= 2) {
        explorerSettings = {
          ...(explorerSettings ?? {}),
          candidates: resume.candidates,
          seeds: resume.seeds && resume.seeds.length >= 2 ? resume.seeds : explorerSettings?.seeds,
        };
      }
      if (resume.criticEnabled && !critic && this.config.criticFactory) {
        critic = this.config.criticFactory(executor);
      }
      modelEscalated = Boolean(resume.modelEscalated);
      // Fresh budget of `maxTurns` more turns from the resume point — but the
      // until-delivered ceiling stays a HARD cap across process boundaries:
      // repeated interrupt+resume must never grant unbounded turns.
      maxTurns = untilDelivered
        ? Math.min(resume.turn + maxTurns, maxTurnsCeiling)
        : resume.turn + maxTurns;
    }

    for (let turn = startTurn; turn <= maxTurns; turn++) {
      const turnStart = Date.now();

      // Cooperative cancel (dashboard/operator): stop BEFORE any model work this
      // turn. Fail-open — a broken predicate must never wedge the loop.
      if (this.config.shouldStop) {
        try {
          if (await this.config.shouldStop()) break;
        } catch {
          /* ignore predicate errors */
        }
      }

      // Re-detect gates: a from-scratch build has no artifact at t0, so the
      // execution gate (and build/test/lint) only become detectable once the
      // model has written files. Merge any newly-available gates (union by id;
      // existing rungs incl. a self-gate are preserved) so the remaining turns
      // are gated on the real artifact, not just the t0 fallback.
      if (this.config.redetectRungs) {
        rungs = this.mergeDetectedRungs(rungs);
      }

      // Poll for operator guidance to steer this turn without stopping the
      // mission. Fail-soft — guidance is a best-effort steering channel.
      let guidance: string | undefined;
      if (this.config.guidanceProvider) {
        try {
          const g = await this.config.guidanceProvider();
          guidance = g && g.trim() ? g.trim() : undefined;
        } catch {
          guidance = undefined;
        }
      }

      const prompt = this.promptBuilder({
        instruction,
        turn,
        ...prevContext,
        guidance,
        autonomous: this.config.autonomous,
      });

      const outcome = explorerSettings
        ? await this.runExplorerTurn(instruction, prompt, rungs, explorerSettings, executor, ladderRunner, applyOptions)
        : await this.runSingleTurn(prompt, rungs, executor, ladderRunner, applyOptions);

      // Acceptance: judge ONCE on this turn's committed verdict (single-turn
      // result or explorer winner) — not per candidate — flipping it to
      // not-passed with gap feedback when the spec isn't fully implemented.
      let acceptanceMet: number | undefined;
      if (outcome.ladder) {
        const judged = await this.judgeAcceptance(outcome.ladder);
        outcome.ladder = judged.ladder;
        acceptanceMet = judged.acceptanceMet;
      }

      // Close the one-turn re-detection lag: a turn that PASSES having just
      // written the project's first artifact was verified against pre-artifact
      // gates (the execution/build/test gates only became detectable after the
      // apply). Re-detect NOW and, if new gates joined, re-verify this same
      // turn against the full set before declaring success.
      if (
        outcome.ladder?.passed &&
        this.config.redetectRungs &&
        (outcome.filesApplied.length > 0 || this.config.alwaysVerify)
      ) {
        const merged = this.mergeDetectedRungs(rungs);
        if (merged.length > rungs.length) {
          rungs = merged;
          let reladder = await ladderRunner(rungs, this.config.projectRoot, this.config.ladderOptions);
          const rejudged = await this.judgeAcceptance(reladder);
          reladder = rejudged.ladder;
          acceptanceMet = rejudged.acceptanceMet ?? acceptanceMet;
          outcome.ladder = reladder;
        }
      }

      finalOutput = outcome.output || finalOutput;
      if (outcome.ladder) {
        finalFeedback = outcome.ladder.feedback;
      }

      const record: IterationRecord = {
        turn,
        passed: outcome.ladder?.passed ?? false,
        score: outcome.ladder?.score ?? 0,
        gateResults: outcome.ladder?.results ?? [],
        filesApplied: outcome.filesApplied,
        executorError: outcome.executorError,
        applyError: outcome.applyError,
        strategy: outcome.strategy,
        candidates: outcome.candidates,
        judgeRationale: outcome.judgeRationale,
        acceptanceMet,
        ...(outcome.output?.includes(CONTEXT_BUDGET_MARKER) ? { budgetStopped: true } : {}),
        durationMs: Date.now() - turnStart,
      };
      history.push(record);

      if (outcome.ladder?.passed) {
        success = true;
        this.config.onIteration?.(record);
        break;
      }

      const directive = normalizeDirective(this.config.onIteration?.(record));
      if (directive.stop) {
        break;
      }

      // Apply escalation directives to the run-state for subsequent turns
      if (directive.switchExecutor) {
        executor = directive.switchExecutor;
        modelEscalated = true;
      }
      if (typeof directive.setCandidates === 'number') {
        explorerSettings = { ...(explorerSettings ?? {}), candidates: directive.setCandidates };
      }
      if (directive.enableCritic && !critic && this.config.criticFactory) {
        // Bind to the current (possibly just-switched) executor, not the base.
        critic = this.config.criticFactory(executor);
      }
      if (directive.regenerateSeeds && this.config.seedGenerator && explorerSettings) {
        // Reseed REPLACES seeds on an already-active explorer; it must never
        // bootstrap exploration on a run whose executor can't use it (agentic).
        // Stagnation-triggered ideation: fresh, feedback-aware divergent seeds
        // re-diversify exploration away from the failing region. Fail-soft —
        // a generator error keeps the current seeds.
        try {
          const fresh = await this.config.seedGenerator(
            instruction,
            outcome.ladder?.feedback ?? outcome.applyError
          );
          if (fresh.length >= 2) {
            explorerSettings = {
              ...(explorerSettings ?? {}),
              seeds: fresh,
              candidates: explorerSettings?.candidates ?? Math.min(fresh.length, 4),
            };
          }
        } catch {
          // keep current seeds
        }
      }
      if (typeof directive.raiseMaxTurns === 'number' && directive.raiseMaxTurns > maxTurns) {
        // The ceiling is ALWAYS a hard cap on escalation raises — with or
        // without untilDelivered — so an operator's explicit --max-turns
        // (which the CLI mirrors into the ceiling) cannot be exceeded, and
        // the "never an unbounded loop" guarantee holds even with --escalate.
        maxTurns = Math.max(maxTurns, Math.min(directive.raiseMaxTurns, maxTurnsCeiling));
      }

      // Persist-until-delivered: extend the budget one turn at a time while we
      // are at the edge of it, below the ceiling, and still making progress.
      // Stop extending (let the loop end) once progress stalls — an
      // unattended run must converge or give up, never spin forever.
      if (untilDelivered) {
        // Progress = a better objective score OR more acceptance criteria met.
        // Without the acceptance term, an objective-green run pins score at 1.0,
        // so acceptance-driven completion would always read as "stagnant" and the
        // loop would give up after STAGNATION_LIMIT turns regardless of real
        // spec progress.
        const objectiveProgress = record.score > bestSoFar;
        const acceptanceProgress = acceptanceMet !== undefined && acceptanceMet > bestAcceptance;
        if (objectiveProgress || acceptanceProgress) {
          if (objectiveProgress) bestSoFar = record.score;
          if (acceptanceProgress) bestAcceptance = acceptanceMet as number;
          stagnantTurns = 0;
        } else {
          stagnantTurns++;
        }
        // Extend only at the budget edge, below the ceiling, while improving.
        // When stagnant, we simply stop extending and the loop ends.
        if (turn === maxTurns && maxTurns < maxTurnsCeiling && stagnantTurns < STAGNATION_LIMIT) {
          maxTurns += 1;
        }
      }

      // Phase 3: structured critique of the failed turn (fail-soft). Skipped
      // on the last turn — prevContext is never consumed, so it would waste
      // a model call.
      let critique: string[] | undefined;
      if (critic && !outcome.executorError && turn < maxTurns) {
        try {
          const result = await critic({
            instruction,
            record,
            feedback: outcome.ladder?.feedback ?? outcome.applyError ?? '',
            attemptOutput: truncateHead(outcome.output, previousOutputChars),
          });
          critique = result.fixList.length > 0 ? result.fixList : undefined;
        } catch {
          critique = undefined;
        }
      }

      prevContext = {
        previousOutput: outcome.executorError
          ? undefined
          : truncateHead(outcome.output, previousOutputChars),
        feedback: outcome.executorError
          ? `Model call failed: ${outcome.executorError}`
          : outcome.ladder?.feedback,
        applyError: outcome.applyError,
        previousFiles: outcome.filesApplied.length > 0 ? outcome.filesApplied : undefined,
        critique,
        practices,
        protectedFiles: protectedList,
      };

      // Durable runs: persist serializable loop state so an interrupted run
      // can resume at this exact point. Fail-soft by contract.
      if (this.config.onCheckpoint) {
        try {
          this.config.onCheckpoint({
            turn,
            history: [...history],
            prevContext: {
              previousOutput: prevContext.previousOutput,
              feedback: prevContext.feedback,
              applyError: prevContext.applyError,
              previousFiles: prevContext.previousFiles,
              critique: prevContext.critique,
            },
            bestSoFar,
            bestAcceptance,
            stagnantTurns,
            candidates: explorerSettings?.candidates,
            seeds: explorerSettings?.seeds,
            criticEnabled: Boolean(critic),
            modelEscalated,
          });
        } catch {
          // checkpointing must never break the run
        }
      }
    }

    let bestScore = 0;
    let bestTurn = 0;
    for (const record of history) {
      if (record.score > bestScore) {
        bestScore = record.score;
        bestTurn = record.turn;
      }
    }

    return {
      success,
      alreadyDelivered: false,
      turns: history.length,
      bestScore,
      bestTurn,
      history,
      finalFeedback,
      finalOutput,
      totalDurationMs: Date.now() - start,
    };
  }
}
