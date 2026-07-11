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
import { DEFAULT_STRATEGY_SEEDS } from '../delivery/explorer.js';
import { planAutoOptimization } from '../delivery/auto-optimizer.js';
import { RoutingPresets, resolvePresetModel } from '../models/types.js';
import type { TaskComplexity } from '../models/types.js';
import { measureQueryComplexity } from '../utils/query-complexity.js';
import { authorAcceptanceGate } from '../delivery/self-gate.js';
import { runAcceptanceGate, formatAcceptanceReport, createAcceptanceChurnBreaker, type AcceptanceResult } from '../delivery/acceptance-judge.js';
import { runExecutionGate } from '../delivery/execution-gate.js';
import { runVisualGate, visualRuntimeNote } from '../delivery/visual-gate.js';
import type { AcceptanceGate } from '../delivery/convergence-loop.js';

/**
 * Map an acceptance verdict to a loop gate result, honoring primary vs secondary
 * mode. PURE — unit-tested in isolation from the model call.
 *
 * - Genuine fully-met verdict → pass.
 * - PRIMARY (acceptance is the sole convergence target, no objective project
 *   gates): an inconclusive / no-evidence verdict is NOT "done" — fail so the
 *   loop keeps building (bounded by the ceiling). Prevents a vacuous turn-1
 *   "success" on an empty repo where the judge has nothing to evaluate.
 * - SECONDARY (real objective gates exist): fail OPEN on judge flakiness — a
 *   green objective delivery is never blocked by the judge's nondeterminism.
 */
/**
 * Decide how deliver establishes its convergence target when (or whether) the
 * project exposes objective gates. PURE — unit-tested. See call site for the
 * rationale on preferring the acceptance judge over the scripted self-gate.
 */
export function decideGateStrategy(opts: {
  hasAcceptance: boolean;
  noRealGates: boolean;
  forceSelfGate: boolean;
  selfGateAllowed: boolean;
}): { acceptancePrimary: boolean; needsSelfGate: boolean; noGatesError: boolean } {
  const acceptancePrimary = opts.hasAcceptance && opts.noRealGates && !opts.forceSelfGate;
  const needsSelfGate =
    opts.selfGateAllowed && !acceptancePrimary && (opts.noRealGates || opts.forceSelfGate);
  const noGatesError = opts.noRealGates && !needsSelfGate && !acceptancePrimary;
  return { acceptancePrimary, needsSelfGate, noGatesError };
}

/**
 * B2 — tiered acceptance. The per-turn LLM acceptance judge is skipped for a
 * `simple` task UNLESS it is the only verification (acceptancePrimary): the
 * objective gates / self-gate (a runnable script) already cover simple work,
 * so we avoid an LLM judge call every turn. Returns true to SKIP the judge.
 */
export function shouldSkipAcceptanceJudge(opts: {
  acceptanceEnabled: boolean;
  complexity?: string;
  acceptancePrimary: boolean;
}): boolean {
  return (
    opts.acceptanceEnabled &&
    opts.complexity === 'simple' &&
    !opts.acceptancePrimary
  );
}

/**
 * Generator≠Evaluator: resolve which model should AUTHOR + JUDGE the acceptance
 * gate. Returns the evaluator preset id when it must differ from the generator
 * (so the generator never grades its own work), or null to use the generator
 * (single-model, unchanged). Honors --evaluator-model then
 * UAP_DELIVER_EVALUATOR_MODEL.
 */
export function resolveEvaluatorPreset(opts: {
  evaluatorModel?: string;
  generatorPreset: string;
  envEvaluator?: string;
}): string | null {
  const wanted = opts.evaluatorModel ?? opts.envEvaluator;
  if (!wanted || wanted === opts.generatorPreset) return null;
  return wanted;
}

export function resolveAcceptanceVerdict(
  r: AcceptanceResult,
  acceptancePrimary: boolean
): { passed: boolean; feedback: string; score?: number } {
  if (r.passed && !r.parseError) return { passed: true, score: r.score, feedback: '' };
  const gaps = `ACCEPTANCE GAPS — implement these to complete the spec:\n${formatAcceptanceReport(r)}`;
  if (acceptancePrimary) {
    if (r.parseError) {
      // No-evidence / unparseable: not done, and NOT progress. Omit the score —
      // runAcceptanceGate reports score:1 on its fail-open paths, which would
      // otherwise saturate the loop's acceptance-progress (bestAcceptance) and
      // mask real per-criterion gains on later turns.
      return {
        passed: false,
        feedback: `Acceptance inconclusive (${r.parseError}). Keep implementing the spec — ensure the source files exist and are complete.`,
      };
    }
    return { passed: false, score: r.score, feedback: gaps };
  }
  return { passed: r.passed, score: r.score, feedback: r.passed ? '' : gaps };
}
import { createAgenticExecutor, noopApplier, selectExecutorMode } from '../delivery/agentic-executor.js';
import { clearStop, isStopRequested, loadRunState, newRunId, saveRunState } from '../delivery/run-state.js';
import type { DeliverRunState } from '../delivery/run-state.js';
import { parsePhaseArray, phaseInstruction, planDeliveryPhases, shouldDecompose } from '../delivery/decompose.js';
import { runEpics, type Epic, type EpicRunResult } from '../delivery/epic-controller.js';
import { initLedger, markItem } from '../delivery/completion-ledger.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';
import { resolveSessionTokenBudget, sessionWorkingBudget, discoverModelContextWindow, CONTEXT_BUDGET_MARKER } from '../delivery/context-budget.js';
import { orchestrate } from '../delivery/task-orchestrator.js';
import { extractContract } from '../delivery/contract-extractor.js';
import type { OrchestratorTask, TaskOutcome } from '../delivery/task-orchestrator.js';
import type { LifecycleHintProvider } from '../delivery/decompose.js';
import type { DeliveryPhase } from '../delivery/decompose.js';
import { completeDeliveryTask, openDeliveryTask, recordDeliveryOutcome, recordOrchestratorTaskOutcome, reopenDeliveryTask } from '../delivery/task-sync.js';
import { autoMineHaloTraces, summarizeWeaknesses, weaknessGuidance, loadPersistedWeaknesses } from '../delivery/auto-mine.js';
import { createGitWorktreeProvider } from '../delivery/candidate-workspace.js';
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
import { detectRungs, runLadder, runTieredLadder, tierOf, TIER_ORDER, demoteBaselineFailures } from '../delivery/verifier-ladder.js';
import type { GateTier, LadderRunFn, GateRung } from '../delivery/verifier-ladder.js';
import { runDeployDevLadder } from '../delivery/deploy-dev-gate.js';
import { commitPushAndWatch } from '../delivery/ci-watcher.js';
import type { DeployEnvironment } from '../delivery/ci-watcher.js';
import { snapshotTree, restoreTree, disposeSnapshot } from '../delivery/snapshot.js';
import { snapshotProtection } from '../delivery/spec-imports.js';
import { listGateConfigFiles } from '../delivery/applier.js';
import { OpenAICompatClient } from '../models/openai-compat-client.js';
import { ModelPresets } from '../models/types.js';
import type { ModelConfig } from '../models/types.js';
import { detectExecutionProfile } from '../models/execution-profiles.js';

export interface DeliverOptions {
  maxTurns?: string;
  /** True when --max-turns was passed on the command line (vs the commander
   * default) — set by the CLI action via getOptionValueSource. An explicit
   * value is a hard cap on until-delivered/escalation extensions. */
  maxTurnsExplicit?: boolean;
  model?: string;
  /** `--routing <preset>`: complexity-tier routing. Classify the task and pick
   * the executor model for its complexity from the named routing preset's tier
   * map (trivial→cheapest/fastest, hard→escalate). Ignored when --model is set
   * (explicit user choice wins) or the preset id is unknown. Env:
   * UAP_DELIVER_ROUTING. */
  routing?: string;
  projectRoot?: string;
  endpoint?: string;
  /** `--evaluator-model <preset>`: a DIFFERENT model to AUTHOR + JUDGE the
   *  acceptance gate than the one implementing, so the generator never grades
   *  its own work (loop-engineering "separate generator from evaluator" rule).
   *  Default (unset) = the generator model — single-model behavior unchanged. */
  evaluatorModel?: string;
  /** Endpoint override for the evaluator model. */
  evaluatorEndpoint?: string;
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
  /** `--allow-bash`: permit the agentic executor's run_bash tool when NOT under
   * `uap sandbox`. Off by default — an unsandboxed shell isn't contained to the
   * workdir (security audit X3). */
  allowBash?: boolean;
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
  /** Resume an interrupted durable run: a run id or 'latest'. */
  resume?: string;
  /** Lazy-UAP (default ON): one bare single turn first; the convergence aids
   * engage only if it fails the gates. commander sets false on --no-lazy;
   * UAP_DELIVER_LAZY=0 disables globally. */
  lazy?: boolean;
  /** Decompose an epic mission into sequential phases (auto for long complex
   * tasks; commander sets false on --no-decompose). */
  decompose?: boolean;
  /** `--orchestrate`: run decomposed tasks through the blackboard orchestrator
   * with MINIMAL per-task context (each task sees only its goal + its direct
   * dependencies' outputs), so small-context models can multi-step through
   * large builds. Implies --decompose. */
  orchestrate?: boolean;
  /** `--epics`: run a MASSIVE mission as a sequence of epics via the epic
   * controller — each epic is a fresh mission (fresh context, only prior epics'
   * summaries injected), looped with fresh sessions until accepted. Auto for
   * very long complex missions; commander sets false on --no-epics. */
  epics?: boolean;
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
      .filter(Boolean)
      // Harness-owned state (run checkpoints, traces, mined weaknesses) must
      // never ride into the delivery commit on repos that don't ignore .uap/.
      .filter((f) => !f.startsWith('.uap/') && !f.startsWith('.uap\\'));
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

/** Deliver's 3-level complexity (simple/moderate/complex) → the routing tier
 * scale (low/medium/high/critical). Deliver's classifier never emits
 * 'critical' — that tier is reserved for keyword-driven escalation. */
const COMPLEXITY_TO_TIER: Record<string, TaskComplexity> = {
  simple: 'low',
  moderate: 'medium',
  complex: 'high',
};

/**
 * Complexity-tier routing (P: per-task model selection). Returns the model id
 * to execute this task on, or null to leave the caller's default untouched.
 * PURE — unit-tested. Precedence is enforced by the caller: an explicit
 * --model always wins; this only fires when routing is requested and no model
 * was pinned.
 */
export function resolveTierModel(
  routingId: string | undefined,
  instruction: string
): { model: string; tier: TaskComplexity; preset: string } | null {
  const id = routingId ?? process.env.UAP_DELIVER_ROUTING;
  if (!id) return null;
  const preset = RoutingPresets[id];
  if (!preset) return null;
  const complexity = measureQueryComplexity(instruction, { moderate: 1, complex: 2 });
  const tier = COMPLEXITY_TO_TIER[complexity] ?? 'medium';
  return { model: resolvePresetModel(preset, { complexity: tier, role: 'executor' }), tier, preset: id };
}

function resolveModel(presetId: string, endpointOverride?: string): ModelConfig {
  const preset = ModelPresets[presetId];
  if (!preset) {
    const available = Object.keys(ModelPresets).join(', ');
    fail(`Unknown model preset '${presetId}'. Available: ${available}`);
  }
  return endpointOverride ? { ...preset, endpoint: endpointOverride } : preset;
}

/**
 * Explorer candidates act through the file-block applier, which the agentic
 * tool-loop bypasses — agentic runs must use single-candidate turns. PURE,
 * exported for tests (the wedge this guards shipped once already).
 */
export function effectiveCandidates(agentic: boolean, candidates?: number): number | undefined {
  return agentic ? undefined : candidates;
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
  if (plan.acceptance && options.acceptance === undefined) options.acceptance = true;
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
  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  // Durable runs: `--resume <id|latest>` restores an interrupted mission —
  // instruction, phase cursor, and the loop checkpoint — and continues it.
  let resumeState: DeliverRunState | null = null;
  if (options.resume) {
    resumeState = loadRunState(projectRoot, options.resume);
    if (!resumeState) {
      fail(`No resumable run '${options.resume}' under ${projectRoot}/.uap/deliver-runs`);
    }
    if (!instruction.trim()) instruction = resumeState.instruction;
    if (!options.dryRun) {
      console.log(
        chalk.cyan(
          `⟲ resuming run ${resumeState.runId} (turn ${resumeState.checkpoint?.turn ?? 0} completed${resumeState.phases ? `, phase ${(resumeState.phaseIndex ?? 0) + 1}/${resumeState.phases.length}` : ''})`
        )
      );
      // The state file is on the untrusted side of the boundary — always show
      // the operator what mission they are about to continue.
      console.log(chalk.dim(`  mission: ${resumeState.instruction.slice(0, 200)}`));
    }
  }
  if (!instruction.trim()) {
    fail('An instruction is required (or pass --resume <id|latest> to continue a prior run).');
  }

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
  // Anchor trace artifacts to the TARGET project: the exporter defaults to
  // cwd, which is wrong (and commingles projects) under --project-root.
  if (!process.env.UAP_HALO_TRACE_PATH) {
    process.env.UAP_HALO_TRACE_PATH = join(projectRoot, '.uap', 'halo', 'traces.jsonl');
  }

  // Complexity-tier routing: when --routing (or UAP_DELIVER_ROUTING) names a
  // preset and the user did NOT pin --model, execute on the model the preset
  // assigns to this task's complexity tier. Explicit --model and a resumed
  // run's preset always win (user intent / mid-flight consistency).
  const tierRoute =
    options.model === undefined && resumeState === null
      ? resolveTierModel(options.routing, instruction)
      : null;
  const presetId =
    options.model ??
    resumeState?.presetId ??
    tierRoute?.model ??
    process.env.UAP_DELIVER_MODEL ??
    'qwen35-a3b';
  if (tierRoute && !options.dryRun) {
    console.log(
      chalk.cyan(
        `\u26a1 tier routing: '${tierRoute.preset}' \u2192 ${tierRoute.tier} complexity \u2192 ${tierRoute.model}`
      )
    );
  }

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
  // An operator-supplied --max-turns is a HARD CAP: neither the default-on
  // until-delivered extension nor an escalation tier's raiseMaxTurns may push
  // past it (the loop clamps every extension to the ceiling). An explicit
  // --ceiling still wins as the (higher) hard bound when both are given.
  if (options.maxTurnsExplicit && maxTurns !== undefined && options.ceiling === undefined) {
    maxTurnsCeiling = maxTurns;
    if (!options.dryRun) {
      console.log(chalk.dim(`  --max-turns ${maxTurns} set explicitly — hard cap (until-delivered/escalation cannot extend it)`));
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
  let gatesWanted: Set<string> | null = null;
  if (options.gates) {
    gatesWanted = new Set(options.gates.split(',').map((g) => g.trim()));
    const unknown = [...gatesWanted].filter((id) => !rungs.some((r) => r.id === id));
    if (unknown.length > 0) {
      fail(`Unknown gate id(s): ${unknown.join(', ')}. Detected: ${rungs.map((r) => r.id).join(', ')}`);
    }
    rungs = rungs.filter((r) => gatesWanted!.has(r.id));
  }

  // Resolve the highest LOCAL tier to run (cheap-first promotion). The
  // ci/staging/prod tiers are never run locally — they are verified after
  // commit via the CI watcher — so the local ceiling is deploy-dev.
  const LOCAL_TIER_CEILING = TIER_ORDER.indexOf('deploy-dev');
  // Default ceiling is 'runtime' (fast + the runtime execution gate), NOT 'fast':
  // the execution gate that proves the artifact actually runs is tier 'runtime',
  // so a 'fast' ceiling would silently drop it. integration/deploy-dev stay
  // opt-in (via detected suite / --deploy-dev / --tiers).
  let maxTier: GateTier = 'runtime';
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
  const noRealGates = rungs.length === 0;
  // With --acceptance and no objective gates, the LLM acceptance judge is the
  // convergence target instead of a model-authored self-gate. The self-gate
  // greps for hard-coded patterns and fails when the implementation's naming
  // differs from its own assertions (e.g. `small:{size:36}` vs a grep for
  // `SMALL_OCTOPUS_SIZE.*36`) — false negatives that block delivery of correct
  // code. The judge evaluates the spec semantically. --force-self-gate overrides.
  // P6 — gate thickening: a single required rung is a WEAK optimization
  // target; the brutal bench measured the failure mode directly (iterate-to-
  // gate-green converged to gate-satisfying-but-wrong code, +2/-3 on the
  // thin-gate task). When the visible gate set is thin, enable the acceptance
  // judge so the spec itself thickens the target. UAP_DELIVER_THICKEN=0 opts out.
  const thinGates =
    !noRealGates &&
    process.env.UAP_DELIVER_THICKEN !== '0' &&
    rungs.filter((r) => r.required).length <= 1;
  if (thinGates && options.acceptance === undefined) {
    options.acceptance = true;
    if (!options.dryRun) {
      console.log(
        chalk.cyan('⚖ thin gate set (≤1 required rung) — acceptance judge enabled to thicken the target')
      );
    }
  }

  const { acceptancePrimary, needsSelfGate, noGatesError } = decideGateStrategy({
    hasAcceptance: Boolean(options.acceptance),
    noRealGates,
    forceSelfGate: options.forceSelfGate === true,
    selfGateAllowed,
  });
  if (noGatesError) {
    fail(
      `No verifiable gates detected in ${projectRoot} (need package.json scripts, or drop --no-self-gate to author one).`
    );
  }
  // Bootstrap rung: an objective floor so the loop runs and reaches the
  // acceptance judge each turn. It trivially passes; the REAL objective check is
  // the execution gate, which joins via redetectRungs once the model writes
  // files. Acceptance fails closed in primary mode (below), so turn 1 on an
  // empty repo can't vacuously "deliver" — there is no implementation to accept.
  if (acceptancePrimary) {
    rungs.push({
      id: 'bootstrap',
      name: 'Loop bootstrap (acceptance judge is the convergence target)',
      command: 'node',
      args: ['-e', ''],
      required: true,
      timeoutMs: 5_000,
      tier: 'fast',
    } satisfies GateRung);
    console.log(
      chalk.cyan('⚖ acceptance: LLM judge is the convergence target (no objective project gates; self-gate skipped)')
    );
  }

  // Baseline-delta gating: a required rung that is ALREADY red cannot be a
  // regression this mission causes, but it makes acceptance unreachable and
  // eats the whole turn budget (two live missions wedged this way). Preflight
  // once and demote baseline-red required rungs to optional — they still run
  // and report; only NEW failures block. Off-switches: env
  // UAP_DELIVER_BASELINE_DELTA=0 or `.uap.json` deliver.baselineDelta=false.
  if (
    rungs.length > 0 &&
    !needsSelfGate &&
    !options.dryRun &&
    process.env.UAP_DELIVER_BASELINE_DELTA !== '0' &&
    (() => {
      try {
        const cfg = loadUapConfigRaw(projectRoot) as { deliver?: { baselineDelta?: boolean } } | null;
        return cfg?.deliver?.baselineDelta !== false;
      } catch {
        return true;
      }
    })()
  ) {
    const bd = demoteBaselineFailures(rungs, projectRoot);
    if (bd.demoted.length > 0) {
      rungs = bd.rungs;
      console.log(
        chalk.yellow(
          `  ⚖ baseline-delta: ${bd.demoted.length} pre-existing failure(s) demoted to non-blocking ` +
            `(${bd.demoted.map((d) => d.id).join(', ')}) — only NEW failures block acceptance ` +
            `(preflight ${(bd.preflightMs / 1000).toFixed(0)}s)`
        )
      );
    } else {
      console.log(chalk.dim(`  baseline-delta: baseline green (preflight ${(bd.preflightMs / 1000).toFixed(0)}s)`));
    }
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
      tierRouting: tierRoute ? `${tierRoute.preset} \u2192 ${tierRoute.tier} \u2192 ${tierRoute.model}` : null,
      ideate: Boolean(options.ideate || options.ideateProject),
      ideateProject: options.ideateProject ?? null,
      halo: Boolean(options.halo) || isHaloTracingEnabled(),
      coordinate: Boolean(options.coordinate),
      deploy: Boolean(options.deploy),
      protectTests: options.protectTests !== false,
      protectedTestFiles: options.protectTests !== false ? snapshotProtection(projectRoot).protectedFiles.size : 0,
      guidanceFile: options.guidanceFile ? resolve(options.guidanceFile) : null,
      untilDelivered,
      ceiling: untilDelivered ? (maxTurnsCeiling ?? DEFAULT_CLI_CEILING) : null,
      acceptance: Boolean(options.acceptance),
      decompose:
        options.decompose ??
        (process.env.UAP_DELIVER_DECOMPOSE !== '0' &&
          shouldDecompose(instruction, autoPlan?.complexity)),
      resume: resumeState?.runId ?? null,
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
  // JSON-verdict channel (P4): evaluator calls that must return parseable
  // JSON (judge/critic/ideation/decompose verdicts) are tagged so the proxy
  // grammar-constrains the completion to a bare JSON value. Other servers
  // ignore the tag; parses become deterministic on the UAP proxy.
  const jsonBlindExecutor: LoopExecutor = async (prompt) => {
    const result = await client.complete(model, prompt, { temperature, jsonResponse: true });
    return result.content;
  };

  // Generator!=Evaluator (loop-engineering rule #1): when an evaluator model is
  // configured, the acceptance gate is AUTHORED and JUDGED by a different model
  // than the one implementing — so the generator never grades its own work.
  // Pairs naturally with the barbell strategy (cheap generator, sharp evaluator).
  // Defaults to the generator (single-model, unchanged) when unset.
  // Fallback chain: an explicitly-configured stronger/escalation model doubles
  // as the evaluator when no dedicated evaluator is set — a sharp judge is the
  // cheapest place to spend the strong model (barbell strategy), and it keeps
  // generator≠evaluator ON by default wherever a second model exists at all.
  let evaluatorPresetId = resolveEvaluatorPreset({
    evaluatorModel: options.evaluatorModel,
    generatorPreset: presetId,
    envEvaluator:
      process.env.UAP_DELIVER_EVALUATOR_MODEL ??
      options.escalateModel ??
      process.env.UAP_ESCALATE_MODEL,
  });
  // The escalation-env fallback must FAIL SOFT: a stale UAP_ESCALATE_MODEL
  // must not break every run — only an explicit --evaluator-model may fail hard.
  if (evaluatorPresetId && !options.evaluatorModel && !ModelPresets[evaluatorPresetId]) {
    console.log(
      chalk.yellow(`⚠ evaluator fallback '${evaluatorPresetId}' is not a known preset — using the generator as evaluator`)
    );
    evaluatorPresetId = null;
  }
  let evaluatorExecutor: LoopExecutor = blindExecutor;
  let verdictExecutor: LoopExecutor = jsonBlindExecutor;
  if (evaluatorPresetId) {
    const evalModel = resolveModel(evaluatorPresetId, options.evaluatorEndpoint);
    const evalClient = new OpenAICompatClient();
    evaluatorExecutor = async (prompt) => {
      // Evaluators judge cool + deterministic; they do not brainstorm.
      const r = await evalClient.complete(evalModel, prompt, { temperature: 0 });
      return r.content;
    };
    verdictExecutor = async (prompt) => {
      const r = await evalClient.complete(evalModel, prompt, { temperature: 0, jsonResponse: true });
      return r.content;
    };
    if (!options.dryRun) {
      console.log(chalk.cyan(`⚖ generator≠evaluator: gen=${model.id} eval=${evalModel.id}`));
    }
  }

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
  // Endpoint resolution (both executors honor UAP_INFERENCE_ENDPOINT, which
  // unifies them when set). Defaults differ ON PURPOSE: the blind path uses the
  // OpenAI client default (the :4000 <think>-stripping proxy → clean file fences),
  // while the agentic tool-loop goes :8080 DIRECT — routing its OpenAI tool calls
  // through the Anthropic-tuned proxy stalls the loop. Garbled tool paths are
  // handled by the in-process normalizer (path-normalize.ts), not the proxy.
  const agenticEndpoint =
    model.endpoint ?? options.endpoint ?? process.env.UAP_INFERENCE_ENDPOINT ?? 'http://localhost:8080/v1';
  const agentic = executorMode === 'agentic';
  if (agentic) {
    console.log(chalk.cyan(`⚙ executor: agentic (tool-using loop) @ ${agenticEndpoint}`));
  }
  // Best-of-N exploration acts through the file-block applier, which the
  // agentic tool-loop bypasses (noop applier, direct repo mutation): agentic
  // "candidates" would all write the same tree, report zero applied files,
  // never be committable, and the turn would score 0 with no gate run — a
  // guaranteed-stagnation wedge. Force single-candidate turns instead.
  if (agentic && candidates) {
    console.log(
      chalk.dim('  explorer: disabled for the agentic executor (candidates need the file-block applier) — single-candidate turns')
    );
  }
  candidates = effectiveCandidates(agentic, candidates);
  // Context auto-size (on by default): size every deliver session to the
  // serving rail (per-slot llama context, e.g. 180k at --parallel 2 / ctx
  // 360k) so epics/sessions always COMPLETE within the context they get.
  // Budget = rail (env UAP_DELIVER_SESSION_TOKEN_BUDGET → .uap.json
  // deliver.sessionTokenBudget → model preset modelContextBudget) × the
  // working fraction that keeps sessions below the proxy's prune threshold.
  // Disable with UAP_DELIVER_AUTOSIZE=0 or `.uap.json` deliver.autoSizeEpics=false.
  const cfgRawEarly = (() => { try { return loadUapConfigRaw(projectRoot) ?? {}; } catch { return {}; } })();
  const cfgAutoSize = (cfgRawEarly.deliver as Record<string, unknown> | undefined)?.autoSizeEpics;
  const autoSizeEnabled =
    process.env.UAP_DELIVER_AUTOSIZE !== '0' && cfgAutoSize !== false && cfgAutoSize !== 'off';
  // Auto-discover the ACTUAL per-rail context window of the model being called
  // (proxy /v1/context → llama /props) so sizing tracks the live model instead
  // of a hardcoded preset — maximum ctx use of whatever is actually serving.
  // Fail-soft: unreachable/slow discovery falls back to the preset. An explicit
  // env/config budget still wins (deliberate cap).
  const discoveredCtx = autoSizeEnabled
    ? await discoverModelContextWindow(model.endpoint ?? agenticEndpoint)
    : undefined;
  const sessionBudget = autoSizeEnabled
    ? sessionWorkingBudget(resolveSessionTokenBudget(model, cfgRawEarly, discoveredCtx))
    : undefined;
  if (sessionBudget) {
    const src = discoveredCtx ? `discovered ${discoveredCtx.toLocaleString()}` : 'preset';
    console.log(chalk.dim(`  context auto-size: sessions budgeted to ~${sessionBudget.toLocaleString()} tokens (rail-fit, ${src})`));
  }
  const executor: LoopExecutor = agentic
    ? createAgenticExecutor(model, {
        projectRoot,
        endpoint: agenticEndpoint,
        temperature,
        contextTokenBudget: sessionBudget,
        // Block oracle tampering: protected test files are read-only to the agent.
        protectedFiles:
          options.protectTests !== false ? snapshotProtection(projectRoot).protectedFiles : new Set<string>(),
        // Block gate-config / IaC rigging in the agentic path too (it bypasses
        // the file-block applier where this protection otherwise lives).
        protectGateConfigs: options.protectTests !== false,
        // run_bash is an uncontained host shell unsandboxed — allow it only
        // under `uap sandbox` (auto-detected) or an explicit opt-in (audit X3).
        allowBash: options.allowBash === true || process.env.UAP_DELIVER_ALLOW_BASH === '1',
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
    const sg = await authorAcceptanceGate({ instruction, projectRoot, executor: evaluatorExecutor });
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

  // Escalation controllers hold stagnation state in closures, so each loop
  // (each phase of a decomposed mission) gets a FRESH one — phase 2 must not
  // start pre-escalated because phase 1 ended near 100%.
  const makeEscalation = (): ReturnType<typeof createEscalationController> | undefined =>
    options.escalate
      ? createEscalationController({
          tiers: defaultEscalationLadder({
            includeExploration: !agentic,
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
  const storePracticeProvider = practiceStore
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
  // Weakness → prompt feedback: guidance distilled from the PREVIOUS runs'
  // auto-mined failure patterns rides the same practice channel, so what the
  // harness observed failing changes what the model is told this run.
  // Harness-authored text only; fail-soft; empty when nothing was mined.
  const minedGuidance = isHaloTracingEnabled() ? weaknessGuidance(loadPersistedWeaknesses()) : [];
  if (minedGuidance.length > 0 && !options.dryRun) {
    console.log(chalk.dim(`  ⛏ applying ${minedGuidance.length} mined-weakness guidance line(s) from previous runs`));
  }
  const practiceProvider =
    storePracticeProvider || minedGuidance.length > 0
      ? async (task: string): Promise<string[]> => {
          const fromStore = storePracticeProvider ? await storePracticeProvider(task) : [];
          return [...fromStore, ...minedGuidance];
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
  if ((options.ideate || options.ideateProject) && agentic) {
    console.log(chalk.dim('💡 ideation skipped: seeds act through the explorer, which the agentic executor cannot use'));
  }
  if (!seeds && (options.ideate || options.ideateProject) && !agentic) {
    console.log(chalk.cyan('💡 Generating divergent strategy seeds…'));
    // Ideation is a TEXT completion (one JSON array), like the judge/critic —
    // NEVER the agentic tool-loop executor, which cannot answer a text prompt
    // and silently forced the static-defaults fallback on every agentic run.
    seeds = await generateStrategySeeds(
      instruction,
      jsonBlindExecutor,
      candidates ? { count: candidates } : {}
    );
    if (seeds === DEFAULT_STRATEGY_SEEDS) {
      console.log(
        chalk.yellow('💡 Seed generation fell back to the static defaults (model returned no usable seeds)')
      );
    }
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
  // B2: tiered acceptance. The per-turn LLM acceptance judge is the recurring
  // heavy cost. For a `simple` task it is skipped UNLESS acceptance is the only
  // verification (acceptancePrimary) — objective/self-gate (a runnable script,
  // i.e. a templated runtime check) covers simple tasks, so we avoid an LLM
  // judge call per turn. Non-simple tasks are unchanged.
  const skipJudgeForSimple = shouldSkipAcceptanceJudge({
    acceptanceEnabled: Boolean(options.acceptance),
    complexity: autoPlan?.complexity,
    acceptancePrimary,
  });
  if (skipJudgeForSimple && !options.dryRun) {
    console.log(chalk.cyan('⚖ acceptance: judge skipped for simple task (objective/self-gate covers it)'));
  }
  // Phased missions re-point the judge at the current phase's goal — judging
  // phase 1 against the FULL mission would fail every phase by construction.
  let acceptanceSpec = instruction;
  // Secondary-judge churn breaker: bounds consecutive judge rejections of
  // objectively-green turns per spec (env UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT,
  // default 2), after which the objective gates win. Primary mode is exempt.
  // Change-evidence for the breaker's zero-diff guard: files applied since the
  // current acceptance spec (epic) began. Incremented by the iteration hook,
  // reset wherever acceptanceSpec is re-pointed.
  const specChangeEvidence = { writes: 0 };
  const acceptanceChurnBreaker = createAcceptanceChurnBreaker(
    Number(process.env.UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT ?? 2),
    () => specChangeEvidence.writes > 0
  );
  const acceptanceGate: AcceptanceGate | undefined = options.acceptance && !skipJudgeForSimple
    ? async (root) => {
        // Primary mode: the only objective rung is the trivial bootstrap, and the
        // real execution gate joins via redetect only on the NEXT turn (one-turn
        // lag). So gate the artifact's runtime HERE too — it must actually RUN
        // before completeness is judged — closing the gap where a 1-turn build
        // could be declared delivered on the judge alone. Idempotent with the
        // redetected execution rung on later turns.
        let visualNote = '';
        if (acceptancePrimary) {
          const exec = await runExecutionGate(root);
          if (!exec.passed) {
            return {
              passed: false,
              feedback: `EXECUTION FAILED — the code must run before it can be accepted:\n${exec.outputTail}`,
            };
          }
          // Visual gate: watch the artifact RUN — blank canvas, static rAF
          // scene, or runtime errors during observation block acceptance, and
          // the observation summary becomes judge evidence (a code-evidence
          // judge cannot see a never-started animation; this can).
          const visual = await runVisualGate(root);
          if (!visual.skipped && !visual.passed) {
            return { passed: false, feedback: visual.feedback };
          }
          visualNote = visualRuntimeNote(visual);
        }
        // Secondary mode reaches this gate ONLY on turns whose objective
        // gates all passed — hand the judge that fact as evidence, so
        // requirements like "make the tests pass" are graded on the gate
        // result instead of speculated about from static code.
        const runtimeNote = acceptancePrimary
          ? visualNote
          : 'Objective project gates (build/test suite) ALL PASSED on this turn — treat test/build-related requirements as objectively verified.';
        const r = await runAcceptanceGate({
          spec: acceptanceSpec,
          projectRoot: root,
          executor: verdictExecutor,
          ...(runtimeNote ? { runtimeNote } : {}),
        });
        const verdict = resolveAcceptanceVerdict(r, acceptancePrimary);
        // Secondary mode only: this gate is reached exclusively on turns whose
        // objective gates ALL passed, so a bounded number of consecutive judge
        // rejections hands the verdict back to the gates instead of wedging.
        if (!acceptancePrimary) {
          const checked = acceptanceChurnBreaker.check(acceptanceSpec, verdict);
          if (checked.overridden) {
            console.log(
              chalk.yellow(
                '  ⚖ acceptance: judge rejected consecutive objectively-green turns — accepting on gates (raise UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT to let the judge argue longer)'
              )
            );
          }
          return checked;
        }
        return verdict;
      }
    : undefined;

  const seams = {
    ladderRunner: tieredRunner,
    // The agentic executor mutates the repo directly, so nothing remains for
    // the file-block applier to materialize.
    ...(agentic ? { applier: noopApplier } : {}),
    ...(acceptanceGate ? { acceptanceGate } : {}),
  };

  /** Compose the per-turn hooks with a FRESH escalation controller. */
  const makeIterationHook = (): ReturnType<typeof composeIterationHooks> => {
    const escalation = makeEscalation();
    return composeIterationHooks(
      (record) => printProgress(record),
      (record) => {
        // Feed the acceptance breaker's zero-diff guard.
        if (record.filesApplied.length > 0) specChangeEvidence.writes += record.filesApplied.length;
        return undefined;
      },
      (record) => haloTracer.onIteration(record),
      coordinator ? (record) => coordinator.onIteration(record) : undefined,
      escalation ? (record) => escalation.onIteration(record) : undefined
    );
  };

  const loopConfig: ConvergenceConfig = {
    projectRoot,
    maxTurns,
    rungs,
    // The agentic executor mutates the repo directly (no-op applier), so
    // gates must run every turn regardless of applier file count.
    alwaysVerify: agentic ? true : undefined,
    // From-scratch builds have no artifact at t0, so the runtime execution gate
    // (and build/test/lint) aren't detectable yet. Re-detect each turn so they
    // engage once the model writes files, rather than relying only on the t0
    // self-gate fallback. The filter mirrors the t0 scoping so re-detection
    // honors --gates / --no-integration / the tier ceiling (never escalates).
    redetectRungs: true,
    redetectFilter: (r) => {
      if (gatesWanted && !gatesWanted.has(r.id)) return false;
      const t = tierOf(r);
      if (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(maxTier)) return false;
      if (allowedTiers) return allowedTiers.has(t);
      if (t === 'integration' && options.integration === false) return false;
      return true;
    },
    // Judge/critic evaluate text, so they always use the blind executor even
    // when the loop's executor is agentic.
    // Best-of-N with git-worktree isolation when available: candidates verify
    // CONCURRENTLY in their own trees (clean git repo required; falls back to
    // the sequential shared-tree path otherwise).
    explorer: candidates
      ? {
          candidates,
          seeds,
          judge: createModelJudge(jsonBlindExecutor),
          workspaceProvider: agentic ? undefined : (createGitWorktreeProvider(projectRoot) ?? undefined),
        }
      : undefined,
    critic: options.critic ? createModelCritic(jsonBlindExecutor) : undefined,
    // Critic evaluates text; keep it on a blind completion even if the loop
    // escalates the (agentic) executor.
    criticFactory: (ex) => createModelCritic(agentic ? jsonBlindExecutor : ex),
    practiceProvider,
    protectTests: options.protectTests,
    // Runtime-integrity snapshot set beyond the auto-detected tests/oracle:
    //  - the self-authored gate script (X1), and
    //  - existing gate-config + package/lockfiles (X5) — the applier blocks the
    //    model WRITING these, but run_bash bypasses the applier, so snapshot +
    //    restore any a gate run mutates (e.g. `npm pkg set scripts.test=…`).
    // Only when protectTests is on (the integrity guard is gated on it).
    ...(options.protectTests !== false
      ? {
          extraProtectedPaths: [
            ...(needsSelfGate ? ['.uap-deliver/verify.sh'] : []),
            ...listGateConfigFiles(projectRoot),
          ],
        }
      : {}),
    guidanceProvider,
    untilDelivered,
    maxTurnsCeiling,
    // Stagnation-triggered ideation (escalation ladder tier): regenerate
    // divergent seeds mid-run, steering away from the failing approach.
    seedGenerator: async (instr, feedback) =>
      generateStrategySeeds(
        feedback ? `${instr}\n\nPrevious-attempt gate feedback (avoid approaches that led here):\n${feedback.slice(0, 800)}` : instr,
        jsonBlindExecutor,
        candidates ? { count: candidates } : {}
      ),
    onIteration: makeIterationHook(),
  };
  // ---- Durable run + optional mission decomposition (fable-style) ----
  const runId = resumeState?.runId ?? newRunId();
  let phases: DeliveryPhase[] | undefined = resumeState?.phases;
  let phaseIndex = resumeState?.phaseIndex ?? 0;
  const phaseSummaries: string[] = [...(resumeState?.phaseSummaries ?? [])];
  // A mission-scoped self-gate cannot judge individual phases, so
  // decomposition stands down there. Acceptance-primary is fine now: the
  // judge's spec is phase-scoped (acceptanceSpec follows the current phase).
  // Orchestration enablement (the long multi-turn coordinator). AUTO-ON for
  // any decomposed mission — minimal-context orchestration is strictly better
  // than the full-mission phase prompt for small models — unless the operator
  // disables it: --no-orchestrate (options.orchestrate === false),
  // UAP_DELIVER_ORCHESTRATE=0, or `.uap.json` deliver.orchestrate === false /
  // 'off'. `uap orchestrator on|off|auto` writes that key.
  const cfgRaw = (() => { try { return loadUapConfigRaw(projectRoot) ?? {}; } catch { return {}; } })();
  const cfgOrch = ((cfgRaw.deliver as Record<string, unknown> | undefined)?.orchestrate);
  const orchestrateEnabled =
    options.orchestrate !== false &&
    process.env.UAP_DELIVER_ORCHESTRATE !== '0' &&
    cfgOrch !== false && cfgOrch !== 'off';
  // Epic controller (P7): the outer loop above orchestration. A massive mission
  // (complex) is a SEQUENCE of epics, each run as its own fresh mission and
  // looped with fresh sessions until accepted. ON BY DEFAULT for EVERY mission
  // (2026-07-09 — was: only complex-classified). Each epic runs in a FRESH
  // session (fresh context, prior-epic summaries only) — the structural fix for
  // single-session context thrash — and a trivial mission simply decomposes to
  // one epic, so the wrapper is cheap. Disable per-run with --no-epics /
  // UAP_DELIVER_EPICS=0 / `.uap.json` deliver.epics false|'off'. Never on
  // self-gate or resume (those are special single-pass modes).
  const cfgEpics = (cfgRaw.deliver as Record<string, unknown> | undefined)?.epics;
  const epicsEnabled =
    !needsSelfGate && !resumeState &&
    options.epics !== false &&
    process.env.UAP_DELIVER_EPICS !== '0' &&
    cfgEpics !== false && cfgEpics !== 'off';
  const decomposeWanted =
    !needsSelfGate &&
    (options.orchestrate === true ||
      options.decompose === true ||
      (options.decompose === undefined &&
        process.env.UAP_DELIVER_DECOMPOSE !== '0' &&
        shouldDecompose(instruction, autoPlan?.complexity)));
  if (!phases && decomposeWanted && !resumeState) {
    console.log(chalk.cyan('🧩 decompose: planning sequential delivery phases…'));
    // ExpertOrchestrator lifecycle chain → phase-shaping hints (fail-soft).
    let lifecycleHints: LifecycleHintProvider | undefined;
    try {
      const { planFromDescription } = await import('../coordination/expert-orchestrator.js');
      lifecycleHints = (instr) => {
        const chain = planFromDescription(instr);
        const byPhase = new Map<string, string[]>();
        for (const step of chain.steps) {
          const list = byPhase.get(step.phase) ?? [];
          if (list.length < 3) list.push(step.droid);
          byPhase.set(step.phase, list);
        }
        const lines = [...byPhase.entries()].map(([ph, droids]) => `- ${ph}: ${droids.join(', ')}`);
        return lines.length > 0 ? lines.join('\n') : null;
      };
    } catch {
      lifecycleHints = undefined;
    }
    const planned = await planDeliveryPhases(instruction, verdictExecutor, lifecycleHints, { sessionTokenBudget: sessionBudget });
    if (planned.length >= 2) {
      phases = planned;
      console.log(chalk.cyan(`🧩 ${planned.length} phases: ${planned.map((ph) => ph.title).join(' → ')}`));
    } else {
      console.log(chalk.dim('  decompose: no usable multi-phase plan — running as a single mission'));
    }
  }
  const runState: DeliverRunState = {
    runId,
    instruction,
    presetId,
    projectRoot,
    status: 'running',
    pid: process.pid,
    createdAt: resumeState?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpoint: resumeState?.checkpoint,
    phases,
    phaseIndex,
    phaseSummaries: [...phaseSummaries],
  };
  saveRunState(runState);
  // Persist loop state after every turn so this run survives interruption.
  loopConfig.onCheckpoint = (cp) => {
    runState.checkpoint = cp;
    saveRunState(runState);
  };
  // Cooperative cancel from the dashboard: the loop polls this each turn.
  loopConfig.shouldStop = () => isStopRequested(projectRoot, runId);
  clearStop(projectRoot, runId);
  // The restored checkpoint feeds exactly one loop (the in-flight phase).
  let resumeCheckpoint = resumeState?.checkpoint;

  // A model switch cannot serialize into the checkpoint; when the interrupted
  // run had escalated to the stronger model, re-bind it here so resume is not
  // a silent de-escalation. Falls back to the normal executor when no
  // stronger model is configured in this environment.
  let runExecutor = executor;
  if (resumeCheckpoint?.modelEscalated) {
    if (escalateExecutor && !agentic) {
      // Agentic runs keep their tool-loop executor: the blind escalation
      // executor pairs with the noop applier and would never touch the repo.
      runExecutor = escalateExecutor;
      console.log(chalk.magenta(`  ↑ resume: re-binding escalated model (${escalateModelName ?? 'stronger model'})`));
    } else if (!escalateExecutor) {
      console.log(
        chalk.yellow(
          '⚠ resume: the interrupted run had escalated to a stronger model, but none is configured here (--escalate-model / UAP_ESCALATE_MODEL) — continuing on the base model'
        )
      );
    }
  }

  // Task/memory trail: the run is a live task while it converges. A resumed
  // run reuses its original task instead of opening a duplicate.
  const missionTask = resumeState?.taskId
    ? await reopenDeliveryTask(resumeState.taskId, projectRoot)
    : await openDeliveryTask(instruction, projectRoot);
  runState.taskId = missionTask?.id ?? resumeState?.taskId;

  /** Sequential phased delivery: each phase runs its own convergence loop
   * against the same gates; later phases see one-line summaries of what the
   * earlier phases already built. Baseline checks are off — a green tree
   * means the PREVIOUS phase is done, not the next one. */
  /**
   * P1+P2 — orchestrated delivery: decomposed tasks execute on a blackboard,
   * each in a FRESH MINIMAL context (its goal + direct-dependency outputs only)
   * instead of the full-mission phase prompt. Reuses the convergence loop as
   * the per-task executor; a completed task publishes a compact summary its
   * dependents read instead of source.
   */
  const runOrchestratedMission = async (): Promise<DeliveryResult> => {
    const all: DeliveryResult = {
      success: true, alreadyDelivered: false, turns: 0, bestScore: 0, bestTurn: 0,
      history: [], finalFeedback: '', finalOutput: '', totalDurationMs: 0,
    };
    const tasks: OrchestratorTask[] = phases!.map((ph) => ({
      id: ph.id, title: ph.title, goal: ph.goal, ...(ph.deps ? { deps: ph.deps } : {}),
    }));
    const orchResult = await orchestrate({
      mission: instruction,
      tasks,
      contextBudgetChars: Number(process.env.UAP_DELIVER_CONTEXT_BUDGET ?? 6000),
      maxTasks: Number(process.env.UAP_DELIVER_MAX_TASKS ?? 40),
      // P3 — per-task memory retrieval: pull the few most relevant established
      // decisions/patterns/gotchas for THIS task's goal (a small semantic
      // query, not the full spec), so a fresh-context task reconstructs "what
      // am I building and why" from memory. Fail-soft → no design lines.
      retrieveDesign: async (task): Promise<string[]> => {
        try {
          const { retrieveDynamicMemoryContext } = await import('../memory/dynamic-retrieval.js');
          const mem = await retrieveDynamicMemoryContext(task.goal, projectRoot, { maxTokens: 400 });
          const lines: string[] = [];
          for (const m of mem.relevantMemories.slice(0, 4)) lines.push(m.content.slice(0, 160));
          for (const g of mem.gotchas.slice(0, 2)) lines.push(`gotcha: ${g.slice(0, 140)}`);
          for (const pat of mem.patterns.slice(0, 2)) lines.push(`pattern: ${pat.slice(0, 140)}`);
          return lines;
        } catch {
          return [];
        }
      },
      // P3/P4 — durable publish: a completed task's verified contract lands in
      // short-term memory so later tasks (and future fresh sessions) retrieve
      // the interface from memory instead of re-reading source.
      publish: async (outcome, task): Promise<void> => {
        if (!outcome.success) return;
        await recordOrchestratorTaskOutcome(
          task.id,
          task.title,
          outcome.contract ?? outcome.summary,
          projectRoot
        );
      },
      runTask: async (ctx, task): Promise<TaskOutcome> => {
        console.log(
          chalk.bold(`\u25b6 task ${task.id}: ${task.title}`) +
            chalk.dim(` (ctx ${ctx.prompt.length} chars, deps: ${ctx.includedDeps.join(',') || 'none'})`)
        );
        const taskRecord = await openDeliveryTask(
          `${task.title} — ${task.goal.slice(0, 120)}`,
          projectRoot,
          missionTask?.id
        );
        acceptanceSpec = ctx.prompt;
        specChangeEvidence.writes = 0;
        const loop = new ConvergenceLoop(
          { ...loopConfig, baselineCheck: false, resumeFrom: undefined, onIteration: makeIterationHook() },
          executor,
          seams
        );
        const r = await loop.deliver(ctx.prompt);
        all.turns += r.turns;
        all.history.push(...r.history);
        all.totalDurationMs += r.totalDurationMs;
        if (r.bestScore > all.bestScore) {
          all.bestScore = r.bestScore;
          all.bestTurn = r.bestTurn;
        }
        all.finalFeedback = r.finalFeedback;
        all.finalOutput = r.finalOutput;
        completeDeliveryTask(taskRecord, r);
        const files = [...new Set(r.history.flatMap((h) => h.filesApplied ?? []))];
        // P4 — extract the VERIFIED public contract of what this task built so
        // dependents load the interface (a few hundred chars), not the source.
        let contract: string | undefined;
        if (r.success && files.length > 0) {
          try {
            const { readFileSync } = await import('fs');
            const { join } = await import('path');
            const srcs = files
              .filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx|py)$/.test(f))
              .map((f) => {
                try {
                  return { path: f, content: readFileSync(join(projectRoot, f), 'utf-8') };
                } catch {
                  return null;
                }
              })
              .filter((x): x is { path: string; content: string } => x !== null);
            contract = extractContract(srcs).contract || undefined;
          } catch {
            contract = undefined;
          }
        }
        // P5 — adaptive re-planning feed: a task may surface work the initial
        // plan missed by emitting a `NEW_TASKS: [ {id,title,goal,deps} ]` JSON
        // array in its output. Parsed through the same validator as the planner
        // (well-formed only), then folded into the DAG by orchestrate() (which
        // dedupes, topo-resorts, and caps at maxTasks). Only structural fields
        // are used — never free-form model text as durable memory.
        let newTasks: OrchestratorTask[] | undefined;
        if (r.success) {
          try {
            const marker = /NEW_TASKS:\s*(\[[\s\S]*?\])/.exec(r.finalOutput || r.finalFeedback || '');
            if (marker) {
              const parsed = parsePhaseArray(marker[1]).filter((t) => t.id !== task.id);
              if (parsed.length > 0) {
                newTasks = parsed.map((t) => ({
                  id: t.id, title: t.title, goal: t.goal,
                  ...(t.deps ? { deps: t.deps } : {}),
                }));
                console.log(chalk.dim(`  ↳ re-planning: task ${task.id} discovered ${newTasks.length} follow-up task(s)`));
              }
            }
          } catch {
            newTasks = undefined;
          }
        }
        return {
          taskId: task.id,
          success: r.success,
          turns: r.turns,
          summary: `${task.goal.slice(0, 160)}${files.length ? ` [files: ${files.join(', ')}]` : ''}`,
          ...(contract ? { contract } : {}),
          ...(newTasks && newTasks.length > 0 ? { newTasks } : {}),
        };
      },
    });
    all.success = orchResult.success;
    if (!orchResult.success) {
      all.finalFeedback = `orchestration incomplete — failed tasks: ${orchResult.failed.join(', ')}\n${all.finalFeedback}`;
    }
    return all;
  };

  const runPhasedMission = async (): Promise<DeliveryResult> => {
    const all: DeliveryResult = {
      success: true,
      alreadyDelivered: false,
      turns: 0,
      bestScore: 0,
      bestTurn: 0,
      history: [],
      finalFeedback: '',
      finalOutput: '',
      totalDurationMs: 0,
    };
    for (; phaseIndex < phases!.length; phaseIndex++) {
      runState.phaseIndex = phaseIndex;
      saveRunState(runState);
      const phase = phases![phaseIndex];
      console.log(chalk.bold(`▶ phase ${phaseIndex + 1}/${phases!.length}: ${phase.title}`));
      const phaseTask = await openDeliveryTask(
        `${phase.title} — ${phase.goal.slice(0, 120)}`,
        projectRoot,
        missionTask?.id
      );
      const phaseLoop = new ConvergenceLoop(
        {
          ...loopConfig,
          baselineCheck: false,
          resumeFrom: resumeCheckpoint,
          onIteration: makeIterationHook(),
        },
        resumeCheckpoint ? runExecutor : executor,
        seams
      );
      const resumedTurns = resumeCheckpoint?.history.length ?? 0;
      resumeCheckpoint = undefined;
      const phaseText = phaseInstruction(instruction, phases!, phaseIndex, phaseSummaries);
      // The acceptance judge grades THIS phase's goal, not the whole mission.
      acceptanceSpec = phaseText;
      specChangeEvidence.writes = 0;
      const phaseResult = await phaseLoop.deliver(phaseText);
      all.turns += phaseResult.turns - resumedTurns;
      all.history.push(...phaseResult.history);
      all.totalDurationMs += phaseResult.totalDurationMs;
      if (phaseResult.bestScore > all.bestScore) {
        all.bestScore = phaseResult.bestScore;
        all.bestTurn = phaseResult.bestTurn;
      }
      all.finalFeedback = phaseResult.finalFeedback;
      all.finalOutput = phaseResult.finalOutput;
      completeDeliveryTask(phaseTask, phaseResult);
      if (!phaseResult.success) {
        all.success = false;
        break;
      }
      phaseSummaries.push(
        `${phase.title}: ${phase.goal.slice(0, 140)} (delivered in ${phaseResult.turns} turn(s))`
      );
      runState.phaseSummaries = [...phaseSummaries];
      runState.checkpoint = undefined; // belongs to the finished phase
      saveRunState(runState);
    }
    return all;
  };

  /**
   * P7 — epic controller: run a massive mission as a SEQUENCE of epics. Each
   * epic is executed as its OWN fresh mission (fresh convergence context; only
   * prior epics' compact summaries are injected — never their source or the
   * full spec). An epic that fails its gates is retried with a fresh session
   * that is fed the previous attempt's failure, looped until accepted or the
   * per-epic attempt budget is spent. The blackboard orchestrator still runs
   * WITHIN each epic when that epic itself decomposes.
   */
  const runEpicMission = async (): Promise<DeliveryResult> => {
    const all: DeliveryResult = {
      success: true, alreadyDelivered: false, turns: 0, bestScore: 0, bestTurn: 0,
      history: [], finalFeedback: '', finalOutput: '', totalDurationMs: 0,
    };
    const planned = await planDeliveryPhases(instruction, verdictExecutor, undefined, { sessionTokenBudget: sessionBudget });
    const epics: Epic[] = (planned.length >= 2
      ? planned
      : [{ id: 'mission', title: 'Mission', goal: instruction }]
    ).map((ph) => ({ id: ph.id, title: ph.title, goal: ph.goal, ...(ph.deps ? { deps: ph.deps } : {}) }));
    console.log(chalk.cyan(`\u{1f5c2}  epic controller: ${epics.length} epic(s): ${epics.map((e) => e.title).join(' \u2192 ')}`));

    // Hands-free: auto-populate the completion ledger so the whole multi-epic
    // build has an objective, cross-session definition of done (Option B). The
    // Stop hook + reactor consult it to keep any model going until 100%.
    try {
      initLedger(projectRoot, instruction, epics.map((e) => ({ id: e.id, title: e.title, kind: 'epic' as const, ...(e.deps ? { deps: e.deps } : {}) })));
    } catch { /* ledger is best-effort */ }

    const epicResult = await runEpics({
      mission: instruction,
      epics,
      maxAttemptsPerEpic: Number(process.env.UAP_DELIVER_EPIC_ATTEMPTS ?? 3), // (#4b) 2→3
      // (#4c) Recursive split depth: a huge epic that still can't land after a
      // split is split again, one level shallower, until each piece fits a rail
      // — instead of failing the whole mission at the first split. Bounded.
      splitDepth: Math.max(1, Number(process.env.UAP_DELIVER_EPIC_SPLIT_DEPTH ?? 2)),
      // (#5) Auto-escalation: re-plan a failed epic into smaller pieces and
      // retry them rather than declaring the mission incomplete. On by default
      // for the epic path (already gated to complex missions); disable with
      // UAP_DELIVER_SPLIT_ON_ANY_FAILURE=0 to restore budget-exhaustion-only.
      splitOnAnyFailure: process.env.UAP_DELIVER_SPLIT_ON_ANY_FAILURE !== '0',
      // Re-plan a failed epic into sub-epics. Fires on context-budget
      // exhaustion (rail auto-size) and, under splitOnAnyFailure, on any
      // exhausted-attempts failure (auto-escalation). Always provided so #5 has
      // a planner; declines (null) when it can't produce ≥2 pieces.
      splitEpic: async (epic, lastFailure) => {
        const budgetHit = (lastFailure ?? '').includes(CONTEXT_BUDGET_MARKER);
        const reason = budgetHit
          ? `outgrew its ~${(sessionBudget ?? 0).toLocaleString()}-token session budget`
          : 'could not be delivered whole after all attempts';
        console.log(chalk.yellow(`  ✂ epic ${epic.id} ${reason} — re-planning as smaller sub-epics`));
        const subGoal =
          `${epic.goal}\n\n(The previous attempt did not complete` +
          `${lastFailure ? `: ${lastFailure.slice(0, 300)}` : ''}. Split this into smaller, independently completable phases.)`;
        const subs = await planDeliveryPhases(subGoal, verdictExecutor, undefined, { sessionTokenBudget: sessionBudget });
        return subs.length >= 2 ? subs.map((s) => ({ id: s.id, title: s.title, goal: s.goal })) : null;
      },
      onEpic: (epic, outcome) => {
        try { markItem(projectRoot, epic.id, outcome.accepted ? 'done' : 'failed', outcome.accepted ? undefined : outcome.summary); } catch { /* best-effort */ }
        console.log(
          (outcome.accepted ? chalk.green('  \u2713') : chalk.red('  \u2717')) +
            chalk.dim(` epic ${epic.id}: ${outcome.accepted ? 'accepted' : 'failed'} after ${outcome.attempts} attempt(s), ${outcome.turns} turn(s)`)
        );
      },
      runEpic: async (epic, ctx): Promise<EpicRunResult> => {
        const priors = ctx.priorSummaries.length
          ? `\n\nALREADY BUILT (prior epics \u2014 build on them, do not redo):\n${ctx.priorSummaries.map((sm, i) => `${i + 1}. ${sm}`).join('\n')}`
          : '';
        const retry = ctx.lastFailure ? `\n\nPREVIOUS ATTEMPT FEEDBACK (fix this):\n${ctx.lastFailure}` : '';
        const scoped =
          `OVERALL MISSION (context): ${instruction.slice(0, 300)}\n\n` +
          `EPIC \u2014 ${epic.title}:\n${epic.goal}${priors}${retry}\n\n` +
          'Deliver ONLY this epic. All gates must pass at the end.';
        console.log(chalk.bold(`\u25b6 epic ${epic.id} (attempt ${ctx.attempt}): ${epic.title}`));
        // Grade the epic's DELIVERABLE, not the process prompt: the scoped
        // prompt carries process instructions ("read X first"), prior-epic
        // summaries, and retry feedback — none verifiable from code, so a
        // small judge rejects objectively-green turns against them forever.
        acceptanceSpec =
          `EPIC — ${epic.title}:\n${epic.goal}` +
          (epic.criteria?.length ? `\nAcceptance criteria:\n${epic.criteria.map((c) => `- ${c}`).join('\n')}` : '');
        specChangeEvidence.writes = 0; // fresh epic — breaker needs fresh diff evidence
        const epicTask = await openDeliveryTask(`${epic.title} \u2014 ${epic.goal.slice(0, 120)}`, projectRoot, missionTask?.id);
        const loop = new ConvergenceLoop(
          { ...loopConfig, baselineCheck: false, resumeFrom: undefined, onIteration: makeIterationHook() },
          executor,
          seams
        );
        const r = await loop.deliver(scoped);
        all.turns += r.turns;
        all.history.push(...r.history);
        all.totalDurationMs += r.totalDurationMs;
        if (r.bestScore > all.bestScore) { all.bestScore = r.bestScore; all.bestTurn = r.bestTurn; }
        all.finalFeedback = r.finalFeedback;
        all.finalOutput = r.finalOutput;
        completeDeliveryTask(epicTask, r);
        const files = [...new Set(r.history.flatMap((h) => h.filesApplied ?? []))];
        // Rail sizing: surface budget exhaustion to the epic controller — its
        // split path keys off CONTEXT_BUDGET_MARKER in the failure summary,
        // and the goal-based summary would otherwise swallow the signal.
        const budgetHit = !r.success && r.history.some((h) => h.budgetStopped);
        return {
          success: r.success,
          turns: r.turns,
          summary:
            `${epic.goal.slice(0, 140)}${files.length ? ` [files: ${files.join(', ')}]` : ''}` +
            (budgetHit ? ` ${CONTEXT_BUDGET_MARKER} session(s) exceeded the context budget — scope is too large for one session` : ''),
        };
      },
    });
    all.success = epicResult.success;
    if (!epicResult.success) {
      all.finalFeedback = `epic controller incomplete \u2014 failed epic(s): ${epicResult.failed.join(', ')}\n${all.finalFeedback}`;
    }
    return all;
  };

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
    const snapResult = snapshotTree(projectRoot);
    if (snapResult.ok) {
      regressSnapshot = snapResult.path;
      console.log(chalk.dim(`  no-regress: baseline gate score ${baselineGateScore.toFixed(2)} (snapshot taken)`));
    } else {
      const label = snapResult.reason === 'size-cap' ? 'snapshot skipped' : 'snapshot failed';
      console.log(chalk.yellow(`  no-regress: ${label} — ${snapResult.detail}; rollback disabled for this run`));
    }
  }

  // Mark this run (and the gate subprocesses it spawns) as deliver-driven so
  // the delivery-enforcement policy exempts the sanctioned path. Scoped to the
  // loop and RESTORED afterward so a programmatic/long-lived caller doesn't
  // leave the whole process permanently exempt.
  const priorDeliverActive = process.env.UAP_DELIVER_ACTIVE;
  process.env.UAP_DELIVER_ACTIVE = '1';

  let result: DeliveryResult;
  try {
    // P1 — Lazy-UAP: measured on the brutal suite, scaffold-from-turn-1 both
    // wastes tokens on tasks the model can one-shot AND can regress clean
    // one-shots. So: one bare turn (no seeds/critic/practices/exploration,
    // acceptance + gates still judge it) — engage the full machinery only if
    // it fails. Skipped on resume (the mission is already mid-flight).
    let lazySolved = false;
    const lazyWanted =
      options.lazy !== false && process.env.UAP_DELIVER_LAZY !== '0' && !resumeState && !epicsEnabled;
    if (lazyWanted) {
      console.log(chalk.cyan('⚡ lazy attempt: one bare turn before engaging the convergence aids…'));
      const lazyLoop = new ConvergenceLoop(
        {
          projectRoot,
          maxTurns: 1,
          rungs,
          alwaysVerify: agentic ? true : undefined,
          redetectRungs: true,
          redetectFilter: loopConfig.redetectFilter,
          protectTests: options.protectTests,
          onIteration: (record) => printProgress(record),
        },
        executor,
        seams
      );
      const lazyResult = await lazyLoop.deliver(instruction);
      if (lazyResult.success) {
        lazySolved = true;
        result = lazyResult;
        console.log(chalk.green('⚡ lazy: solved by the bare attempt — convergence aids skipped'));
      } else {
        // The lazy ladder just ran and failed — don't pay for a baseline check.
        loopConfig.baselineCheck = false;
        console.log(chalk.dim('  lazy attempt did not pass — engaging the full convergence stack'));
      }
    }
    if (lazySolved) {
      result = result!;
    } else if (epicsEnabled) {
      result = await runEpicMission();
    } else if (phases && phases.length >= 2 && orchestrateEnabled) {
      result = await runOrchestratedMission();
    } else if (phases && phases.length >= 2) {
      result = await runPhasedMission();
    } else {
      if (resumeCheckpoint) loopConfig.resumeFrom = resumeCheckpoint;
      const loop = new ConvergenceLoop(loopConfig, runExecutor, seams);
      result = await loop.deliver(instruction);
    }

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
          { ...loopConfig, baselineCheck: false, resumeFrom: undefined, onCheckpoint: undefined },
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
    runState.status = 'interrupted';
    saveRunState(runState);
    if (coordinator) {
      await coordinator.finish(aborted);
    }
    // The post-run restore/dispose block below never runs after a throw —
    // dispose here so the error path doesn't leak the snapshot.
    if (regressSnapshot) {
      disposeSnapshot(regressSnapshot);
      regressSnapshot = null;
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
      try {
        restoreTree(projectRoot, regressSnapshot);
        console.log(
          chalk.yellow(
            `  ↩ no-regress: reverted (end gate score ${endScore.toFixed(2)} < baseline ${baselineGateScore.toFixed(2)})`
          )
        );
        disposeSnapshot(regressSnapshot);
      } catch (restoreErr) {
        // restoreTree marked the snapshot preserve — do NOT dispose it; it may
        // be the only good copy of the pre-run tree.
        console.log(
          chalk.red(
            `  ↩ no-regress: restore failed (${(restoreErr as Error).message}) — snapshot preserved at ${regressSnapshot}`
          )
        );
      }
    } else {
      console.log(
        chalk.dim(`  no-regress: kept (end gate score ${endScore.toFixed(2)} ≥ baseline ${baselineGateScore.toFixed(2)})`)
      );
      disposeSnapshot(regressSnapshot);
    }
  }

  haloTracer.finish(result);

  // Durable-run bookkeeping + task/memory trail (all fail-soft): the run's
  // outcome lands in the task DB and short-term memory so future sessions
  // know exactly what was delivered (or what failed and why).
  runState.status = result.success
    ? 'delivered'
    : isStopRequested(projectRoot, runId)
      ? 'interrupted'
      : 'failed';
  if (result.success) runState.checkpoint = undefined;
  clearStop(projectRoot, runId);
  saveRunState(runState);
  completeDeliveryTask(missionTask, result);
  await recordDeliveryOutcome(instruction, projectRoot, result, model.id);

  // Close the HALO observe→learn loop: mine the trace tail for recurring
  // failure patterns after every run — no operator step required.
  if (isHaloTracingEnabled()) {
    const mined = autoMineHaloTraces(model.id);
    const minedSummary = summarizeWeaknesses(mined.reports);
    if (minedSummary && !options.json) {
      console.log(chalk.dim(`  ⛏ halo auto-mine: ${minedSummary}`));
    }
  }

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
          runId,
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
