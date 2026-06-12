/**
 * `uap deliver` — run the Fable-parity convergence loop.
 *
 * Drives an underlying model through execute → apply → verify → feedback
 * iterations against the project's real completion gates (build, typecheck,
 * test, lint) until all required gates pass or the turn budget is exhausted.
 */

import chalk from 'chalk';
import { resolve } from 'path';
import { ConvergenceLoop } from '../delivery/convergence-loop.js';
import { detectRungs } from '../delivery/verifier-ladder.js';
import { OpenAICompatClient } from '../models/openai-compat-client.js';
import { ModelPresets } from '../models/types.js';
import type { ModelConfig } from '../models/types.js';
import { detectExecutionProfile } from '../models/execution-profiles.js';

export interface DeliverOptions {
  maxTurns?: string;
  model?: string;
  projectRoot?: string;
  endpoint?: string;
  temperature?: string;
  gates?: string;
  dryRun?: boolean;
  json?: boolean;
}

const MAX_TURNS_LIMIT = 20;

/** Strip ANSI/C0 control sequences before echoing subprocess output. */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exitCode = 2;
  throw new ExitError();
}

class ExitError extends Error {}

function resolveModel(presetId: string, endpointOverride?: string): ModelConfig {
  const preset = ModelPresets[presetId];
  if (!preset) {
    const available = Object.keys(ModelPresets).join(', ');
    fail(`Unknown model preset '${presetId}'. Available: ${available}`);
  }
  return endpointOverride ? { ...preset, endpoint: endpointOverride } : preset;
}

export async function deliverCommand(instruction: string, options: DeliverOptions): Promise<void> {
  try {
    await runDeliver(instruction, options);
  } catch (err) {
    if (err instanceof ExitError) return;
    throw err;
  }
}

async function runDeliver(instruction: string, options: DeliverOptions): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const presetId = options.model ?? process.env.UAP_DELIVER_MODEL ?? 'qwen35-a3b';

  let maxTurns: number | undefined;
  if (options.maxTurns !== undefined) {
    maxTurns = Number(options.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS_LIMIT) {
      fail(`--max-turns must be an integer between 1 and ${MAX_TURNS_LIMIT}, got '${options.maxTurns}'`);
    }
  }

  let temperature: number | undefined;
  if (options.temperature !== undefined) {
    temperature = Number(options.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      fail(`--temperature must be a number between 0 and 2, got '${options.temperature}'`);
    }
  }

  // Validate the preset before any branch, including --dry-run
  const model = resolveModel(presetId, options.endpoint);

  // Detect gates, optionally filtered to a subset
  let rungs = detectRungs(projectRoot);
  if (options.gates) {
    const wanted = new Set(options.gates.split(',').map((g) => g.trim()));
    const unknown = [...wanted].filter((id) => !rungs.some((r) => r.id === id));
    if (unknown.length > 0) {
      fail(`Unknown gate id(s): ${unknown.join(', ')}. Detected: ${rungs.map((r) => r.id).join(', ')}`);
    }
    rungs = rungs.filter((r) => wanted.has(r.id));
  }

  if (rungs.length === 0) {
    fail(`No verifiable gates detected in ${projectRoot} (need package.json scripts).`);
  }

  if (options.dryRun) {
    const summary = {
      projectRoot,
      model: model.id,
      maxTurns: maxTurns ?? 5,
      gates: rungs.map((r) => ({ id: r.id, name: r.name, required: r.required })),
    };
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(chalk.bold('Delivery plan (dry run):'));
      console.log(`  Project: ${projectRoot}`);
      console.log(`  Model preset: ${model.id}`);
      console.log(`  Max turns: ${summary.maxTurns}`);
      console.log('  Gates:');
      for (const r of rungs) {
        console.log(`    - ${r.name}${r.required ? '' : chalk.dim(' (optional)')}`);
      }
    }
    return;
  }

  // Per-model-size execution profile supplies sampling defaults proven for
  // that model family (e.g. small MoE models converge better at temp 0.15).
  const profile = detectExecutionProfile(model.apiModel);
  if (temperature === undefined) {
    const profileTemp = profile.config.temperature;
    temperature = typeof profileTemp === 'number' ? profileTemp : undefined;
  }

  const client = new OpenAICompatClient();
  const executor = async (prompt: string): Promise<string> => {
    const result = await client.complete(model, prompt, { temperature });
    return result.content;
  };

  console.log(chalk.bold(`Delivering via ${model.name} (profile: ${profile.name}), max ${maxTurns ?? 5} turns`));

  const loop = new ConvergenceLoop(
    {
      projectRoot,
      maxTurns,
      rungs,
      onIteration: (record) => {
        const pct = Math.round(record.score * 100);
        const status = record.executorError
          ? chalk.red('model error')
          : record.applyError && record.filesApplied.length === 0
            ? chalk.yellow('no files applied')
            : record.passed
              ? chalk.green('PASS')
              : chalk.yellow(`${pct}% of gates`);
        console.log(`  Turn ${record.turn}: ${status} (${Math.round(record.durationMs / 1000)}s)`);
      },
    },
    executor
  );

  const result = await loop.deliver(instruction);

  if (result.alreadyDelivered) {
    console.log(chalk.yellow('All gates already pass — nothing to converge on. No model calls made.'));
    process.exitCode = 0;
    return;
  }

  // Feed the adaptive routing/memory systems — fail-soft, never block
  // delivery. agentOutput is deliberately omitted: model output is untrusted
  // and must not be persisted as long-term "learnings" (stored prompt
  // injection vector).
  try {
    const { recordTaskFeedback } = await import('../memory/dynamic-retrieval.js');
    recordTaskFeedback({
      instruction,
      success: result.success,
      durationMs: result.totalDurationMs,
      modelId: model.id,
      projectRoot,
    });
  } catch {
    // Memory recording is best-effort
  }

  if (options.json) {
    const { finalOutput, ...rest } = result;
    console.log(JSON.stringify({ ...rest, finalOutput: finalOutput.slice(0, 4000) }, null, 2));
  } else if (result.success) {
    console.log(chalk.green(`✓ Delivered in ${result.turns} turn(s) — all required gates pass.`));
  } else {
    console.log(
      chalk.red(
        `✗ Not delivered after ${result.turns} turn(s). Best: ${Math.round(result.bestScore * 100)}% of gates (turn ${result.bestTurn}).`
      )
    );
    if (result.finalFeedback) {
      console.log(chalk.dim(stripControl(result.finalFeedback)));
    }
  }

  process.exitCode = result.success ? 0 : 1;
}
