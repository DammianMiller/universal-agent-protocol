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
import { detectRungs, runLadder } from './verifier-ladder.js';
import type { Applier, ApplyResult } from './applier.js';
import { applyFileBlocks } from './applier.js';
import type { StrategySeed } from './explorer.js';
import { exploreAndCommit } from './explorer.js';
import type { Judge } from './judge.js';
import type { Critic } from './critic.js';

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
}

const DEFAULT_MAX_TURNS = 5;
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
  'Emit only file blocks plus brief reasoning.',
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
    return [OUTPUT_CONTRACT, ...practiceSection(ctx.practices), '', `TASK: ${ctx.instruction}`].join('\n');
  }

  const sections = [OUTPUT_CONTRACT, ...practiceSection(ctx.practices), '', `TASK: ${ctx.instruction}`, ''];
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

export class ConvergenceLoop {
  private readonly config: ConvergenceConfig;
  private readonly executor: LoopExecutor;
  private readonly ladderRunner: LadderRunner;
  private readonly applier: Applier;
  private readonly promptBuilder: PromptBuilder;

  constructor(
    config: ConvergenceConfig,
    executor: LoopExecutor,
    seams: {
      ladderRunner?: LadderRunner;
      applier?: Applier;
      promptBuilder?: PromptBuilder;
    } = {}
  ) {
    this.config = config;
    this.executor = executor;
    this.ladderRunner = seams.ladderRunner ?? runLadder;
    this.applier = seams.applier ?? applyFileBlocks;
    this.promptBuilder = seams.promptBuilder ?? defaultPromptBuilder;
  }

  /** Single-candidate turn: execute → apply → verify. */
  private async runSingleTurn(
    prompt: string,
    rungs: GateRung[],
    executor: LoopExecutor
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
      applyResult = await this.applier(output, this.config.projectRoot);
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
    if (!executorError && filesApplied.length > 0) {
      ladder = await this.ladderRunner(rungs, this.config.projectRoot, this.config.ladderOptions);
    }

    return { output, filesApplied, ladder, executorError, applyError };
  }

  /** Explorer turn: best-of-N candidates, commit the winner (Phase 2). */
  private async runExplorerTurn(
    instruction: string,
    prompt: string,
    rungs: GateRung[],
    settings: ExplorerSettings,
    executor: LoopExecutor
  ): Promise<TurnOutcome> {
    const exploration = await exploreAndCommit(instruction, prompt, executor, {
      candidates: settings.candidates,
      seeds: settings.seeds,
      judge: settings.judge,
      projectRoot: this.config.projectRoot,
      rungs,
      ladderOptions: this.config.ladderOptions,
      ladderRunner: this.ladderRunner,
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
    const rungs =
      this.config.rungs && this.config.rungs.length > 0
        ? this.config.rungs
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
    let executor = this.executor;
    let explorerSettings = this.config.explorer;
    let critic = this.config.critic;

    const history: IterationRecord[] = [];
    const previousOutputChars = this.config.previousOutputChars ?? DEFAULT_PREVIOUS_OUTPUT_CHARS;

    // Baseline: a green tree means there is nothing for the loop to deliver.
    if (this.config.baselineCheck ?? true) {
      const baseline = await this.ladderRunner(rungs, this.config.projectRoot, this.config.ladderOptions);
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
    let prevContext: Omit<PromptContext, 'instruction' | 'turn'> = { practices };

    for (let turn = 1; turn <= maxTurns; turn++) {
      const turnStart = Date.now();
      const prompt = this.promptBuilder({ instruction, turn, ...prevContext });

      const outcome = explorerSettings
        ? await this.runExplorerTurn(instruction, prompt, rungs, explorerSettings, executor)
        : await this.runSingleTurn(prompt, rungs, executor);

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
      }
      if (typeof directive.setCandidates === 'number') {
        explorerSettings = { ...(explorerSettings ?? {}), candidates: directive.setCandidates };
      }
      if (directive.enableCritic && !critic && this.config.criticFactory) {
        // Bind to the current (possibly just-switched) executor, not the base.
        critic = this.config.criticFactory(executor);
      }
      if (typeof directive.raiseMaxTurns === 'number' && directive.raiseMaxTurns > maxTurns) {
        maxTurns = directive.raiseMaxTurns;
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
      };
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
