/**
 * `uap deliver` — run the Fable-parity convergence loop.
 *
 * Drives an underlying model through execute → apply → verify → feedback
 * iterations against the project's real completion gates (build, typecheck,
 * test, lint) until all required gates pass or the turn budget is exhausted.
 */

import chalk from 'chalk';
import { join, resolve } from 'path';
import { ConvergenceLoop, composeIterationHooks } from '../delivery/convergence-loop.js';
import type { LoopExecutor, IterationRecord, DeliveryResult } from '../delivery/convergence-loop.js';
import { createModelJudge } from '../delivery/judge.js';
import { createModelCritic } from '../delivery/critic.js';
import { MAX_CANDIDATES } from '../delivery/explorer.js';
import type { StrategySeed } from '../delivery/explorer.js';
import { generateStrategySeeds, seedsFromIdeas } from '../delivery/ideation.js';
import { planAutoOptimization } from '../delivery/auto-optimizer.js';
import type { AutoPlan } from '../delivery/auto-optimizer.js';
import { createHaloDeliveryTracer } from '../delivery/halo-trace.js';
import { haloTracePath, isHaloTracingEnabled } from '../observability/halo-exporter.js';
import { createRunCoordinator } from '../delivery/run-coordinator.js';
import type { RunCoordinator } from '../delivery/run-coordinator.js';
import { readCuratedIdeas } from './ideate.js';
import { createEscalationController, defaultEscalationLadder } from '../delivery/escalation.js';
import {
  FilePracticeStore,
  defaultPracticePath,
  extractKeywords,
  retrievePracticesSemantic,
} from '../delivery/practice.js';
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
  candidates?: string;
  critic?: boolean;
  practices?: boolean;
  /** commander sets this false when --no-semantic is passed (default true) */
  semantic?: boolean;
  escalate?: boolean;
  escalateModel?: string;
  /** Divergent ideation: generate task-specific strategy seeds (uap ideate) */
  ideate?: boolean;
  /** Seed exploration from an open-collider project's curated ideas */
  ideateProject?: string;
  /** Emit HALO spans for this run (uap harness analyze) */
  halo?: boolean;
  /** Register/announce/heartbeat via the coordination layer (uap agent) */
  coordinate?: boolean;
  /** Queue a commit of applied files into the deploy batcher (uap deploy) */
  deploy?: boolean;
  /** Enable every convergence aid (exploration, critic, practices, escalation, ideation, HALO, coordination) */
  optimize?: boolean;
  /** commander sets this false when --no-auto is passed (default true):
   * dynamic optimization — classify task complexity, enable matching aids */
  auto?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const MAX_TURNS_LIMIT = 20;
const MAX_CANDIDATES_LIMIT = MAX_CANDIDATES;

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

/**
 * True when the user steered any aid explicitly — auto mode must then stand
 * down so flags remain the single source of truth for the run. Exported for
 * tests; commander leaves unset booleans undefined, so a present value
 * (true OR false) counts as explicit.
 */
export function hasExplicitAidFlags(options: DeliverOptions): boolean {
  return (
    options.candidates !== undefined ||
    options.critic !== undefined ||
    options.practices !== undefined ||
    options.escalate !== undefined ||
    options.escalateModel !== undefined ||
    options.ideate !== undefined ||
    options.ideateProject !== undefined ||
    options.halo !== undefined ||
    options.coordinate !== undefined ||
    options.optimize !== undefined
  );
}

/**
 * Apply an auto plan onto the run options (exactly like --optimize does),
 * filling only fields the user left unset. Exported for tests.
 */
export function applyAutoPlan(options: DeliverOptions, plan: AutoPlan): void {
  if (plan.candidates !== undefined && options.candidates === undefined) {
    options.candidates = String(plan.candidates);
  }
  if (plan.critic && options.critic === undefined) options.critic = true;
  if (plan.practices && options.practices === undefined) options.practices = true;
  if (plan.escalate && options.escalate === undefined) options.escalate = true;
  if (plan.ideate && options.ideate === undefined) options.ideate = true;
  if (plan.halo && options.halo === undefined) options.halo = true;
  if (plan.coordinate && options.coordinate === undefined) options.coordinate = true;
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
  // Dynamic optimization (default on): classify the instruction and enable
  // the convergence aids that match its complexity, so non-trivial requests
  // always get outcome-improving aids without flags. Stands down when the
  // user steered any aid explicitly, passed --no-auto, or set
  // UAP_DELIVER_AUTO=0. Deploy queueing is never auto-enabled.
  let autoPlan: AutoPlan | undefined;
  if (options.auto !== false && process.env.UAP_DELIVER_AUTO !== '0' && !hasExplicitAidFlags(options)) {
    autoPlan = planAutoOptimization(instruction);
    applyAutoPlan(options, autoPlan);
    if (!options.dryRun) {
      console.log(chalk.cyan(`⚙ auto-optimize: ${autoPlan.summary}`));
    }
  }

  // `--optimize` turns on every convergence aid at once. Deploy queueing is
  // deliberately excluded — committing applied files is a side effect the
  // user must opt into explicitly.
  if (options.optimize) {
    options.candidates = options.candidates ?? '4';
    options.critic = true;
    options.practices = true;
    options.escalate = true;
    options.ideate = true;
    options.halo = true;
    options.coordinate = true;
  }

  // `--halo` is a per-run switch over the global trace toggle the exporter
  // checks; setting the env var here keeps a single enablement path.
  if (options.halo) {
    process.env.UAP_HALO_TRACE = '1';
  }

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

  let candidates: number | undefined;
  if (options.candidates !== undefined) {
    candidates = Number(options.candidates);
    if (!Number.isInteger(candidates) || candidates < 2 || candidates > MAX_CANDIDATES_LIMIT) {
      fail(`--candidates must be an integer between 2 and ${MAX_CANDIDATES_LIMIT}, got '${options.candidates}'`);
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
      candidatesPerTurn: candidates ?? 1,
      critic: Boolean(options.critic),
      practices: Boolean(options.practices),
      escalate: Boolean(options.escalate),
      escalateModel: options.escalate ? (options.escalateModel ?? process.env.UAP_ESCALATE_MODEL ?? null) : null,
      auto: autoPlan ? autoPlan.summary : null,
      ideate: Boolean(options.ideate || options.ideateProject),
      ideateProject: options.ideateProject ?? null,
      halo: Boolean(options.halo),
      coordinate: Boolean(options.coordinate),
      deploy: Boolean(options.deploy),
      gates: rungs.map((r) => ({ id: r.id, name: r.name, required: r.required })),
    };
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(chalk.bold('Delivery plan (dry run):'));
      console.log(
        `  Auto-optimize: ${summary.auto ?? 'off (explicit flags, --no-auto, or UAP_DELIVER_AUTO=0)'}`
      );
      console.log(`  Project: ${projectRoot}`);
      console.log(`  Model preset: ${model.id}`);
      console.log(`  Max turns: ${summary.maxTurns}`);
      console.log(`  Candidates/turn: ${summary.candidatesPerTurn}${candidates ? '' : ' (single-shot)'}`);
      console.log(`  Critic: ${summary.critic ? 'on' : 'off'}`);
      console.log(
        `  Practices: ${summary.practices ? `on (${options.semantic === false ? 'keyword' : 'semantic'} recall)` : 'off'}`
      );
      console.log(`  Escalation: ${summary.escalate ? `on${summary.escalateModel ? ` (→ ${summary.escalateModel})` : ''}` : 'off'}`);
      console.log(
        `  Ideation: ${summary.ideate ? `on${summary.ideateProject ? ` (project: ${summary.ideateProject})` : ' (generated seeds)'}` : 'off'}`
      );
      console.log(`  HALO tracing: ${summary.halo ? 'on' : 'off'}`);
      console.log(`  Coordination: ${summary.coordinate ? 'on' : 'off'}`);
      console.log(`  Deploy queue on success: ${summary.deploy ? 'on' : 'off'}`);
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
  const executor: LoopExecutor = async (prompt) => {
    const result = await client.complete(model, prompt, { temperature });
    return result.content;
  };

  // Phase 5: escalation ladder. Cheap strategies first (widen exploration →
  // enable critic) then, if a stronger model is configured, switch to it.
  const escalateModelId = options.escalateModel ?? process.env.UAP_ESCALATE_MODEL;
  let escalateExecutor: LoopExecutor | undefined;
  let escalateModelName: string | undefined;
  if (options.escalate && escalateModelId) {
    const strong = resolveModel(escalateModelId, undefined);
    escalateModelName = strong.name;
    escalateExecutor = async (prompt) => (await client.complete(strong, prompt, { temperature })).content;
  } else if (options.escalate) {
    console.log(
      chalk.dim('  escalation: no stronger model configured ($UAP_ESCALATE_MODEL) — cheap tiers only')
    );
  }

  const escalation = options.escalate
    ? createEscalationController({
        tiers: defaultEscalationLadder({
          candidates,
          maxTurns: maxTurns ?? 5,
          escalateExecutor,
          escalateModelName,
        }),
        onEscalate: (tier, turn) => console.log(chalk.magenta(`  ↑ turn ${turn}: ${tier.label}`)),
      })
    : undefined;

  // Phase 4: learned best-practice cards for similar tasks. Retrieval is
  // semantic (embeddings) by default — better recall than keyword overlap —
  // and falls back to keyword matching automatically when no embedding
  // provider is reachable. `--no-semantic` forces the keyword path.
  const practiceStore = options.practices ? new FilePracticeStore(defaultPracticePath(projectRoot)) : undefined;
  const useSemantic = options.semantic !== false;
  const practiceProvider = practiceStore
    ? async (task: string): Promise<string[]> => {
        if (useSemantic) {
          const { getEmbeddingService } = await import('../memory/embeddings.js');
          const svc = getEmbeddingService();
          const cards = await retrievePracticesSemantic(practiceStore, task, {
            embed: (t) => svc.embed(t),
            cosineSimilarity: (a, b) => svc.cosineSimilarity(a, b),
          });
          return cards.map((c) => c.guidance);
        }
        return practiceStore.retrieve(task).map((c) => c.guidance);
      }
    : undefined;

  const printProgress = (record: IterationRecord): void => {
    const pct = Math.round(record.score * 100);
    const status = record.executorError
      ? chalk.red('model error')
      : record.applyError && record.filesApplied.length === 0
        ? chalk.yellow('no files applied')
        : record.passed
          ? chalk.green('PASS')
          : chalk.yellow(`${pct}% of gates`);
    const strategy = record.strategy ? chalk.dim(` [${record.strategy}]`) : '';
    console.log(`  Turn ${record.turn}: ${status}${strategy} (${Math.round(record.durationMs / 1000)}s)`);
    if (record.candidates) {
      const summary = record.candidates
        .map((c) => `${c.id}:${c.error ? 'err' : `${Math.round(c.score * 100)}%`}`)
        .join(' ');
      console.log(chalk.dim(`    candidates: ${summary}`));
    }
  };

  // Divergent ideation (uap ideate): replace the static strategy seeds with
  // task-specific diverse seeds — from a curated open-collider project when
  // one is given, otherwise generated by a bisociation-style model call.
  let seeds: StrategySeed[] | undefined;
  if (options.ideateProject) {
    // Plain directory-name slugs only — the value is joined into a path.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.ideateProject) || options.ideateProject.includes('..')) {
      fail(`--ideate-project must be a plain project name, got '${options.ideateProject}'`);
    }
    const ideas = readCuratedIdeas(join(projectRoot, 'projects', options.ideateProject));
    const fromIdeas = seedsFromIdeas(ideas, candidates ? { count: candidates } : {});
    if (fromIdeas.length > 0) {
      seeds = fromIdeas;
      console.log(
        chalk.cyan(`💡 ${fromIdeas.length} strategy seeds from curated ideas (${options.ideateProject})`)
      );
    } else {
      console.log(
        chalk.yellow(
          `💡 Fewer than 2 usable curated ideas under projects/${options.ideateProject} — generating seeds instead`
        )
      );
    }
  }
  if (!seeds && (options.ideate || options.ideateProject)) {
    console.log(chalk.cyan('💡 Generating divergent strategy seeds…'));
    seeds = await generateStrategySeeds(
      instruction,
      executor,
      candidates ? { count: candidates } : {}
    );
    console.log(chalk.cyan(`💡 Seeds: ${seeds.map((s) => s.id).join(', ')}`));
  }
  // Seeds act through the explorer — turn best-of-N on when ideation supplied
  // them and the user did not size exploration explicitly.
  if (seeds && !candidates) {
    candidates = Math.min(seeds.length, 4);
  }

  // Coordination layer (uap agent): make this run visible to other agents,
  // detect overlapping work, and heartbeat every turn. Also required for
  // deploy queueing, which attributes the queued action to an agent id.
  let coordinator: RunCoordinator | undefined;
  if (options.coordinate || options.deploy) {
    coordinator = await createRunCoordinator({
      instruction,
      projectRoot,
      modelId: model.id,
      estimatedMinutes: (maxTurns ?? 5) * 3,
    });
    if (coordinator.agentId === null) {
      // Coordination was requested (explicitly or via auto mode) — degrading
      // to a no-op must be loud, or the user will believe the run was
      // registered / the deploy was queued when it wasn't.
      console.log(
        chalk.yellow(
          '⚠ coordination layer unavailable — run not registered' +
            (options.deploy ? '; deploy queueing disabled' : '')
        )
      );
    }
    for (const warning of coordinator.overlapWarnings) {
      console.log(chalk.yellow(`⚠ overlap: ${warning}`));
    }
  }

  // HALO tracing (uap harness): spans per run/turn for systemic analysis.
  const haloTracer = createHaloDeliveryTracer({ instruction, modelId: model.id, projectRoot });

  const modeNotes = [
    candidates ? `${candidates} candidates/turn` : null,
    seeds ? 'ideation seeds' : null,
    options.critic ? 'critic on' : null,
    options.practices ? 'practices on' : null,
    options.escalate ? 'escalation on' : null,
    options.halo ? 'halo on' : null,
    coordinator?.agentId ? 'coordinated' : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    chalk.bold(
      `Delivering via ${model.name} (profile: ${profile.name}), max ${maxTurns ?? 5} turns${modeNotes ? ` (${modeNotes})` : ''}`
    )
  );

  const loop = new ConvergenceLoop(
    {
      projectRoot,
      maxTurns,
      rungs,
      explorer: candidates ? { candidates, seeds, judge: createModelJudge(executor) } : undefined,
      critic: options.critic ? createModelCritic(executor) : undefined,
      criticFactory: (ex) => createModelCritic(ex),
      practiceProvider,
      onIteration: composeIterationHooks(
        (record) => printProgress(record),
        (record) => haloTracer.onIteration(record),
        coordinator ? (record) => coordinator.onIteration(record) : undefined,
        escalation ? (record) => escalation.onIteration(record) : undefined
      ),
    },
    executor
  );

  let result: DeliveryResult;
  try {
    result = await loop.deliver(instruction);
  } catch (err) {
    // Deregister the run's agent so a config-stage throw (e.g. invalid
    // maxTurns) doesn't leave a phantom active agent in the registry, and
    // close the run-level span so already-emitted turn spans aren't orphaned.
    const aborted: DeliveryResult = {
      success: false,
      alreadyDelivered: false,
      turns: 0,
      bestScore: 0,
      bestTurn: 0,
      history: [],
      finalFeedback: '',
      finalOutput: '',
      totalDurationMs: 0,
    };
    haloTracer.finish(aborted);
    if (coordinator) {
      await coordinator.finish(aborted);
    }
    throw err;
  }

  haloTracer.finish(result);

  // Deploy batching (uap deploy): queue a commit of the applied files so the
  // batcher can squash/execute it on its window. Queued before finish() so
  // the action is attributed to a still-active agent. Explicit opt-in only.
  let deployActionId: number | null = null;
  if (options.deploy && result.success && coordinator) {
    deployActionId = await coordinator.queueDeploy(
      result,
      `feat(delivery): ${instruction.slice(0, 72)}`
    );
    if (deployActionId === null && !result.alreadyDelivered) {
      console.log(chalk.yellow('⚠ --deploy requested but no commit was queued (coordination unavailable or no files applied)'));
    }
  }

  if (coordinator) {
    await coordinator.finish(result);
  }

  // Phase 4: reinforce practices on a successful, non-trivial delivery.
  // Guidance is regenerated inside the store from strategy+turns (provenance-
  // safe), so only harness-owned facts are persisted — never model output.
  if (practiceStore && result.success && !result.alreadyDelivered) {
    const winningStrategy = result.history.find((h) => h.passed)?.strategy ?? 'direct';
    practiceStore.record({
      strategy: winningStrategy,
      keywords: extractKeywords(instruction),
      turns: result.turns,
    });
  }

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
    console.log(
      JSON.stringify(
        {
          ...rest,
          finalOutput: finalOutput.slice(0, 4000),
          ...(deployActionId !== null ? { deployActionId } : {}),
          ...(isHaloTracingEnabled() ? { haloTracePath: haloTracePath() } : {}),
        },
        null,
        2
      )
    );
  } else if (result.success) {
    console.log(chalk.green(`✓ Delivered in ${result.turns} turn(s) — all required gates pass.`));
    if (deployActionId !== null) {
      console.log(
        chalk.cyan(`  Deploy queued (action #${deployActionId}) — run 'uap deploy flush' to execute.`)
      );
    }
    if (isHaloTracingEnabled()) {
      console.log(chalk.dim(`  HALO trace: ${haloTracePath()} — analyze with 'uap harness analyze'`));
    }
  } else {
    console.log(
      chalk.red(
        `✗ Not delivered after ${result.turns} turn(s). Best: ${Math.round(result.bestScore * 100)}% of gates (turn ${result.bestTurn}).`
      )
    );
    if (result.finalFeedback) {
      console.log(chalk.dim(stripControl(result.finalFeedback)));
    }
    if (isHaloTracingEnabled()) {
      console.log(
        chalk.dim(`  HALO trace: ${haloTracePath()} — analyze the failure with 'uap harness analyze'`)
      );
    }
  }

  process.exitCode = result.success ? 0 : 1;
}
