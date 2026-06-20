/**
 * `uap deliver` — run the Fable-parity convergence loop.
 *
 * Drives an underlying model through execute → apply → verify → feedback
 * iterations against the project's real completion gates (build, typecheck,
 * test, lint) until all required gates pass or the turn budget is exhausted.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ConvergenceLoop, composeIterationHooks } from '../delivery/convergence-loop.js';
import type {
  LoopExecutor,
  IterationRecord,
  DeliveryResult,
  ConvergenceConfig,
} from '../delivery/convergence-loop.js';
import { createModelJudge } from '../delivery/judge.js';
import { createModelCritic } from '../delivery/critic.js';
import { MAX_CANDIDATES } from '../delivery/explorer.js';
import type { StrategySeed } from '../delivery/explorer.js';
import { generateStrategySeeds, seedsFromIdeas } from '../delivery/ideation.js';
import { planAutoOptimization } from '../delivery/auto-optimizer.js';
import { authorAcceptanceGate } from '../delivery/self-gate.js';
import { runAcceptanceGate, formatAcceptanceReport } from '../delivery/acceptance-judge.js';
import type { AcceptanceGate } from '../delivery/convergence-loop.js';
import { createAgenticExecutor, noopApplier, selectExecutorMode } from '../delivery/agentic-executor.js';
import type { ExecutorMode } from '../delivery/agentic-executor.js';
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
import { detectRungs, runLadder, runTieredLadder, tierOf, TIER_ORDER } from '../delivery/verifier-ladder.js';
import type { GateTier, LadderRunFn } from '../delivery/verifier-ladder.js';
import { runDeployDevLadder } from '../delivery/deploy-dev-gate.js';
import { commitPushAndWatch } from '../delivery/ci-watcher.js';
import type { DeployEnvironment } from '../delivery/ci-watcher.js';
import { snapshotTree, restoreTree, disposeSnapshot } from '../delivery/snapshot.js';
import { snapshotProtection } from '../delivery/spec-imports.js';
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
  /** `--no-self-gate` sets this false; default (undefined) keeps the fallback on. */
  selfGate?: boolean;
  /** `--force-self-gate`: author an acceptance gate even when project gates exist. */
  forceSelfGate?: boolean;
  /** `--acceptance`: after objective gates pass, judge spec behavioral completeness
   *  via the LLM and feed unmet criteria back so the loop completes the spec. */
  acceptance?: boolean;
  /** `--executor <blind|agentic|auto>`: per-turn executor strategy (default auto). */
  executor?: string;
  /** `--keep-best`: revert the project if deliver ends with a worse gate score than baseline. */
  keepBest?: boolean;
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
  /** commander sets false on --no-integration: run the integration tier locally (default: on when detected). */
  integration?: boolean;
  /** commander sets false on --no-deploy-dev: run a local dev deploy+smoke tier (default off; opt-in). */
  deployDev?: boolean;
  /** After local-green, commit/push the worktree branch and watch CI; re-converge on failure. */
  watchCi?: boolean;
  /** Imply --watch-ci and require CI + staging/prod deploy jobs green before exiting 0. */
  untilDeployed?: boolean;
  /** Explicit comma list of tiers to run (e.g. fast,integration,deploy-dev), overriding auto-detection. */
  tiers?: string;
  /** Max CI re-converge passes (default 2). */
  ciPasses?: string;
  /** CI watch budget in minutes (default 20). */
  ciTimeout?: string;
  /** commander sets this false when --no-auto is passed (default true):
   * dynamic optimization — classify task complexity, enable matching aids */
  auto?: boolean;
  /** commander sets this false when --no-protect-tests is passed (default
   * true): refuse model writes to pre-existing test/spec files */
  protectTests?: boolean;
  /** Path polled each turn for operator guidance — steer a running mission
   * without stopping it by writing to this file. */
  guidanceFile?: string;
  /** Loop until every gate passes (default ON; commander sets this false when
   * --no-until-delivered is passed; UAP_DELIVER_UNTIL_DELIVERED=0 also disables). */
  untilDelivered?: boolean;
  /** Hard turn ceiling for until-delivered (default 30). */
  ceiling?: string;
  dryRun?: boolean;
  json?: boolean;
}

const MAX_TURNS_LIMIT = 20;
const CEILING_LIMIT = 50;
const DEFAULT_CLI_CEILING = 30;
const MAX_CANDIDATES_LIMIT = MAX_CANDIDATES;

/** Strip ANSI/C0 control sequences before echoing subprocess output. */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** Resolve the current git branch (read-only); null when not in a repo. */
function currentBranch(projectRoot: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Explicit list of changed paths from `git status --porcelain` (read-only). Used
 * to scope the watch-ci commit when the loop reports no applied files (the
 * agentic executor mutates the repo directly and returns an empty file set), so
 * the watcher stages a known list instead of a blanket `git add -A`.
 */
function changedFiles(projectRoot: string): string[] {
  try {
    const r = spawnSync('git', ['status', '--porcelain', '-z'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split('\0')
      .filter(Boolean)
      // porcelain lines are "XY <path>"; drop the 3-char status prefix.
      .map((line) => line.slice(3))
      .filter(Boolean);
  } catch {
    return [];
  }
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
  // Local tiers are safe to auto-enable. The watch-ci push boundary stays
  // OPT-IN even when the plan recommends it (plan.watchCi) — committing and
  // pushing is a side effect the user must request explicitly, mirroring the
  // deploy-queue rule below.
  if (plan.integration && options.integration === undefined) options.integration = true;
  if (plan.deployDev && options.deployDev === undefined) options.deployDev = true;
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
    // Local tiers on; the watch-ci push boundary stays opt-in (like deploy).
    if (options.integration === undefined) options.integration = true;
    if (options.deployDev === undefined) options.deployDev = true;
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

  // Loop-until-delivered is ON BY DEFAULT for every coding agent using UAP, so
  // deliveries run to verified completion. Opt out per-run with
  // `--no-until-delivered` (commander sets options.untilDelivered === false) or
  // globally with UAP_DELIVER_UNTIL_DELIVERED=0. Bounded by the ceiling + the
  // loop's stagnation guard, so default-on can never become an unbounded loop.
  const untilDelivered =
    options.untilDelivered !== false && process.env.UAP_DELIVER_UNTIL_DELIVERED !== '0';

  let maxTurnsCeiling: number | undefined;
  if (options.ceiling !== undefined) {
    maxTurnsCeiling = Number(options.ceiling);
    if (!Number.isInteger(maxTurnsCeiling) || maxTurnsCeiling < 1 || maxTurnsCeiling > CEILING_LIMIT) {
      fail(`--ceiling must be an integer between 1 and ${CEILING_LIMIT}, got '${options.ceiling}'`);
    }
  }
  if (untilDelivered && maxTurnsCeiling === undefined) {
    maxTurnsCeiling = DEFAULT_CLI_CEILING;
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

  // Resolve the highest LOCAL tier to run (cheap-first promotion). The
  // ci/staging/prod tiers are never run locally — they are verified after
  // commit via the CI watcher — so the local ceiling is deploy-dev.
  const LOCAL_TIER_CEILING = TIER_ORDER.indexOf('deploy-dev');
  let maxTier: GateTier = 'fast';
  let allowedTiers: Set<GateTier> | null = null;
  if (options.tiers) {
    const parsed = options.tiers.split(',').map((t) => t.trim()).filter(Boolean) as GateTier[];
    const unknown = parsed.filter(
      (t) => !TIER_ORDER.includes(t) || TIER_ORDER.indexOf(t) > LOCAL_TIER_CEILING
    );
    if (unknown.length > 0) {
      fail(`Unknown/non-local tier(s): ${unknown.join(', ')}. Local tiers: fast, integration, deploy-dev`);
    }
    allowedTiers = new Set(parsed);
    maxTier = parsed.reduce<GateTier>(
      (hi, t) => (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(hi) ? t : hi),
      'fast'
    );
  } else if (options.deployDev) {
    maxTier = 'deploy-dev';
  } else if (options.integration !== false && rungs.some((r) => tierOf(r) === 'integration')) {
    // Integration is on-by-default when a suite is detected (like lint).
    maxTier = 'integration';
  }

  // Drop rungs outside the resolved local scope so feedback never lists tiers
  // that were intentionally not run.
  rungs = rungs.filter((r) => {
    const t = tierOf(r);
    if (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(maxTier)) return false;
    if (allowedTiers) return allowedTiers.has(t);
    if (t === 'integration' && options.integration === false) return false;
    return true;
  });

  // CI watch boundary: opt-in via --watch-ci, or implied by --until-deployed.
  const watchCi = Boolean(options.watchCi || options.untilDeployed);
  const watchEnvironments: DeployEnvironment[] | undefined = options.untilDeployed
    ? ['staging', 'prod']
    : undefined;
  let ciPasses = 2;
  if (options.ciPasses !== undefined) {
    ciPasses = Number(options.ciPasses);
    if (!Number.isInteger(ciPasses) || ciPasses < 1 || ciPasses > 10) {
      fail(`--ci-passes must be an integer between 1 and 10, got '${options.ciPasses}'`);
    }
  }
  let ciTimeoutMs = 20 * 60_000;
  if (options.ciTimeout !== undefined) {
    const mins = Number(options.ciTimeout);
    if (!Number.isInteger(mins) || mins < 1 || mins > 120) {
      fail(`--ci-timeout must be an integer (minutes) between 1 and 120, got '${options.ciTimeout}'`);
    }
    ciTimeoutMs = mins * 60_000;
  }

  // When a project exposes no gates (or --force-self-gate), fall back to a
  // self-authored acceptance gate so deliver still has a real convergence
  // target instead of vacuously "succeeding" in one turn. The gate is authored
  // after the model client exists (below); here we only decide intent.
  const selfGateAllowed = options.selfGate !== false && process.env.UAP_DELIVER_SELF_GATE !== '0';
  const needsSelfGate = selfGateAllowed && (rungs.length === 0 || options.forceSelfGate === true);
  if (rungs.length === 0 && !needsSelfGate) {
    fail(
      `No verifiable gates detected in ${projectRoot} (need package.json scripts, or drop --no-self-gate to author one).`
    );
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
      protectTests: options.protectTests !== false,
      protectedTestFiles: options.protectTests !== false ? snapshotProtection(projectRoot).protectedFiles.size : 0,
      guidanceFile: options.guidanceFile ? resolve(options.guidanceFile) : null,
      untilDelivered,
      ceiling: untilDelivered ? (maxTurnsCeiling ?? DEFAULT_CLI_CEILING) : null,
      maxTier,
      tiers: [...new Set(rungs.map((r) => tierOf(r)))],
      watchCi,
      untilDeployed: Boolean(options.untilDeployed),
      watchEnvironments: watchEnvironments ?? null,
      ciPasses: watchCi ? ciPasses : null,
      ciTimeoutMinutes: watchCi ? ciTimeoutMs / 60_000 : null,
      branch: watchCi ? currentBranch(projectRoot) : null,
      gates: rungs.map((r) => ({ id: r.id, name: r.name, required: r.required, tier: tierOf(r) })),
      selfGate: needsSelfGate,
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
      console.log(
        `  Test protection: ${summary.protectTests ? `on (${summary.protectedTestFiles} pre-existing test/oracle file(s))` : 'off'}`
      );
      console.log(`  Guidance file: ${summary.guidanceFile ?? 'none (mission runs unattended)'}`);
      console.log(
        `  Until delivered: ${summary.untilDelivered ? `on (loop to all-gates-pass, ceiling ${summary.ceiling} turns)` : 'off'}`
      );
      console.log(`  Local tiers: ${summary.tiers.join(', ')} (max: ${summary.maxTier})`);
      console.log(
        `  Watch CI: ${
          summary.watchCi
            ? `on (branch ${summary.branch ?? '(unknown)'}, ${summary.ciPasses} pass(es), ${summary.ciTimeoutMinutes}m budget${summary.watchEnvironments ? `, require ${summary.watchEnvironments.join('/')} deploy` : ''})`
            : 'off'
        }`
      );
      if (needsSelfGate) {
        console.log(
          chalk.cyan('  Self-gate: will author .uap-deliver/verify.sh at run time (must fail on the unsolved repo)')
        );
      }
      console.log('  Gates:');
      for (const r of rungs) {
        console.log(
          `    - [${tierOf(r)}] ${r.name}${r.required ? '' : chalk.dim(' (optional)')}`
        );
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
  const blindExecutor: LoopExecutor = async (prompt) => {
    const result = await client.complete(model, prompt, { temperature });
    return result.content;
  };

  // Dynamic executor selection. The blind executor is one completion per turn
  // (cheap, but cannot inspect or run anything); the agentic executor runs a
  // tool-using loop (read/list/bash/write) and mutates the repo directly. 'auto'
  // picks agentic when there is repo context or gates to inspect — which is
  // where blind structurally fails. Gates may be authored below (self-gate), so
  // count that intent toward "has gates" for the decision.
  const executorMode = selectExecutorMode(
    (options.executor as ExecutorMode) ?? 'auto',
    projectRoot,
    rungs.length > 0 || needsSelfGate
  );
  const agenticEndpoint =
    model.endpoint ?? options.endpoint ?? process.env.UAP_INFERENCE_ENDPOINT ?? 'http://localhost:8080/v1';
  const agentic = executorMode === 'agentic';
  if (agentic) {
    console.log(chalk.cyan(`⚙ executor: agentic (tool-using loop)`));
  }
  const executor: LoopExecutor = agentic
    ? createAgenticExecutor(model, {
        projectRoot,
        endpoint: agenticEndpoint,
        temperature,
        // Block oracle tampering: protected test files are read-only to the agent.
        protectedFiles:
          options.protectTests !== false ? snapshotProtection(projectRoot).protectedFiles : new Set<string>(),
        // Block gate-config / IaC rigging in the agentic path too (it bypasses
        // the file-block applier where this protection otherwise lives).
        protectGateConfigs: options.protectTests !== false,
        onEvent: (e) =>
          console.log(
            chalk.dim(`    [agent r${e.round} ${e.kind}${e.tool ? `:${e.tool}` : ''}] ${e.detail ?? ''}`)
          ),
      })
    : blindExecutor;

  // Self-authored acceptance gate: give deliver a real convergence target when
  // the project exposes none. The gate must FAIL on the current unsolved repo
  // (enforced in authorAcceptanceGate) so turn 1 cannot trivially pass.
  if (needsSelfGate) {
    console.log(chalk.cyan('⚖ self-gate: authoring a task-specific acceptance check…'));
    // Author the gate with the blind executor — it is a single-shot script
    // write, not a task to solve agentically.
    const sg = await authorAcceptanceGate({ instruction, projectRoot, executor: blindExecutor });
    for (const note of sg.notes) console.log(chalk.dim(`    ${note}`));
    if (!sg.rung) {
      fail('Could not author an acceptance gate (model produced no runnable script).');
    }
    rungs.push(sg.rung);
    if (sg.vacuous) {
      console.log(
        chalk.yellow(
          '  ⚠ acceptance gate may be weak (could not force an initially-failing check); running multi-turn anyway.'
        )
      );
    } else {
      console.log(
        chalk.green('  ✓ acceptance gate authored — fails on the unsolved repo, a real convergence target.')
      );
    }
  }

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

  // Operator guidance channel: poll a file each turn so a running, unattended
  // mission can be steered without being stopped — the operator just writes
  // (or clears) the file. Capped and fail-soft.
  const guidanceFile = options.guidanceFile ? resolve(options.guidanceFile) : undefined;
  let lastGuidance: string | undefined;
  const guidanceProvider = guidanceFile
    ? (): string | undefined => {
        try {
          if (!existsSync(guidanceFile)) return undefined;
          const text = readFileSync(guidanceFile, 'utf-8').trim().slice(0, 2000);
          if (text && text !== lastGuidance) {
            lastGuidance = text;
            console.log(chalk.magenta(`  ⟲ guidance picked up from ${options.guidanceFile}`));
          }
          return text || undefined;
        } catch {
          return undefined;
        }
      }
    : undefined;

  // Cheap-first tiered ladder: run the fast tier first and only promote to
  // integration / deploy-dev once the prior tier is green. Injected as the
  // ladderRunner seam so the loop's integrity guard composes around the whole
  // tiered run. deploy-dev rungs use the bring-up→smoke→teardown lifecycle.
  const tieredRunner: LadderRunFn = (r, root, opts) =>
    runTieredLadder(r, root, {
      ...opts,
      maxTier,
      runner: runLadder,
      deployDevRunner: runDeployDevLadder,
    });
  // Behavioral-completeness feedback: once objective gates pass, the acceptance
  // judge checks the spec's requirements against the produced code and feeds
  // unmet criteria back so the loop iterates to COMPLETE the spec, not just to
  // stop crashing. Uses the blind (text) executor; fails open internally.
  const acceptanceGate: AcceptanceGate | undefined = options.acceptance
    ? async (root) => {
        const r = await runAcceptanceGate({ spec: instruction, projectRoot: root, executor: blindExecutor });
        return {
          passed: r.passed,
          score: r.score,
          feedback: r.passed ? '' : `ACCEPTANCE GAPS — implement these to complete the spec:\n${formatAcceptanceReport(r)}`,
        };
      }
    : undefined;

  const seams = {
    ladderRunner: tieredRunner,
    // The agentic executor mutates the repo directly, so nothing remains for
    // the file-block applier to materialize.
    ...(agentic ? { applier: noopApplier } : {}),
    ...(acceptanceGate ? { acceptanceGate } : {}),
  };

  const loopConfig: ConvergenceConfig = {
    projectRoot,
    maxTurns,
    rungs,
    // The agentic executor mutates the repo directly (no-op applier), so
    // gates must run every turn regardless of applier file count.
    alwaysVerify: agentic ? true : undefined,
    // Judge/critic evaluate text, so they always use the blind executor even
    // when the loop's executor is agentic.
    explorer: candidates ? { candidates, seeds, judge: createModelJudge(blindExecutor) } : undefined,
    critic: options.critic ? createModelCritic(blindExecutor) : undefined,
    // Critic evaluates text; keep it on a blind completion even if the loop
    // escalates the (agentic) executor.
    criticFactory: (ex) => createModelCritic(agentic ? blindExecutor : ex),
    practiceProvider,
    protectTests: options.protectTests,
    guidanceProvider,
    untilDelivered,
    maxTurnsCeiling,
    onIteration: composeIterationHooks(
      (record) => printProgress(record),
      (record) => haloTracer.onIteration(record),
      coordinator ? (record) => coordinator.onIteration(record) : undefined,
      escalation ? (record) => escalation.onIteration(record) : undefined
    ),
  };
  const loop = new ConvergenceLoop(loopConfig, executor, seams);

  // --keep-best (never regress): capture the starting required-gate score and a
  // project snapshot so we can roll back if deliver ends up WORSE than it
  // started. Only meaningful with real gates — a self-authored proxy gate is
  // not a trustworthy regression signal.
  // Regression scoring uses only the fast tier — a cheap, synchronous, always-
  // run signal. Integration/deploy-dev gates may not run at baseline (promotion
  // is cheap-first), so they are not a trustworthy regression comparison.
  const fastRungs = rungs.filter((r) => tierOf(r) === 'fast');
  const keepBest = Boolean(options.keepBest) && fastRungs.length > 0 && !needsSelfGate;
  let regressSnapshot: string | null = null;
  let baselineGateScore = 0;
  if (keepBest) {
    baselineGateScore = runLadder(fastRungs, projectRoot).score;
    regressSnapshot = snapshotTree(projectRoot);
    console.log(chalk.dim(`  no-regress: baseline gate score ${baselineGateScore.toFixed(2)} (snapshot taken)`));
  }

  // Mark this run (and the gate subprocesses it spawns) as deliver-driven so
  // the delivery-enforcement policy exempts the sanctioned path. Scoped to the
  // loop and RESTORED afterward so a programmatic/long-lived caller doesn't
  // leave the whole process permanently exempt.
  const priorDeliverActive = process.env.UAP_DELIVER_ACTIVE;
  process.env.UAP_DELIVER_ACTIVE = '1';

  let result: DeliveryResult;
  try {
    result = await loop.deliver(instruction);

    // CI watch boundary + re-converge: once local tiers are green, commit/push
    // the worktree branch and watch the CI run. On CI/deploy failure, feed the
    // sanitized failure back into a fresh convergence pass (baselineCheck off so
    // turn 1 always runs the model — local gates already pass). Bounded by
    // --ci-passes. Skipped when nothing changed (alreadyDelivered).
    if (watchCi && result.success && !result.alreadyDelivered) {
      const branch = currentBranch(projectRoot) ?? undefined;
      let pass = 0;
      for (;;) {
        // Prefer the loop's applied-file set; the agentic executor reports none
        // (it mutates the repo directly), so fall back to an explicit
        // git-status list rather than letting the watcher do `git add -A`.
        let files = [...new Set(result.history.flatMap((h) => h.filesApplied ?? []))];
        if (files.length === 0) files = changedFiles(projectRoot);
        console.log(
          chalk.cyan(`☁ watch-ci: committing & pushing ${branch ?? 'current branch'}, watching CI…`)
        );
        const watch = await commitPushAndWatch({
          projectRoot,
          branch,
          commitMessage: `feat(delivery): ${instruction.slice(0, 72)}`,
          files,
          timeoutMs: ciTimeoutMs,
          watchEnvironments,
          onProgress: (m) => console.log(chalk.dim(`    ${m}`)),
        });
        if (watch.runUrl) console.log(chalk.dim(`    run: ${watch.runUrl}`));

        if (watch.status === 'green') {
          console.log(
            chalk.green(
              `  ✓ CI green${watchEnvironments ? ` (${watchEnvironments.join('/')} deploy verified)` : ''}`
            )
          );
          break;
        }
        if (watch.status === 'skipped' || watch.status === 'no-run') {
          console.log(chalk.yellow(`  ⚠ watch-ci ${watch.status}: ${watch.feedback ?? ''}`));
          break;
        }

        // failed | timeout
        pass++;
        console.log(chalk.yellow(`  ✗ CI ${watch.status} (re-converge pass ${pass}/${ciPasses})`));
        if (pass >= ciPasses) {
          console.log(chalk.red(`  watch-ci: exhausted ${ciPasses} pass(es); CI still not green.`));
          result = { ...result, success: false, finalFeedback: watch.feedback ?? result.finalFeedback };
          break;
        }
        console.log(chalk.cyan('  ⟲ re-converging against CI feedback…'));
        const reconvergeLoop = new ConvergenceLoop(
          { ...loopConfig, baselineCheck: false },
          executor,
          seams
        );
        result = await reconvergeLoop.deliver(`${instruction}\n\n${watch.feedback ?? ''}`);
        if (!result.success) {
          console.log(chalk.red('  re-converge did not reach local-green; stopping watch-ci.'));
          break;
        }
      }
    }
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
  } finally {
    if (priorDeliverActive === undefined) delete process.env.UAP_DELIVER_ACTIVE;
    else process.env.UAP_DELIVER_ACTIVE = priorDeliverActive;
  }

  // --keep-best: if deliver left the project worse than it started (by real
  // gate score), roll back to the snapshot so the run is never a regression.
  if (keepBest && regressSnapshot) {
    const endScore = runLadder(fastRungs, projectRoot).score;
    if (endScore < baselineGateScore) {
      restoreTree(projectRoot, regressSnapshot);
      console.log(
        chalk.yellow(
          `  ↩ no-regress: reverted (end gate score ${endScore.toFixed(2)} < baseline ${baselineGateScore.toFixed(2)})`
        )
      );
    } else {
      console.log(
        chalk.dim(`  no-regress: kept (end gate score ${endScore.toFixed(2)} ≥ baseline ${baselineGateScore.toFixed(2)})`)
      );
    }
    disposeSnapshot(regressSnapshot);
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
