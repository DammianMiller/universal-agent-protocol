/**
 * Convergence Loop
 *
 * Phase 1 of the Fable-parity delivery harness: drives an underlying model
 * through execute → apply → verify → feedback iterations until the project's
 * completion gates (verifier ladder) pass or the turn budget is exhausted.
 *
 * The loop owns four pluggable seams so later phases extend without breaking
 * changes:
 *  - executor: how a prompt becomes model output
 *  - applier: how model output is materialized into the project tree
 *  - promptBuilder: how instruction/feedback/prior output compose a prompt
 *    (Phase 3 structured critique and Phase 4 memory injection plug in here)
 *  - ladderRunner: how gates are verified (tests inject stubs; Phase 2 runs
 *    candidates in isolated worktrees)
 */

import type { GateRung, LadderResult, LadderOptions } from './verifier-ladder.js';
import { detectRungs, runLadder } from './verifier-ladder.js';
import type { Applier, ApplyResult } from './applier.js';
import { applyFileBlocks } from './applier.js';

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
  /** Model output from the previous turn (full, untruncated) */
  previousOutput?: string;
  /** Gate feedback from the previous turn's ladder run */
  feedback?: string;
  /** Apply-stage error from the previous turn (e.g. no file blocks found) */
  applyError?: string;
  /** Files written by the previous turn */
  previousFiles?: string[];
}

export type PromptBuilder = (context: PromptContext) => string;

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
   * Called after every iteration. Return 'stop' to abort the loop early
   * (Phase 5 escalation controllers hook in here).
   */
  onIteration?: (record: IterationRecord) => void | 'stop';
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

/** Default prompt strategy: lean contract + structured retry context. */
export const defaultPromptBuilder: PromptBuilder = (ctx) => {
  if (ctx.turn === 1) {
    return [OUTPUT_CONTRACT, '', `TASK: ${ctx.instruction}`].join('\n');
  }

  const sections = [OUTPUT_CONTRACT, '', `TASK: ${ctx.instruction}`, ''];
  sections.push(`PREVIOUS ATTEMPT (turn ${ctx.turn - 1}):`);

  if (ctx.previousFiles && ctx.previousFiles.length > 0) {
    sections.push(`Files you emitted: ${ctx.previousFiles.join(', ')}`);
  }
  if (ctx.applyError) {
    sections.push(`Your output could not be applied: ${ctx.applyError}`);
  }
  if (ctx.feedback) {
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

  /**
   * Run the loop for an instruction until all required gates pass or the
   * turn budget is exhausted. Returns the full iteration history so callers
   * can record outcomes and inspect convergence behavior.
   */
  async deliver(instruction: string): Promise<DeliveryResult> {
    const start = Date.now();
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const rungs =
      this.config.rungs && this.config.rungs.length > 0
        ? this.config.rungs
        : detectRungs(this.config.projectRoot);

    if (rungs.length === 0) {
      throw new Error(
        `No verifiable gates for ${this.config.projectRoot} — pass explicit rungs or add package.json scripts.`
      );
    }
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error(`maxTurns must be a positive integer, got ${String(this.config.maxTurns)}`);
    }

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

    let success = false;
    let finalOutput = '';
    let finalFeedback = '';
    let prevContext: Omit<PromptContext, 'instruction' | 'turn'> = {};

    for (let turn = 1; turn <= maxTurns; turn++) {
      const turnStart = Date.now();
      const prompt = this.promptBuilder({ instruction, turn, ...prevContext });

      // Execute
      let output = '';
      let executorError: string | undefined;
      try {
        output = await this.executor(prompt);
      } catch (err) {
        executorError = err instanceof Error ? err.message : String(err);
      }
      finalOutput = output || finalOutput;

      // Apply
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
        finalFeedback = ladder.feedback;
      }

      const record: IterationRecord = {
        turn,
        passed: ladder?.passed ?? false,
        score: ladder?.score ?? 0,
        gateResults: ladder?.results ?? [],
        filesApplied,
        executorError,
        applyError,
        durationMs: Date.now() - turnStart,
      };
      history.push(record);
      const directive = this.config.onIteration?.(record);

      if (ladder?.passed) {
        success = true;
        break;
      }
      if (directive === 'stop') {
        break;
      }

      prevContext = {
        previousOutput: executorError
          ? undefined
          : truncateHead(output, previousOutputChars),
        feedback: executorError ? `Model call failed: ${executorError}` : ladder?.feedback,
        applyError,
        previousFiles: filesApplied.length > 0 ? filesApplied : undefined,
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
