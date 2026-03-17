/**
 * Multi-Turn Agent Loop
 *
 * Generic multi-turn execution loop with verification and error recovery.
 * Unlike multi-turn-agent.ts (which is tightly coupled to droid CLI and
 * Terminal-Bench verification), this module provides a reusable loop that
 * accepts any executor and optional verifier functions.
 */

export interface TurnResult {
  turn: number;
  output: string;
  durationMs: number;
  error?: string;
}

export interface MultiTurnResult {
  turns: TurnResult[];
  finalOutput: string;
  success: boolean;
  totalDurationMs: number;
}

export interface MultiTurnLoopConfig {
  maxTurns: number;
  verifyAfterEach: boolean;
  errorRecoveryEnabled: boolean;
}

interface LoopStats {
  completedLoops: number;
  successfulLoops: number;
  totalTurnsAcrossLoops: number;
  turnsInSuccessfulLoops: number;
}

export class MultiTurnAgentLoop {
  private readonly config: MultiTurnLoopConfig;
  private readonly stats: LoopStats;

  constructor(config: MultiTurnLoopConfig) {
    this.config = config;
    this.stats = {
      completedLoops: 0,
      successfulLoops: 0,
      totalTurnsAcrossLoops: 0,
      turnsInSuccessfulLoops: 0,
    };
  }

  /**
   * Execute a single turn: build a prompt from instruction + context, call the executor.
   */
  async executeTurn(
    instruction: string,
    context: string,
    executor: (prompt: string) => Promise<string>
  ): Promise<TurnResult> {
    const startTime = Date.now();
    const prompt = context ? `${context}\n\n${instruction}` : instruction;

    try {
      const output = await executor(prompt);
      return {
        turn: 1,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        turn: 1,
        output: '',
        durationMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute the full multi-turn loop with optional verification and retry.
   *
   * Flow:
   * 1. Execute turn 1 with the original instruction
   * 2. If verifier provided and verifyAfterEach is true, verify output
   * 3. If verification fails and errorRecoveryEnabled, build error feedback prompt and retry
   * 4. Continue until success or maxTurns reached
   * 5. Return all turns, final output, and success status
   */
  async executeWithRetry(
    instruction: string,
    executor: (prompt: string) => Promise<string>,
    verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>
  ): Promise<MultiTurnResult> {
    const loopStartTime = Date.now();
    const turns: TurnResult[] = [];
    let lastOutput = '';
    let success = false;

    for (let turnNum = 1; turnNum <= this.config.maxTurns; turnNum++) {
      const turnStartTime = Date.now();

      // Build prompt: on turn 1 use raw instruction, on subsequent turns
      // include error feedback from the previous verification
      let prompt: string;
      if (turnNum === 1) {
        prompt = instruction;
      } else {
        const lastTurn = turns[turns.length - 1];
        const feedbackContext = lastTurn.error
          ? `Previous attempt (turn ${lastTurn.turn}) failed with error: ${lastTurn.error}`
          : `Previous attempt (turn ${lastTurn.turn}) did not pass verification.`;
        prompt = [
          feedbackContext,
          '',
          'Please fix the issues and try again.',
          '',
          `Original instruction: ${instruction}`,
        ].join('\n');
      }

      // Execute the turn
      let output: string;
      let error: string | undefined;
      try {
        output = await executor(prompt);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        output = '';
      }

      const turnResult: TurnResult = {
        turn: turnNum,
        output,
        durationMs: Date.now() - turnStartTime,
        error,
      };
      turns.push(turnResult);
      lastOutput = output;

      // If execution errored and recovery is disabled, stop
      if (error && !this.config.errorRecoveryEnabled) {
        break;
      }

      // If execution errored, skip verification and retry (if recovery enabled)
      if (error) {
        continue;
      }

      // Verify if verifier provided and verification is enabled
      if (verifier && this.config.verifyAfterEach) {
        try {
          const verification = await verifier(output);
          if (verification.passed) {
            success = true;
            break;
          }

          // Verification failed — attach feedback as error for next turn's context
          if (this.config.errorRecoveryEnabled) {
            turnResult.error = `Verification failed: ${verification.feedback}`;
          } else {
            // No recovery — stop after first verification failure
            turnResult.error = `Verification failed: ${verification.feedback}`;
            break;
          }
        } catch (verifyErr) {
          const verifyError = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          turnResult.error = `Verifier error: ${verifyError}`;
          if (!this.config.errorRecoveryEnabled) {
            break;
          }
        }
      } else {
        // No verifier or verification disabled — first successful execution is a success
        success = true;
        break;
      }
    }

    // Update stats
    this.stats.completedLoops++;
    const totalTurns = turns.length;
    this.stats.totalTurnsAcrossLoops += totalTurns;
    if (success) {
      this.stats.successfulLoops++;
      this.stats.turnsInSuccessfulLoops += totalTurns;
    }

    return {
      turns,
      finalOutput: lastOutput,
      success,
      totalDurationMs: Date.now() - loopStartTime,
    };
  }

  /**
   * Get aggregate statistics across all executeWithRetry calls on this instance.
   */
  getStats(): { totalTurns: number; successRate: number; avgTurnsToSuccess: number } {
    return {
      totalTurns: this.stats.totalTurnsAcrossLoops,
      successRate:
        this.stats.completedLoops > 0 ? this.stats.successfulLoops / this.stats.completedLoops : 0,
      avgTurnsToSuccess:
        this.stats.successfulLoops > 0
          ? this.stats.turnsInSuccessfulLoops / this.stats.successfulLoops
          : 0,
    };
  }
}
