/**
 * Multi-Turn Agent Loop for UAP Benchmarks
 *
 * Implements iterative refinement with error feedback.
 * Based on Droid's approach: explore, act, verify, retry.
 */

import { execSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { verifyBenchmarkTask, type VerificationResult } from './execution-verifier.js';
import { retrieveDynamicMemoryContext } from '../memory/dynamic-retrieval.js';

export interface AgentTurn {
  turnNumber: number;
  prompt: string;
  response: string;
  verification: VerificationResult;
  feedback?: string;
  durationMs: number;
}

export interface MultiTurnResult {
  success: boolean;
  totalTurns: number;
  turns: AgentTurn[];
  finalResponse: string;
  totalDurationMs: number;
  memoryContextUsed: boolean;
}

export interface MultiTurnConfig {
  maxTurns: number;
  timeout: number;
  model: string;
  apiKey: string;
  useMemory: boolean;
  projectRoot: string;
  verbose: boolean;
}

const DEFAULT_CONFIG: MultiTurnConfig = {
  maxTurns: 3,
  timeout: 300000,
  model: 'claude-opus-4-5-20251101',
  apiKey: '',
  useMemory: true,
  projectRoot: process.cwd(),
  verbose: false,
};

/**
 * Execute task with multi-turn refinement
 */
export async function executeWithMultiTurn(
  taskId: string,
  taskPrompt: string,
  config: Partial<MultiTurnConfig> = {}
): Promise<MultiTurnResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const turns: AgentTurn[] = [];
  let currentPrompt = taskPrompt;
  let memoryContextUsed = false;

  // Get memory context if enabled
  let memoryContext = '';
  if (cfg.useMemory) {
    try {
      const dynamicContext = await retrieveDynamicMemoryContext(taskPrompt, cfg.projectRoot);
      memoryContext = dynamicContext.formattedContext;
      memoryContextUsed = true;

      if (cfg.verbose) {
        console.log(`  [Memory] Retrieved ${dynamicContext.relevantMemories.length} memories`);
        console.log(`  [Memory] Category: ${dynamicContext.classification.category}`);
      }
    } catch (error) {
      if (cfg.verbose) {
        console.log(
          `  [Memory] Failed to retrieve context: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    const turnStartTime = Date.now();

    if (cfg.verbose) {
      console.log(`  [Turn ${turn}/${cfg.maxTurns}] Executing...`);
    }

    // Build prompt with memory and feedback
    const fullPrompt = buildPromptForTurn(turn, currentPrompt, memoryContext, turns);

    // Execute via droid CLI
    let response = '';
    try {
      response = await executeDroidPrompt(fullPrompt, cfg.model, cfg.apiKey, cfg.timeout);
    } catch (error) {
      const agentTurn: AgentTurn = {
        turnNumber: turn,
        prompt: fullPrompt,
        response: '',
        verification: {
          success: false,
          executionSucceeded: false,
          testsRun: 0,
          testsPassed: 0,
          errors: [`Execution failed: ${error instanceof Error ? error.message : String(error)}`],
          output: '',
          executionTimeMs: 0,
        },
        durationMs: Date.now() - turnStartTime,
      };
      turns.push(agentTurn);

      if (cfg.verbose) {
        console.log(
          `  [Turn ${turn}] Failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      continue;
    }

    // Verify the response
    const verification = await verifyBenchmarkTask(taskId, response);

    const agentTurn: AgentTurn = {
      turnNumber: turn,
      prompt: fullPrompt.slice(0, 500) + '...',
      response: response,
      verification,
      durationMs: Date.now() - turnStartTime,
    };

    if (cfg.verbose) {
      console.log(`  [Turn ${turn}] Verification: ${verification.success ? 'PASS' : 'FAIL'}`);
      if (!verification.success && verification.errors.length > 0) {
        console.log(`  [Turn ${turn}] Errors: ${verification.errors.slice(0, 2).join(', ')}`);
      }
    }

    // If successful, we're done
    if (verification.success) {
      turns.push(agentTurn);

      return {
        success: true,
        totalTurns: turn,
        turns,
        finalResponse: response,
        totalDurationMs: Date.now() - startTime,
        memoryContextUsed,
      };
    }

    // Generate feedback for next turn
    agentTurn.feedback = generateFeedback(verification);
    turns.push(agentTurn);

    // Update prompt with feedback for next turn
    currentPrompt = taskPrompt;
  }

  // All turns exhausted without success
  return {
    success: false,
    totalTurns: cfg.maxTurns,
    turns,
    finalResponse: turns[turns.length - 1]?.response || '',
    totalDurationMs: Date.now() - startTime,
    memoryContextUsed,
  };
}

/**
 * Build prompt for a specific turn
 */
function buildPromptForTurn(
  turn: number,
  taskPrompt: string,
  memoryContext: string,
  previousTurns: AgentTurn[]
): string {
  const sections: string[] = [];

  // Add memory context at the start (less important info first)
  if (memoryContext && turn === 1) {
    sections.push(memoryContext);
  }

  // Add task prompt
  sections.push(taskPrompt);

  // Add validate-the-plan instruction for first turn only
  if (turn === 1) {
    sections.push(`
## VALIDATE THE PLAN (MANDATORY -- runs after first pass output)

Before implementing, review your plan:
1. Review your plan for missing steps, incorrect assumptions, security issues
2. Check that every subtask has a clear, verifiable output
3. Ensure dependencies between steps are correctly ordered
4. Validate cost/duration estimates are reasonable
5. If plan is flawed, REWRITE it before executing any tool calls

This validation step is critical for improving outcomes by catching errors early.
`);
  }

  // Add feedback from previous turns
  if (turn > 1 && previousTurns.length > 0) {
    const lastTurn = previousTurns[previousTurns.length - 1];
    if (lastTurn.feedback) {
      sections.push(`
## Previous Attempt Feedback

Your previous response did not pass verification.

**Issues found:**
${lastTurn.feedback}

**Instructions:**
- Review the issues above carefully
- Fix the specific problems mentioned
- Ensure your response addresses ALL requirements
- Do not repeat the same mistakes

Please provide a corrected solution.
`);
    }
  }

  // Add final reminders at END (recency bias)
  if (turn > 1) {
    sections.push(`
## CRITICAL REMINDERS
- This is attempt ${turn} - previous attempts failed
- Focus on fixing the specific errors mentioned above
- Verify your solution handles edge cases
- Return ONLY the corrected code
`);
  }

  return sections.join('\n\n');
}

/**
 * Generate feedback from verification result
 */
function generateFeedback(verification: VerificationResult): string {
  const feedbackLines: string[] = [];

  if (!verification.executionSucceeded) {
    feedbackLines.push('- Code failed to compile or execute');
  }

  if (verification.testsRun > 0 && verification.testsPassed < verification.testsRun) {
    feedbackLines.push(
      `- ${verification.testsRun - verification.testsPassed}/${verification.testsRun} test cases failed`
    );
  }

  for (const error of verification.errors.slice(0, 5)) {
    feedbackLines.push(`- ${error}`);
  }

  if (feedbackLines.length === 0) {
    feedbackLines.push('- Response did not meet the expected requirements');
  }

  return feedbackLines.join('\n');
}

/**
 * Execute prompt via droid CLI
 */
async function executeDroidPrompt(
  prompt: string,
  model: string,
  apiKey: string,
  timeout: number
): Promise<string> {
  const tmpDir = '/tmp/uap-benchmark';
  const promptFile = join(tmpDir, `prompt-${Date.now()}.txt`);

  try {
    if (!existsSync(tmpDir)) {
      execSync(`mkdir -p ${tmpDir}`, { encoding: 'utf-8' });
    }

    writeFileSync(promptFile, prompt, 'utf-8');

    const result = execSync(
      `FACTORY_API_KEY="${apiKey}" droid exec --model "${model}" --auto medium -f "${promptFile}"`,
      {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FACTORY_API_KEY: apiKey },
      }
    );

    // Clean up
    try {
      execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
    } catch {
      // Ignore cleanup errors
    }

    return result.trim();
  } catch (error) {
    // Clean up on error
    try {
      execSync(`rm "${promptFile}"`, { encoding: 'utf-8' });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Execute a batch of tasks with multi-turn
 */
export async function executeBatchWithMultiTurn(
  tasks: Array<{ id: string; prompt: string }>,
  config: Partial<MultiTurnConfig> = {}
): Promise<Map<string, MultiTurnResult>> {
  const results = new Map<string, MultiTurnResult>();

  for (const task of tasks) {
    const result = await executeWithMultiTurn(task.id, task.prompt, config);
    results.set(task.id, result);

    // Small delay between tasks
    await new Promise((r) => setTimeout(r, 1000));
  }

  return results;
}
