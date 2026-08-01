/**
 * `uap deliver` — run the Fable-parity convergence loop.
 *
 * Drives an underlying model through execute → apply → verify → feedback
 * iterations against the project's real completion gates (build, typecheck,
 * test, lint) until all required gates pass or the turn budget is exhausted.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { ConvergenceLoop, composeIterationHooks } from '../delivery/convergence-loop.js';
import type {
  LoopExecutor,
  IterationRecord,
  DeliveryResult,
  ConvergenceConfig,
} from '../delivery/convergence-loop.js';
import { createModelJudge } from '../delivery/judge.js';
import {
  resolveJudgePlan,
  formatVerificationProvenance,
} from '../delivery/verification-provenance.js';
import { createModelCritic } from '../delivery/critic.js';
import { MAX_CANDIDATES } from '../delivery/explorer.js';
import type { StrategySeed } from '../delivery/explorer.js';
import { generateStrategySeeds, seedsFromIdeas } from '../delivery/ideation.js';
import { DEFAULT_STRATEGY_SEEDS } from '../delivery/explorer.js';
import { planAutoOptimization } from '../delivery/auto-optimizer.js';
import { RoutingPresets, resolvePresetModel, resolvePhaseChain } from '../models/types.js';
import type { TaskComplexity } from '../models/types.js';
import { classifyComplexity, tierToRouting } from '../models/complexity.js';
import { promptSelectionFromConfig } from '../self-tuning/prompt-variants.js';
import { authorAcceptanceGate } from '../delivery/self-gate.js';
import { applyPendingIntents } from '../delivery/pending-intents.js';
import { runAcceptanceGate } from '../delivery/acceptance-judge.js';
import { buildMissionAcceptanceGate, resolveAcceptanceVerdict } from '../delivery/mission-acceptance.js';
import { createSpecRegistry } from '../delivery/spec-registry.js';
import type { AcceptanceGate } from '../delivery/convergence-loop.js';
import { guardAgainstOwnerExit } from '../delivery/orphan-guard.js';

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
  /**
   * Anti-vacuous floor (P0, 2026-07-13): every REQUIRED project gate passed a
   * pre-run baseline probe. Gates that cannot fail are not a convergence
   * target — "delivered" must mean "something that was red is now green" —
   * so a mission self-gate is engaged exactly as if no gates were detected.
   */
  baselineAllGreen?: boolean;
}): { acceptancePrimary: boolean; needsSelfGate: boolean; noGatesError: boolean } {
  const acceptancePrimary = opts.hasAcceptance && opts.noRealGates && !opts.forceSelfGate;
  const needsSelfGate =
    opts.selfGateAllowed &&
    !acceptancePrimary &&
    (opts.noRealGates || opts.forceSelfGate || opts.baselineAllGreen === true);
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
 * When the model fails to author a self-gate, is that fatal?
 *
 * Only if the run would then have NO convergence target at all. Getting this
 * wrong in the permissive direction re-opens the false-green door the
 * anti-vacuous floor exists to close: with no self-gate rung and no acceptance
 * judge, a repo whose gates were already green is "delivered" having written
 * nothing.
 *
 * Two traps this predicate exists to avoid, both of which `!options.acceptance`
 * alone walks straight into:
 *
 *  - `--acceptance` is on but the judge is SKIPPED for a simple task
 *    (shouldSkipAcceptanceJudge), so no gate object is ever built.
 *  - max fidelity is treated as a standing blocker. It is not: the vision review
 *    lives INSIDE the acceptance gate, so if that gate was never built there is
 *    nothing to block, and visionAcceptanceFeedback additionally fails open on
 *    five separate conditions (no vision model, no screenshots, non-final epic,
 *    any thrown error, fidelity not max).
 *
 * So the only thing that makes a missing self-gate survivable is a judge that
 * will actually run — plus at least one real rung to converge against.
 */
export function selfGateFailureIsFatal(opts: {
  acceptanceEnabled: boolean;
  judgeSkipped: boolean;
}): boolean {
  // A judge that will actually run is the only substitute. Surviving rungs do not
  // rescue this: needsSelfGate is raised precisely when the objective gates are
  // all GREEN (no convergence pressure) or absent entirely (the loop throws), so
  // in both cases a missing self-gate with no judge leaves nothing to satisfy.
  return !(opts.acceptanceEnabled && !opts.judgeSkipped);
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

/**
 * P6 gate thickening. A thin visible gate set (≤1 required rung) is a weak
 * convergence target, so deliver enables the acceptance judge to thicken it.
 * PURE — unit-tested. Returns true to turn the judge ON for thickening.
 *
 * `acceptanceDisabled` (UAP_DELIVER_ACCEPTANCE=0) is an explicit operator "no
 * judge" and MUST win: thickening previously ignored it and silently re-enabled
 * the judge, so an operator who disabled it to stop the loop overshooting
 * objective-green kept overshooting anyway (octopus, 2026-07-23).
 */
export function decideThickenWithAcceptance(opts: {
  noRealGates: boolean;
  requiredRungCount: number;
  thickenDisabled: boolean;
  acceptanceDisabled: boolean;
  acceptanceAlreadyDecided: boolean;
}): boolean {
  if (opts.acceptanceAlreadyDecided) return false; // --acceptance / --no-... already set it
  if (opts.noRealGates) return false;
  if (opts.thickenDisabled) return false; // UAP_DELIVER_THICKEN=0
  if (opts.acceptanceDisabled) return false; // UAP_DELIVER_ACCEPTANCE=0 — explicit opt-out wins
  return opts.requiredRungCount <= 1;
}

/**
 * --keep-best best-intermediate scoring. Score a turn on the fast-tier gates it
 * already ran (from its IterationRecord gateResults), matching the metric the
 * baseline snapshot used, WITHOUT re-running any gate. Returns null when no
 * fast-tier gate ran this turn (not scoreable → do not advance the snapshot).
 * PURE — unit-tested.
 */
/**
 * Never-regress resolution — DEFAULT ON.
 *
 * This was opt-in, and the cost of that default was measured: across three
 * Octopus Invaders runs (2026-08-01) a run reached a fully working, playable
 * game at turn 2, then a later turn fixed an unrelated TypeError and in the
 * same whole-file rewrite deleted the line that started the program.
 * `captureBestKeep` would have snapshotted that peak and rolled back to it —
 * but it is armed only by this flag, so it never ran and the working artifact
 * was lost. A loop that applies turns in place without preserving its best
 * result is strictly worse than one that does; nobody wants the regressed end
 * state, they just did not know to ask for the flag.
 *
 * Safe as a default: snapshotTree is disk-backed (never RAM tmpfs), excludes
 * node_modules/target/.git, and is size-capped (UAP_SNAPSHOT_MAX_MB, default
 * 4096) — over the cap it degrades to "no rollback this run" with a warning
 * rather than failing the run.
 *
 * Opt out with `--no-keep-best` (commander sets keepBest=false) or
 * UAP_DELIVER_KEEP_BEST=0. Only an EXPLICIT false disables it: `undefined`
 * means "flag not passed", which is now on.
 */
export function resolveKeepBest(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (flag === false) return false;
  if (env.UAP_DELIVER_KEEP_BEST === '0') return false;
  return true;
}

export function bestKeepFastScore(
  gateResults: Array<{ id: string; passed: boolean }>,
  fastRungIds: Set<string>
): number | null {
  const fast = gateResults.filter((r) => fastRungIds.has(r.id));
  if (fast.length === 0) return null;
  return fast.filter((r) => r.passed).length / fast.length;
}

// Legacy export surface: test/cli/acceptance-verdict.test.ts (and any external
// consumer) imports the verdict fold from deliver.js — keep the re-export.
export { resolveAcceptanceVerdict } from '../delivery/mission-acceptance.js';
import { createAgenticExecutor, noopApplier, selectExecutorMode, lockContractFiles } from '../delivery/agentic-executor.js';
import { createRepairEscalation } from '../delivery/repair-escalation.js';
import { clearStop, isStopRequested, requestStop, loadRunState, newRunId, saveRunState, MAX_PERSISTED_PHASES } from '../delivery/run-state.js';
import type { DeliverRunState } from '../delivery/run-state.js';
import { planDeliveryPhases, shouldDecompose } from '../delivery/decompose.js';
import { initLedger, markItem } from '../delivery/completion-ledger.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';
import { resolveEscalateModelId } from '../delivery/repair-escalation.js';
import {
  createUserValidationRunner,
  resolveUserValidationMode,
  synthesizeUserValidationRung,
} from '../delivery/user-validation.js';
import { deriveUserPaths, fallbackWebManifest, loadUserPaths, mergeUserPaths, renderAcceptanceContract, USER_PATHS_FILE } from '../delivery/user-paths.js';
import { detectArtifactType } from '../delivery/execution-gate.js';

/** Raw .uap.json reader usable before the main cfgRawEarly declaration. */
function cfgRawEarlyForUvFactory(projectRoot: string): () => Record<string, unknown> {
  return () => {
    try {
      return (loadUapConfigRaw(projectRoot) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
}
import { resolveSessionTokenBudget, sessionWorkingBudget, discoverModelContextWindow } from '../delivery/context-budget.js';
import { preflightProject, formatPreflightFailure } from '../delivery/project-preflight.js';
import { awaitInFlightDeliver } from '../delivery/await-run.js';

/**
 * Follow-mode budget when the caller names none, and its ceiling (seconds).
 *
 * LONG on purpose. This default serves the shell and CI caller, who has no
 * request timeout and wants `uap deliver --await-run` to block until the mission
 * is done. The MCP layer — the only one that knows its caller gives up after
 * about a minute — always passes an explicit short budget instead of relying on
 * this (see FOLLOW_CLIENT_POLL_SEC).
 *
 * Making THIS short was the first attempt, and it was the wrong layer: it capped
 * every terminal and CI caller at 45s to fix a limit that only one client has.
 */
const AWAIT_DEFAULT_BUDGET_SEC = 900;
const AWAIT_MAX_BUDGET_SEC = 14_400;
import { resolveFidelity } from '../delivery/fidelity.js';
import { installRunExitRecorder } from '../delivery/run-exit.js';
import {
  shouldDetach,
  relaunchDetached,
  isDetachedChild,
  canHostDetachLog,
  NO_DETACH_ENV,
} from './deliver-detach.js';
import type { LifecycleHintProvider } from '../delivery/decompose.js';
import type { DeliveryPhase } from '../delivery/decompose.js';
import { completeDeliveryTask, openDeliveryTask, recordDeliveryOutcome, recordOrchestratorTaskOutcome, reopenDeliveryTask } from '../delivery/task-sync.js';
import { autoMineHaloTraces, summarizeWeaknesses, weaknessGuidance, loadPersistedWeaknesses } from '../delivery/auto-mine.js';
import { createGitWorktreeProvider } from '../delivery/candidate-workspace.js';
import { createTaskWorkspaceManager, resolveParallelTasks } from '../delivery/task-workspace.js';
import { runOrchestratedMission as runOrchestratedMissionCore } from '../delivery/orchestrated-mission.js';
import { runCiReconverge } from '../delivery/ci-reconverge.js';
import { runPhasedMission as runPhasedMissionCore } from '../delivery/phased-mission.js';
import { changedFiles } from '../delivery/changed-files.js';
import { runEpicMission as runEpicMissionCore } from '../delivery/epic-mission.js';
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
import { detectRungs, mergeRedetectedRungs, runLadder, runTieredLadder, tierOf, TIER_ORDER, demoteBaselineFailures } from '../delivery/verifier-ladder.js';
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
  /** Follow the run already in flight instead of starting one (read-only wait). */
  awaitRun?: boolean;
  /** Seconds --await-run waits before reporting the run as still in flight. */
  awaitTimeout?: string;
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
  /** `--allow-noop`: permit success without any tree change (disables the
   * anti-no-op acceptance rail for missions that genuinely require none). */
  allowNoop?: boolean;
  /** `--pending [file]`: replay gate-recorded edit intents deterministically,
   * verify with the required gates, and exit (plan D1). */
  pending?: string | boolean;
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
function fail(message: string): never {
  console.error(chalk.red(message));
  process.exitCode = 2;
  throw new ExitError();
}

class ExitError extends Error {}

/**
 * Complexity-tier routing (P: per-task model selection). Returns the model id
 * to execute this task on, or null to leave the caller's default untouched.
 * PURE — unit-tested. Uses the unified complexity classifier (src/models/
 * complexity.ts) so `critical` is preserved end-to-end — the old
 * COMPLEXITY_TO_TIER bridge silently dropped it. Precedence is enforced by the
 * caller: an explicit --model always wins; this only fires when routing is
 * requested and no model was pinned.
 */
export function resolveTierModel(
  routingId: string | undefined,
  instruction: string
): { model: string; tier: TaskComplexity; preset: string } | null {
  const id = routingId ?? process.env.UAP_DELIVER_ROUTING;
  if (!id) return null;
  const preset = RoutingPresets[id];
  if (!preset) return null;
  const tier = tierToRouting(classifyComplexity({ instruction }).tier);
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
 * Whether a mission should be decomposed into phases (the precondition for
 * orchestration). Forced ON by any explicit operator intent — the `--orchestrate`
 * flag, `--decompose`, OR a persisted `.uap.json` deliver.orchestrate: "on"
 * (set via `uap orchestrator on`, meaning "orchestrate ALWAYS, not just when I
 * remember the flag"). Absent explicit intent, falls to the shouldDecompose()
 * heuristic (unless UAP_DELIVER_DECOMPOSE=0). Exported for tests.
 *
 * The cfgOrch clause fixes a real gap: orchestrate:"on" previously only fed
 * `orchestrateEnabled` (which orchestrates phases that ALREADY exist), but phases
 * only exist when decomposition runs — so config-on silently did nothing for any
 * mission the heuristic declined to decompose.
 */
export function resolveDecomposeWanted(opts: {
  orchestrateOption: boolean | undefined;
  decomposeOption: boolean | undefined;
  cfgOrch: unknown;
  envDecompose: string | undefined;
  heuristic: () => boolean;
}): boolean {
  if (opts.orchestrateOption === true) return true;
  if (opts.cfgOrch === 'on' || opts.cfgOrch === true) return true;
  if (opts.decomposeOption === true) return true;
  if (opts.decomposeOption === undefined && opts.envDecompose !== '0' && opts.heuristic()) return true;
  return false;
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

// ─── Deliver wedge detection (P0 reliability) ────────────────────────────────
// A deliver can wedge (alive PID, but stuck making no progress — e.g. a
// plan-check re-plan loop or a hung upstream). The lock alone can't tell a
// healthy long run from a wedged one, so the running deliver stamps a heartbeat
// on every iteration and the lock path reclaims a holder whose heartbeat has
// gone stale. Language-agnostic contract: `.uap/deliver.heartbeat` = one integer
// (unix epoch seconds), rewritten each turn; also read by deliver_autoroute.py.

// Legacy export surface. The heartbeat helpers moved to delivery/heartbeat.ts so
// await-run.ts can use them without importing this module (which imports IT — a
// cycle). They are re-exported below ONLY because existing callers and tests
// already address them through this path.
//
// @deprecated import from '../delivery/heartbeat.js' instead. Reaching a 10-byte
// file read through this module drags the whole deliver graph — chalk, spawn,
// the orchestrator, the epic controller — into the importer, and back into the
// cycle-prone hub the extraction just escaped. `heartbeatAgeS` is deliberately
// NOT re-exported: it is new here, so it has no back-compat claim and gets
// exactly one import path from the start.
import {
  wedgeTimeoutS,
  updateDeliverHeartbeat,
  readDeliverHeartbeat,
  isDeliverHolderWedged,
} from '../delivery/heartbeat.js';
export {
  DEFAULT_WEDGE_TIMEOUT_S,
  wedgeTimeoutS,
  updateDeliverHeartbeat,
  readDeliverHeartbeat,
  isDeliverHolderWedged,
} from '../delivery/heartbeat.js';

/**
 * True when the lock was ABANDONED: old, and its holder never stamped a
 * heartbeat at all.
 *
 * PID-liveness alone is not a safe test of "is the holder still running",
 * because PIDs are reused. This box: pid_max=4194304, and the counter had
 * climbed to 4142055 after twelve days of uptime — 98.7% of the way to wrapping,
 * after which low PIDs get reissued. A lock left by a dead deliver names a PID
 * that some unrelated process will eventually own; `pidAlive` then says true,
 * and with no heartbeat `isDeliverHolderWedged` says false, so every subsequent
 * deliver in that project defers forever with "a deliver run is already in
 * progress". Nothing recovers it: the wedge path needs a heartbeat that a dead
 * holder never wrote. Found live with an eleven-day-old lock (pid 998109) still
 * sitting in this repo.
 *
 * A real holder stamps a heartbeat the instant it takes the lock — see
 * acquireDeliverLock — so "no heartbeat at all, and the lock is older than the
 * wedge timeout" cannot describe a live run. The age test is what keeps a
 * just-starting holder safe in the window before its first stamp.
 *
 * Deliberately NOT done by reading /proc/<pid> start times: that is Linux-only,
 * and the portable rule already closes the hole.
 */
export function isDeliverLockAbandoned(
  projectRoot: string,
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  if (readDeliverHeartbeat(projectRoot) !== null) return false;
  const lockPath = join(projectRoot, '.uap', 'deliver.lock');
  let writtenS: number;
  try {
    // Prefer the timestamp INSIDE the lock (`<pid>|<iso>`); it travels with the
    // content, where mtime can be reset by a copy, restore, or touch.
    const iso = (readFileSync(lockPath, 'utf8').split('|')[1] || '').trim();
    const parsed = Date.parse(iso);
    writtenS = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(statSync(lockPath).mtimeMs / 1000);
  } catch {
    return false; // unreadable: leave the existing behaviour alone
  }
  // A clock skew that puts the lock in the future must not read as ancient.
  return nowS - writtenS > wedgeTimeoutS();
}

/**
 * Project-level deliver concurrency lock. Prevents a fan-out where an impatient
 * caller (e.g. a model that launched `uap deliver` for some work, didn't wait
 * for the slow run, and relaunched a reworded version) spawns many concurrent
 * deliver runs for the same project — each decomposing into the same epics and
 * burning tokens/GPU in parallel. Returns a release() thunk, or null when
 * another live deliver already holds the lock (the caller then exits cleanly).
 * Stale locks (dead PID) are reclaimed. Off-switch: UAP_DELIVER_NO_LOCK=1.
 */
export function acquireDeliverLock(projectRoot: string): (() => void) | null {
  if (process.env.UAP_DELIVER_NO_LOCK === '1') return () => {};
  const dir = join(projectRoot, '.uap');
  const lockPath = join(dir, 'deliver.lock');
  const pidAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    mkdirSync(dir, { recursive: true });
    // Reclaim a stale lock (holder no longer alive).
    if (existsSync(lockPath)) {
      const held = Number((readFileSync(lockPath, 'utf8').split('|')[0] || '').trim());
      // Defer only to a live holder that is NOT wedged and NOT abandoned.
      // Abandonment is checked because `pidAlive` cannot distinguish the real
      // holder from an unrelated process that inherited a recycled PID.
      if (
        held &&
        held !== process.pid &&
        pidAlive(held) &&
        !isDeliverHolderWedged(projectRoot) &&
        !isDeliverLockAbandoned(projectRoot)
      ) {
        return null;
      }
      try { rmSync(lockPath); } catch { /* racing reclaim */ }
    }
    // Atomic create-exclusive; if we lose the race, another deliver won it.
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch {
      return null;
    }
    writeSync(fd, `${process.pid}|${new Date().toISOString()}`);
    closeSync(fd);
    // Stamp a fresh heartbeat immediately so this brand-new holder is never
    // classified as wedged in the window before its first iteration (and so a
    // reclaim overwrites the previous holder's stale heartbeat).
    updateDeliverHeartbeat(projectRoot);
  } catch {
    // Lock machinery unavailable — fail OPEN (don't block a legitimate run).
    return () => {};
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath)) {
        const held = Number((readFileSync(lockPath, 'utf8').split('|')[0] || '').trim());
        if (held === process.pid) rmSync(lockPath);
      }
    } catch { /* best-effort */ }
  };
  process.once('exit', release);
  return release;
}

export async function deliverCommand(instruction: string, options: DeliverOptions): Promise<void> {
  // Stop if the session that ordered this run exits. Detaching (below) is
  // deliberate — a mission must outlive the agent's bash tool call — but it must
  // not outlive the SESSION: orphaned runs held both model slots for over an
  // hour on 2026-07-29. No-op unless a detached child inherited an owner pid.
  guardAgainstOwnerExit();

  // A mission must outlive the tool call that started it. An agent's bash tool
  // is a short-lived, process-group-killed container; a model that runs
  // `uap deliver` from it was spawning a long mission inside a short one, and
  // the mission died wherever it happened to be when the call ended. Re-launch
  // into our own session first, then mirror the output (see deliver-detach.ts).
  // Follow-mode: attach to the in-flight run and report it. Deliberately ahead of
  // the detach decision — this is a read-only wait, so backgrounding it would
  // hand the caller a detach banner instead of the answer it asked for.
  if (options.awaitRun) {
    // Refuse rather than silently drop: follow short-circuits everything, so
    // `--await-run --dry-run` would return a status report to someone who asked
    // for a plan, and `--await-run --resume X` would ignore the resume.
    const conflict = options.dryRun ? '--dry-run' : options.resume ? '--resume' : '';
    if (conflict) {
      const msg = `--await-run cannot be combined with ${conflict}: following watches a run, it does not plan or continue one.`;
      console.error(chalk.red(msg));
      if (options.json) console.log(JSON.stringify({ success: false, error: msg }, null, 2));
      process.exitCode = 2;
      return;
    }
    const followRoot = resolve(options.projectRoot ?? process.cwd());
    // The caller sets this just under its OWN tool timeout, so follow-mode can
    // return "still running" as a result rather than being killed mid-wait —
    // being killed is what the caller already cannot distinguish from failure.
    const rawBudget = Number(options.awaitTimeout ?? 0);
    const budgetSec =
      Number.isFinite(rawBudget) && rawBudget > 0
        ? Math.min(rawBudget, AWAIT_MAX_BUDGET_SEC)
        : AWAIT_DEFAULT_BUDGET_SEC;
    const budgetMs = Math.max(1, budgetSec) * 1000;
    let lastTickBucket = 0;
    const outcome = await awaitInFlightDeliver(followRoot, {
      timeoutMs: budgetMs,
      onTick: (elapsed, pid) => {
        // Bucketed rather than modulo-tested: `elapsed % 15000 < pollMs` matches
        // twice whenever the poll phase aligns with the interval.
        const bucket = Math.floor(elapsed / 15000);
        if (!options.json && bucket > lastTickBucket) {
          lastTickBucket = bucket;
          console.log(chalk.dim(`  …following deliver (pid ${pid}) — ${Math.round(elapsed / 1000)}s`));
        }
      },
    });
    console.log(
      outcome.followed ? chalk.green(`✓ ${outcome.reason}`) : chalk.yellow(`↩ ${outcome.reason}`)
    );
    console.log(chalk.dim(`  ${outcome.nextStep}`));
    // `delivered`, not `followed`: watching a mission finish and the mission
    // SUCCEEDING are different facts. The MCP layer prefers this field over the
    // exit code, so collapsing them reported a failed mission as ok:true — the
    // same class of lie the exit-code comment below forbids.
    if (options.json) console.log(JSON.stringify({ success: outcome.delivered, ...outcome }, null, 2));
    // Exit code mirrors the FOLLOWED RUN, not the act of following: a caller that
    // shell-chains on this wants the mission's verdict, and reporting 0 for a
    // failed mission would be the same class of lie as emitting no JSON at all.
    // "nothing was running" gets its own code, because for a shell caller that is
    // neither success nor failure — it means "go ahead and launch".
    // Distinct codes, because a shell caller chains on these and three of the
    // four outcomes are not failures:
    //   0 delivered · 1 the mission ended badly · 3 nothing was running · 4 still
    //   running — the wait gave up, the mission did not
    // 4 deliberately does NOT mean "healthy": a wedged run is still running and
    // still exits 4. Health is reported in `progress.health`, derived from the
    // heartbeat, precisely because it cannot be inferred from the exit code.
    // Sharing 4 with 1 made `uap deliver --await-run && ./next` report failure for
    // a perfectly healthy run, and at a short poll budget that is the COMMON case.
    process.exitCode = outcome.delivered
      ? 0
      : outcome.nothingInFlight
        ? 3
        : outcome.timedOut
          ? 4
          : 1;
    return;
  }

  const projectRootForDetach = resolve(options.projectRoot ?? process.cwd());
  const decision = shouldDetach({
    alreadyDetached: isDetachedChild(),
    noDetach: process.env[NO_DETACH_ENV] === '1',
    isTTY: Boolean(process.stdout.isTTY),
    dryRun: Boolean(options.dryRun),
  });
  if (decision.detach && canHostDetachLog(projectRootForDetach)) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    process.exitCode = await relaunchDetached(projectRootForDetach, stamp);
    return;
  }

  try {
    await runDeliver(instruction, options);
  } catch (err) {
    if (err instanceof ExitError) return;
    throw err;
  }
}

async function runDeliver(instruction: string, options: DeliverOptions): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  // P1 (plan D1): --pending replays gate-recorded edit intents exactly, then
  // verifies with the required gates — the sanctioned path for a blocked
  // direct edit, with zero model improvisation. Runs BEFORE preflight: it
  // never creates a worktree, so the git-repo requirement does not apply.
  if (options.pending !== undefined && options.pending !== false) {
    const pendingFile = typeof options.pending === 'string' ? options.pending : undefined;
    const res = applyPendingIntents(projectRoot, pendingFile);
    for (const a of res.applied) console.log(chalk.green(`  ✓ applied ${a.kind}: ${a.file}`));
    for (const s of res.skipped) console.log(chalk.yellow(`  ⚠ skipped ${s.file}: ${s.reason}`));
    if (res.applied.length === 0) {
      fail(`No pending intents applied${pendingFile ? ` for ${pendingFile}` : ''} (${res.skipped.length} skipped).`);
    }
    const rungs = detectRungs(projectRoot).filter((r) => r.required && tierOf(r) === 'fast');
    if (rungs.length > 0) {
      console.log(chalk.cyan(`⚖ verifying ${res.applied.length} applied intent(s) against ${rungs.length} required fast gate(s)…`));
      const ladder = runLadder(rungs, projectRoot);
      if (!ladder.passed) {
        fail(`Applied intents but the required gates FAIL:\n${ladder.feedback}`);
      }
      console.log(chalk.green('  ✓ gates pass'));
    } else {
      console.log(chalk.yellow('  (no required fast gates detected — applied without verification)'));
    }
    return;
  }

  // Preflight: refuse to start in a project that structurally cannot deliver
  // (chiefly: not a git repo — the candidate workspace is worktree-based, so
  // deliver/epics/orchestration are all dead and the mission would burn its
  // whole budget making no progress, silently). Also self-heals the always-on
  // orchestrate/epics posture when a fresh scaffold left it unset.
  // A --dry-run only plans: it never creates a worktree, so the git requirement
  // does not apply to it and refusing would be over-strict. It still gets its
  // config posture healed.
  const preflight = preflightProject(projectRoot);
  for (const h of preflight.healed) console.log(chalk.dim(`  preflight: ${h}`));
  if (!preflight.ok && !options.dryRun) {
    console.error(chalk.red(formatPreflightFailure(preflight)));
    // Same --json contract as the duplicate-launch guard below: an exit that
    // prints only prose leaves a `--json` caller parsing nothing, and the MCP
    // tool turns "no JSON" into "could not parse deliver output" — a message
    // about the harness rather than about the project, which is the opposite of
    // actionable when the real answer is one `git init` away.
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            success: false,
            preflightFailed: true,
            projectRoot,
            blockers: preflight.blockers,
            nextStep:
              'Fix the project setup listed in `blockers` before delivering; re-running unchanged will fail the same way.',
          },
          null,
          2
        )
      );
    }
    process.exitCode = 1;
    throw new ExitError();
  }

  // Concurrency guard: only one deliver runs per project at a time. A dry-run
  // plans nothing and a --resume continues the SAME mission, so both skip the
  // lock; a fresh run that finds a live holder exits cleanly as a duplicate
  // (this is the backstop against a caller fan-out — see acquireDeliverLock).
  let releaseLock: (() => void) | null = null;
  if (!options.dryRun && !options.resume) {
    releaseLock = acquireDeliverLock(projectRoot);
    if (releaseLock === null) {
      let holder = '';
      try {
        holder = stripControl(readFileSync(join(projectRoot, '.uap', 'deliver.lock'), 'utf8').split('|')[0]);
      } catch { /* gone already */ }
      // Validated, not merely trimmed: this value is read from a file any local
      // process can write, and it ends up inside the instruction text the model
      // acts on. A lock file containing newlines and prose would otherwise become
      // tool-result guidance. It is always a pid or it is not forwarded.
      const holderRaw = holder.trim();
      const holderPid = /^\d{1,10}$/.test(holderRaw) ? holderRaw : '';
      console.log(
        chalk.yellow(
          `↩ deliver already running for this project${holderPid ? ` (pid ${holderPid})` : ''} — ` +
            `skipping this duplicate launch. Follow it with \`uap deliver --await-run\` (waits and reports; ` +
            `from a tool call it returns within about a minute — "still running" is an answer, not a failure, ` +
            `so just call it again. It starts nothing.) ` +
            `starts nothing). Do NOT use --resume on a live run: resume CONTINUES a mission and would start a ` +
            `second copy of this one. (override: UAP_DELIVER_NO_LOCK=1)`
        )
      );
      // --json is a CONTRACT: every exit must emit a parseable result. This path
      // used to print the yellow line above and return, leaving a caller that ran
      // `deliver --json` with a stdout containing no JSON at all.
      //
      // The MCP deliver tool is exactly such a caller, and its parser turns "no
      // JSON" into `error: could not parse deliver output`. Observed live
      // (opencode, 2026-07-30): the client's own tool timeout fired while the real
      // mission continued detached, the model called deliver again, hit this
      // guard, and was told its output could not be parsed. It then went looking
      // for a delivery-enforcement override to force its way through — reaching
      // for a gate switch because the harness never told it the plain truth, which
      // was that its own mission was already running and it only had to wait.
      // `alreadyRunning` states that in the one field the caller actually reads.
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: false,
              alreadyRunning: true,
              ...(holderPid ? { holderPid } : {}),
              projectRoot,
              reason:
                'A deliver run is already in progress for this project; this duplicate launch was skipped.',
              nextStep:
                'The mission you asked for is ALREADY RUNNING — nothing is wrong and nothing is needed from you. ' +
                'Follow it instead: call deliver again with follow:true (or `uap deliver --await-run` from a ' +
                'shell). It returns within about a minute; if it says STILL RUNNING that is not a failure — ' +
                'call it again to keep waiting. Do NOT start another ' +
                'run, do NOT pass resume (resume CONTINUES a run rather than following it, and would start a ' +
                'second copy of this live one), and do NOT change any gate or enforcement setting.',
            },
            null,
            2
          )
        );
      }
      return;
    }
  }
  // The lock is released via acquireDeliverLock's process-exit handler (the
  // deliver CLI is a one-shot process), and explicitly on early returns below.

  // ── Wedge handling (P0 reliability) ─────────────────────────────────────
  // A stuck deliver (e.g. a plan-check re-plan loop) no longer blocks future
  // runs: the heartbeat is refreshed on every iteration (see the loop hook
  // below) and acquireDeliverLock PASSIVELY reclaims a holder whose heartbeat
  // has gone stale past the wedge timeout. We deliberately do NOT self-abort via
  // process.exit here — an abrupt teardown skips snapshot/worktree disposal
  // (re-opening the known tmpfs-leak class), and a merely-slow turn must never
  // kill a healthy run. Passive reclaim frees the lock without either hazard.

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
  // Verification RAILS are independent of the optimization AIDS (P0,
  // 2026-07-13): --no-auto / explicit aid flags stand down exploration,
  // critic and ideation, but must not silently drop the acceptance judge —
  // without it, a gates-green no-op run reads as delivered. When the
  // auto-planner did not run, acceptance defaults ON; opt out explicitly
  // with UAP_DELIVER_ACCEPTANCE=0.
  if (!autoPlan && options.acceptance === undefined && process.env.UAP_DELIVER_ACCEPTANCE !== '0') {
    options.acceptance = true;
    if (!options.dryRun) {
      console.log(chalk.cyan('⚖ acceptance judge on (verification rail; UAP_DELIVER_ACCEPTANCE=0 to disable)'));
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
  // UAP_DELIVER_ACCEPTANCE=0 is an explicit "no acceptance judge" and MUST win
  // here too: thickening silently re-enabling the judge is exactly what let an
  // operator who set ACCEPTANCE=0 (to stop the loop overshooting objective-green)
  // keep overshooting — the disable was quietly overridden (octopus, 2026-07-23).
  if (
    decideThickenWithAcceptance({
      noRealGates,
      requiredRungCount: rungs.filter((r) => r.required).length,
      thickenDisabled: process.env.UAP_DELIVER_THICKEN === '0',
      acceptanceDisabled: process.env.UAP_DELIVER_ACCEPTANCE === '0',
      acceptanceAlreadyDecided: options.acceptance !== undefined,
    })
  ) {
    options.acceptance = true;
    if (!options.dryRun) {
      console.log(
        chalk.cyan('⚖ thin gate set (≤1 required rung) — acceptance judge enabled to thicken the target')
      );
    }
  }

  // Anti-vacuous floor (P0, 2026-07-13 incident): probe the REQUIRED rungs
  // once before choosing the convergence target. If everything is already
  // green, gate-satisfaction cannot measure this mission — a run on a
  // gates-green repo would false-green as a no-op (observed live: a 6-file
  // C++ mission "delivered" after writing nothing, because the only detected
  // gates were unrelated npm web gates). UAP_DELIVER_VACUOUS_FLOOR=0 opts out.
  let baselineAllGreen = false;
  if (
    !noRealGates &&
    options.forceSelfGate !== true &&
    selfGateAllowed &&
    process.env.UAP_DELIVER_VACUOUS_FLOOR !== '0' &&
    !options.dryRun
  ) {
    try {
      const requiredRungs = rungs.filter((r) => r.required);
      baselineAllGreen = requiredRungs.length > 0 && runLadder(requiredRungs, projectRoot).passed;
    } catch {
      baselineAllGreen = false; // probe is best-effort; never blocks a run
    }
    if (baselineAllGreen) {
      console.log(
        chalk.cyan(
          '⚖ anti-vacuous floor: all required project gates are ALREADY green — authoring a mission self-gate so success requires real, verified change'
        )
      );
    }
  }

  const { acceptancePrimary, needsSelfGate, noGatesError } = decideGateStrategy({
    hasAcceptance: Boolean(options.acceptance),
    noRealGates,
    forceSelfGate: options.forceSelfGate === true,
    selfGateAllowed,
    baselineAllGreen,
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

  const cfgRawEarlyForUv = cfgRawEarlyForUvFactory(projectRoot);
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


  // User-path validation: the terminal 'final'-tier rung. The delivered
  // artifact must pass its critical user journeys through the REAL client
  // (headless browser / HTTP / built CLI) before DELIVERED. ON BY DEFAULT
  // (delivery.userValidation: block); UAP_USER_VALIDATION=0 downgrades to
  // advisory for one run and is self-protect-blocked from persisting.
  const userValidationMode = resolveUserValidationMode(
    (cfgRawEarlyForUv()?.delivery as Record<string, unknown> | undefined)?.userValidation
  );
  if (userValidationMode !== 'off' && !options.dryRun) {
    const uvRung = synthesizeUserValidationRung(userValidationMode);
    if (uvRung && !rungs.some((r) => r.id === uvRung.id)) {
      rungs.push(uvRung);
      console.log(
        chalk.cyan(
          `👤 user-validation: ${userValidationMode} — critical user paths run through the real client as the final gate`
        )
      );
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
      escalateModel: options.escalate
        ? (resolveEscalateModelId(
            options.escalateModel,
            process.env,
            (() => { try { return loadUapConfigRaw(projectRoot) ?? {}; } catch { return {}; } })()
          ) ?? null)
        : null,
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
  const cfgEscalateModel = resolveEscalateModelId(
    options.escalateModel,
    process.env,
    (() => { try { return loadUapConfigRaw(projectRoot) ?? {}; } catch { return {}; } })()
  );
  let evaluatorPresetId = resolveEvaluatorPreset({
    evaluatorModel: options.evaluatorModel,
    generatorPreset: presetId,
    envEvaluator: process.env.UAP_DELIVER_EVALUATOR_MODEL ?? cfgEscalateModel,
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
  // Verification provenance (S1 — Principle 3: "the model cannot verify itself").
  // Deliver must never let the generator be the SOLE grader of its own output.
  const allowSelfJudge =
    process.env.UAP_DELIVER_ALLOW_SELF_JUDGE === '1' ||
    (() => {
      try {
        const c = loadUapConfigRaw(projectRoot) as { recipes?: { allowSelfJudge?: boolean } } | null;
        return c?.recipes?.allowSelfJudge === true;
      } catch {
        return false;
      }
    })();
  // Q3: when a routing preset is active, prefer ITS review-phase model as the
  // distinct judge (compose S1 verification with the S3 per-phase matrix) instead
  // of the hardcoded haiku default — the preset's designated reviewer IS the
  // Generator≠Evaluator choice. resolveJudgePlan still swaps to the alt judge if
  // this collides with the generator, and only uses it on the auto-distinct path.
  const routingIdForJudge = options.routing ?? process.env.UAP_DELIVER_ROUTING;
  const presetForJudge = routingIdForJudge ? RoutingPresets[routingIdForJudge] : undefined;
  const reviewJudgeId = presetForJudge
    ? resolvePhaseChain(presetForJudge, {
        complexity: tierToRouting(classifyComplexity({ instruction }).tier),
        phase: 'review',
      })[0]
    : undefined;
  const judgePlan = resolveJudgePlan({
    evaluatorPresetId,
    generatorId: model.id,
    generatorProvider: ModelPresets[presetId as keyof typeof ModelPresets]?.provider,
    allowSelfJudge,
    distinctJudgeId: reviewJudgeId,
    hasPreset: (id) => Boolean(ModelPresets[id as keyof typeof ModelPresets]),
  });
  const judgeModelId = judgePlan.judgeModelId;
  const judgeDistinct = judgePlan.distinct;
  // Acceptance-scoped executors: they author the self-gate (verify.sh) and run
  // the acceptance JUDGE. They default to the generator and are the ONLY channels
  // the auto-distinct judge redirects — PLANNING (planDeliveryPhases /
  // deriveUserPaths on verdictExecutor) stays on the generator to avoid a
  // planning-quality regression (review C1).
  let gateAuthorExecutor: LoopExecutor = evaluatorExecutor;
  let acceptanceJudgeExecutor: LoopExecutor = verdictExecutor;
  if (judgePlan.reason === 'configured-evaluator') {
    // A distinct configured evaluator drives the evaluation channel AND planning
    // (pre-existing barbell behavior): reassign the globals.
    const evalModel = resolveModel(judgeModelId, options.evaluatorEndpoint);
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
    gateAuthorExecutor = evaluatorExecutor;
    acceptanceJudgeExecutor = verdictExecutor;
    if (!options.dryRun) {
      console.log(chalk.cyan(`⚖ generator≠evaluator: gen=${model.id} eval=${evalModel.id}`));
    }
  } else if (judgePlan.reason === 'auto-distinct-judge') {
    // No evaluator configured + cloud generator → run the acceptance JUDGE and
    // self-gate author on a cheap DISTINCT cloud model, WITHOUT hijacking the
    // planning executors (C1). The generator still plans; it no longer grades
    // itself.
    const jModel = resolveModel(judgeModelId);
    const jClient = new OpenAICompatClient();
    gateAuthorExecutor = async (prompt) =>
      (await jClient.complete(jModel, prompt, { temperature: 0 })).content;
    acceptanceJudgeExecutor = async (prompt) =>
      (await jClient.complete(jModel, prompt, { temperature: 0, jsonResponse: true })).content;
    if (!options.dryRun) {
      console.log(
        chalk.cyan(
          `⚖ generator≠evaluator (auto distinct acceptance judge): gen=${model.id} judge=${jModel.id}`
        )
      );
    }
  } else if (!judgeDistinct && !allowSelfJudge && !options.dryRun) {
    console.log(
      chalk.yellow(
        `⚠ verify: no distinct judge reachable (gen=${model.id} local/offline) — generator grades its own output`
      )
    );
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
  // Repair escalation (compile-error death-spiral breaker): when the error
  // count GROWS across turns, one narrow "make it compile" pass runs in a
  // fresh focused session — on the stronger model when configured, else the
  // same model (narrow scope + fresh context is most of the win). Default on
  // for the agentic executor; UAP_DELIVER_REPAIR_ESCALATION=0 disables.
  // Fail SOFT on an unknown configured escalate model (mirrors the evaluator
  // fallback): a stale .uap.json deliver.escalateModel is persisted state and
  // must degrade to the base model with a warning, not kill every run.
  const resolveEscalateOrWarn = (id: string | undefined, role: string) => {
    if (!id) return undefined;
    try {
      return resolveModel(id, undefined);
    } catch {
      console.log(
        chalk.yellow(`⚠ ${role}: escalate model '${id}' is not a known preset — continuing without it`)
      );
      return undefined;
    }
  };
  const repairModelId = cfgEscalateModel;
  const repairModel = resolveEscalateOrWarn(repairModelId, 'repair-escalation') ?? model;

  // Contracts-first epics: files an ACCEPTED contracts epic touched are locked
  // read-only for later epics. Mutable by reference — the epic controller
  // grows it between epics; the executor reads it live on every tool call.
  const contractLock = new Set<string>();
  // ORIGINAL-cased locked contract paths (contractLock stores lowercased match
  // keys, which are NOT valid FS paths on a case-sensitive filesystem — reading
  // those back would silently drop PascalCase files like Config.ts). P1 reads
  // these for verbatim injection.
  const contractPaths: string[] = [];
  const executor: LoopExecutor = agentic
    ? createAgenticExecutor(model, {
        projectRoot,
        endpoint: agenticEndpoint,
        onToolProgress: () => updateDeliverHeartbeat(projectRoot), // #2a per-tool-call heartbeat
        temperature,
        contextTokenBudget: sessionBudget,
        contractFiles: contractLock,
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

  // The repair pass reuses the SAME protections as the main agent (protected
  // tests, gate configs, contract lock) — a repair must fix code, not gates.
  const repairAgent: LoopExecutor | undefined = agentic
    ? createAgenticExecutor(repairModel, {
        projectRoot,
        endpoint: agenticEndpoint,
        onToolProgress: () => updateDeliverHeartbeat(projectRoot), // #2a per-tool-call heartbeat
        temperature: 0.2,
        contextTokenBudget: sessionBudget,
        contractFiles: contractLock,
        protectedFiles:
          options.protectTests !== false ? snapshotProtection(projectRoot).protectedFiles : new Set<string>(),
        protectGateConfigs: options.protectTests !== false,
        allowBash: options.allowBash === true || process.env.UAP_DELIVER_ALLOW_BASH === '1',
        onEvent: (e) =>
          console.log(
            chalk.dim(`    [repair r${e.round} ${e.kind}${e.tool ? `:${e.tool}` : ''}] ${e.detail ?? ''}`)
          ),
      })
    : undefined;

  // Self-authored acceptance gate: give deliver a real convergence target when
  // the project exposes none. The gate must FAIL on the current unsolved repo
  // (enforced in authorAcceptanceGate) so turn 1 cannot trivially pass.
  if (needsSelfGate) {
    console.log(chalk.cyan('⚖ self-gate: authoring a task-specific acceptance check…'));
    // Author the gate with the blind executor — it is a single-shot script
    // write, not a task to solve agentically.
    const sg = await authorAcceptanceGate({ instruction, projectRoot, executor: gateAuthorExecutor });
    for (const note of sg.notes) console.log(chalk.dim(`    ${note}`));
    if (!sg.rung) {
      // A failed self-gate is survivable only when a real acceptance judge will
      // run and become the convergence target. See selfGateFailureIsFatal — in
      // particular, max fidelity is NOT a substitute: the vision review lives
      // inside the acceptance gate, so when that gate is never built there is
      // nothing for it to block.
      if (
        selfGateFailureIsFatal({
          acceptanceEnabled: Boolean(options.acceptance),
          judgeSkipped: shouldSkipAcceptanceJudge({
            acceptanceEnabled: Boolean(options.acceptance),
            complexity: autoPlan?.complexity,
            acceptancePrimary,
          }),
        })
      ) {
        fail('Could not author an acceptance gate (model produced no runnable script).');
      }
      console.log(
        chalk.yellow(
          '  ⚠ self-gate authoring failed — the acceptance judge is the convergence target for this run.'
        )
      );
    } else {
      rungs.push(sg.rung);
      if (sg.vacuous) {
      // P0 hard-fail: a REQUIRED self-gate that passes on the unsolved repo
      // re-opens the false-green door — "delivered" would be meaningless.
      if (process.env.UAP_DELIVER_ALLOW_WEAK_SELF_GATE !== '1') {
        fail(
          'The self-gate is REQUIRED for this run (anti-vacuous floor) but stayed vacuous after retries — it passes on the unsolved repo. Add concrete, checkable ACCEPTANCE CRITERIA to the instruction, or set UAP_DELIVER_ALLOW_WEAK_SELF_GATE=1 to accept the risk.'
        );
      }
      console.log(
        chalk.yellow(
          '  ⚠ acceptance gate may be weak (could not force an initially-failing check); UAP_DELIVER_ALLOW_WEAK_SELF_GATE=1 — running multi-turn anyway.'
        )
      );
    } else {
      console.log(
        chalk.green('  ✓ acceptance gate authored — fails on the unsolved repo, a real convergence target.')
      );
      }
    }
  }

  // Phase 5: escalation ladder. Cheap strategies first (widen exploration →
  // enable critic) then, if a stronger model is configured, switch to it.
  const escalateModelId = cfgEscalateModel;
  let escalateExecutor: LoopExecutor | undefined;
  let escalateModelName: string | undefined;
  const strongModel = options.escalate ? resolveEscalateOrWarn(escalateModelId, 'escalation') : undefined;
  if (strongModel) {
    escalateModelName = strongModel.name;
    escalateExecutor = async (prompt) => (await client.complete(strongModel, prompt, { temperature })).content;
  } else if (options.escalate) {
    console.log(
      chalk.dim('  escalation: no stronger model configured ($UAP_ESCALATE_MODEL or .uap.json deliver.escalateModel) — cheap tiers only')
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
  // At max fidelity a test rung that ran ZERO tests is not a pass. `uap verify`
  // already enforced this, but DELIVER's own loop never did — so a mission could
  // still declare "delivered, all required gates pass" on a crate with no tests
  // at all, which is exactly what happened live. The gate that decides DONE is
  // this one; enforcing it only in verify left the real door open.
  const deliverFidelity = resolveFidelity(projectRoot);
  const tieredRunner: LadderRunFn = (r, root, opts) =>
    runTieredLadder(r, root, {
      ...opts,
      maxTier,
      requireTestsRan: deliverFidelity.max,
      runner: runLadder,
      deployDevRunner: runDeployDevLadder,
      userValidationRunner: createUserValidationRunner(),
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
  // Per-root specs, write evidence, and churn breakers live in the registry
  // (see src/delivery/spec-registry.ts for the parallel-dispatch semantics).
  const specs = createSpecRegistry({
    initialSpec: instruction,
    sharedRoot: projectRoot,
    flipLimit: Number(process.env.UAP_DELIVER_ACCEPTANCE_FLIP_LIMIT ?? 2),
  });
  // Judge composition (execution/visual gates in primary mode, per-root
  // spec resolution, churn breaker in secondary mode) lives in
  // src/delivery/mission-acceptance.ts; this stays a wiring decision.
  const acceptanceGate: AcceptanceGate | undefined = options.acceptance && !skipJudgeForSimple
    ? buildMissionAcceptanceGate({
        primary: acceptancePrimary,
        specs,
        judgeExecutor: acceptanceJudgeExecutor,
        note: (line) => console.log(chalk.yellow(`  ${line}`)),
      })
    : undefined;
  const seams = {
    ladderRunner: tieredRunner,
    // The agentic executor mutates the repo directly, so nothing remains for
    // the file-block applier to materialize.
    ...(agentic ? { applier: noopApplier } : {}),
    ...(acceptanceGate ? { acceptanceGate } : {}),
  };

  /** Compose the per-turn hooks with a FRESH escalation controller. */
  // --keep-best best-intermediate tracking. The convergence loop applies each
  // turn in place, so a run that PEAKS mid-way (e.g. 100% of gates) then
  // regresses would, under a plain end-vs-start comparison, roll back to the
  // START and discard the peak (octopus, 2026-07-23: a run hit 100% at turn 1,
  // regressed by turn 2, and the win was lost). This hook snapshots the tree
  // whenever a turn sets a new best fast-tier score and advances the rollback
  // target (regressSnapshot/baselineGateScore) to it, so the end-of-run
  // "restore if worse than baseline" logic restores the BEST turn, not the start.
  // Armed only when --keep-best took a baseline snapshot (see the keep-best block).
  let keepBestArmed = false;
  let bestFastRungIds = new Set<string>();
  const captureBestKeep = (record: IterationRecord, root: string): void => {
    if (!keepBestArmed || root !== projectRoot) return;
    // Score this turn on the SAME fast-tier metric as the baseline, reading the
    // gates the loop already ran this turn — no extra gate execution.
    const fastScore = bestKeepFastScore(record.gateResults, bestFastRungIds);
    if (fastScore === null || fastScore <= baselineGateScore) return; // not a new best
    const snap = snapshotTree(projectRoot);
    if (!snap.ok) return; // size-cap / failure: keep the previous best
    if (regressSnapshot) disposeSnapshot(regressSnapshot);
    regressSnapshot = snap.path;
    baselineGateScore = fastScore;
    if (!options.dryRun) {
      console.log(chalk.dim(`  no-regress: new best fast-gate score ${fastScore.toFixed(2)} — snapshot advanced`));
    }
  };

  const makeIterationHook = (evidenceRoot: string = projectRoot): ReturnType<typeof composeIterationHooks> => {
    const escalation = makeEscalation();
    const repair =
      repairAgent && process.env.UAP_DELIVER_REPAIR_ESCALATION !== '0'
        ? createRepairEscalation({
            originalExecutor: executor,
            onTrigger: (count, prevCount, turn) =>
              console.log(
                chalk.magenta(
                  `  ⛑ turn ${turn}: compile errors growing (${prevCount} → ${count}) — dispatching narrow repair pass` +
                    (repairModelId ? ` on ${repairModel.name}` : '')
                )
              ),
            runRepair: (errorTail, errorCount) =>
              repairAgent(
                `REPAIR MISSION — the build is broken and getting WORSE (${errorCount} compile errors, rising turn over turn). ` +
                  'Your ONLY goal: make the project compile / type-check again. Fix the errors below with MINIMAL diffs. ' +
                  'Do NOT add features, do NOT redesign, do NOT touch tests or configs — read the failing files, reconcile ' +
                  'the types/imports/signatures, and stop when the check passes.\n\nCURRENT ERRORS (tail):\n' +
                  errorTail
              ),
          })
        : undefined;
    return composeIterationHooks(
      (record) => printProgress(record),
      (_record) => {
        // P0 wedge watchdog: each iteration is real progress — refresh the
        // heartbeat so the watchdog + lock wedge-reclaim only fire on a true stall.
        updateDeliverHeartbeat(projectRoot);
        return undefined;
      },
      (record) => {
        // Feed the acceptance breaker's zero-diff guard.
        specs.recordWrites(evidenceRoot, record.filesApplied.length);
        return undefined;
      },
      (record) => haloTracer.onIteration(record),
      (record) => {
        // --keep-best: advance the rollback snapshot to this turn if it is a
        // new best (see captureBestKeep). Fail-soft — never steer the loop.
        captureBestKeep(record, evidenceRoot);
        return undefined;
      },
      repair ? (record) => repair.onIteration(record) : undefined,
      coordinator ? (record) => coordinator.onIteration(record) : undefined,
      escalation ? (record) => escalation.onIteration(record) : undefined
    );
  };

  const loopConfig: ConvergenceConfig = {
    projectRoot,
    maxTurns,
    rungs,
    // MIPRO (S8/3a): feed any tuner-selected prompt-fragment variants from
    // .uap.json to the prompt builder. Empty/absent → the byte-identical default.
    promptSelection: (() => {
      try {
        return promptSelectionFromConfig((loadUapConfigRaw(projectRoot) ?? {}) as Record<string, unknown>);
      } catch {
        return undefined;
      }
    })(),
    // The agentic executor mutates the repo directly (no-op applier), so
    // gates must run every turn regardless of applier file count.
    alwaysVerify: agentic ? true : undefined,
    // Anti-no-op acceptance rail (P0): success requires an actual tree
    // change unless the caller explicitly allows a no-op mission.
    requireDiffForAcceptance: options.allowNoop === true ? false : undefined,
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
  // #2b: safe cooperative wedge watchdog. If this run stops making tool progress
  // (heartbeat goes stale past the wedge timeout — #2a stamps it per tool call),
  // request a COOPERATIVE stop rather than process.exit: the convergence loop's
  // shouldStop picks it up at the next turn boundary and unwinds through the
  // normal finally (snapshot/worktree/lock cleanup all run). This lets a
  // genuinely-wedged run free its lock and exit instead of lingering as an idle
  // zombie, WITHOUT the abrupt-teardown resource leak the earlier process.exit
  // watchdog risked. Off-switch rides the existing UAP_DELIVER_NO_LOCK=1.
  let wedgeWatchdog: ReturnType<typeof setInterval> | null = null;
  if (!options.dryRun && process.env.UAP_DELIVER_NO_LOCK !== '1') {
    // Fresh baseline at arm time so the watchdog never fires on a run that just
    // started but hasn't stamped yet — critically on --resume (which does NOT
    // acquire the lock, so acquireDeliverLock's stamp never ran and the on-disk
    // heartbeat still holds the PRIOR interrupted run's timestamp).
    updateDeliverHeartbeat(projectRoot);
    const wedgeS = wedgeTimeoutS();
    wedgeWatchdog = setInterval(() => {
      if (isDeliverHolderWedged(projectRoot) && !isStopRequested(projectRoot, runId)) {
        console.error(
          chalk.yellow(
            `⏱ wedge watchdog: no tool progress for ${wedgeS}s — requesting a clean stop so the lock is released.`
          )
        );
        requestStop(projectRoot, runId);
      }
    }, Math.min(30_000, Math.max(1000, wedgeS * 1000)));
    wedgeWatchdog.unref();
    process.once('exit', () => { if (wedgeWatchdog) clearInterval(wedgeWatchdog); });
  }
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
  // self-gate. A resume re-enters the epic path ONLY when the interrupted
  // run was epic-kind: completed epics carry forward as prior summaries and
  // the mid-epic loop checkpoint is discarded (epics restart at the epic
  // boundary). Non-epic resumes stay on the cursor-honoring paths below.
  const cfgEpics = (cfgRaw.deliver as Record<string, unknown> | undefined)?.epics;
  const epicsEnabled =
    !needsSelfGate &&
    (!resumeState || resumeState.runnerKind === 'epic') &&
    options.epics !== false &&
    process.env.UAP_DELIVER_EPICS !== '0' &&
    cfgEpics !== false && cfgEpics !== 'off';
  const decomposeWanted =
    !needsSelfGate &&
    resolveDecomposeWanted({
      orchestrateOption: options.orchestrate,
      decomposeOption: options.decompose,
      cfgOrch,
      envDecompose: process.env.UAP_DELIVER_DECOMPOSE,
      heuristic: () => shouldDecompose(instruction, autoPlan?.complexity),
    });
  // Skipped when the epic path owns the mission: runEpicMission re-plans via
  // planEpics, so this call would burn an evaluator pass (+ thought
  // experiment) on a phases array the dispatch never uses. Kept for resume
  // and the --no-epics paths.
  if (!phases && decomposeWanted && !resumeState && !epicsEnabled) {
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
  // Derive the user-path manifest from the mission when the gate is on and the
  // repo has none yet (merge-append: user-curated entries are never
  // overwritten). Fail-soft — a planner miss means the gate reports
  // "no manifest" instead of blocking on derivation.
  if (userValidationMode !== 'off' && !options.dryRun && !loadUserPaths(projectRoot)) {
    const derived = await deriveUserPaths(instruction, verdictExecutor);
    if (derived && derived.paths.length > 0) {
      mergeUserPaths(projectRoot, derived);
      console.log(
        chalk.cyan(`👤 user-validation: derived ${derived.paths.length} critical user path(s) → ${USER_PATHS_FILE}`)
      );
    } else if (detectArtifactType(projectRoot) === 'web' || /\bcanvas\b|<canvas|\bhtml\b/i.test(instruction)) {
      // The terminal gate must never silently reduce to NA for a web artifact
      // just because the miner flaked (observed 3 of 5 live runs): install the
      // deterministic fallback journey — load + (canvas visible) + zero
      // console errors.
      const fb = fallbackWebManifest(instruction);
      mergeUserPaths(projectRoot, fb);
      console.log(
        chalk.yellow('👤 user-validation: miner produced no manifest — installed the deterministic fallback journey (load + no console errors)')
      );
    } else {
      console.log(chalk.dim('  user-validation: no manifest derived — gate will report NA until one exists'));
    }
  }
  // Surface the acceptance contract (the user-path journeys + required selectors)
  // to the executor on EVERY turn. The manifest is authored up front but was
  // otherwise invisible to the implementer, so a weak model built artifacts that
  // the real-client gate could not drive (e.g. a canvas-only UI with no DOM
  // handles) and then could not self-correct from the gate's selector-not-found
  // feedback. Injecting the contract closes the author→implement loop: the model
  // builds a complete, drivable artifact from turn 1. Fail-soft — an aid, never a
  // blocker.
  if (userValidationMode !== 'off') {
    try {
      const loaded = loadUserPaths(projectRoot);
      const contract = renderAcceptanceContract(loaded?.manifest ?? null);
      if (contract) {
        loopConfig.acceptanceContract = contract;
        console.log(
          chalk.dim('  user-validation: acceptance contract (journeys + required selectors) injected into the executor prompt')
        );
      }
    } catch {
      /* contract injection is a best-effort completeness aid */
    }
  }
  const runState: DeliverRunState = {
    runId,
    instruction,
    presetId,
    projectRoot,
    status: 'running',
    pid: process.pid,
    ppid: process.ppid,
    createdAt: resumeState?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpoint: resumeState?.checkpoint,
    phases,
    phaseIndex,
    phaseSummaries: [...phaseSummaries],
    // Resume progress fields must SURVIVE this fresh-literal save — omitting
    // them erases the interrupted run's accepted-work sets on disk before the
    // first new success re-persists them; a second interruption in that
    // window would redo everything into the anti-no-op wedge.
    ...(resumeState?.completedEpicIds ? { completedEpicIds: resumeState.completedEpicIds } : {}),
    ...(resumeState?.taskOutcomes ? { taskOutcomes: resumeState.taskOutcomes } : {}),
  };
  saveRunState(runState);
  // From here on the process records its own death (signal + parent pid). A run
  // that dies leaves status:'running' behind on purpose — that is what --resume
  // looks for — but nothing recorded HOW it died, so a mission killed by its
  // parent was indistinguishable from one still working.
  const disposeExitRecorder = installRunExitRecorder(projectRoot, runId);
  // Persist loop state after every turn so this run survives interruption.
  loopConfig.onCheckpoint = (cp) => {
    runState.checkpoint = cp;
    saveRunState(runState);
  };
  // Under max fidelity the vision aesthetic review is a BLOCKING release gate;
  // let the acceptance gate run (and feed vision findings) even when the ladder
  // is red on a synthetic anti-vacuous self-gate, so the model gets aesthetic
  // feedback instead of stalling. The gate re-checks operational + behavioral
  // itself before grading (mission-acceptance), preserving the required ordering.
  loopConfig.runAcceptanceDespiteLadder = deliverFidelity.max;
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
  // Epic-kind resumes never use runExecutor (fresh epic loops re-escalate on
  // their own) and discard the checkpoint at the dispatch — a re-bind message
  // here would falsely claim the escalation carried over.
  if (resumeCheckpoint?.modelEscalated && !epicsEnabled) {
    if (escalateExecutor && !agentic) {
      // Agentic runs keep their tool-loop executor: the blind escalation
      // executor pairs with the noop applier and would never touch the repo.
      runExecutor = escalateExecutor;
      console.log(chalk.magenta(`  ↑ resume: re-binding escalated model (${escalateModelName ?? 'stronger model'})`));
    } else if (!escalateExecutor) {
      console.log(
        chalk.yellow(
          '⚠ resume: the interrupted run had escalated to a stronger model, but none is configured here (--escalate-model / UAP_ESCALATE_MODEL / .uap.json deliver.escalateModel) — continuing on the base model'
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
  /**
   * Wire deliver's ambient context (loop config, executors, judge state, task
   * records, gates) into the extracted orchestrated-mission runner
   * (src/delivery/orchestrated-mission.ts). Shared by the top-level
   * orchestrated path and the epic controller's inner missions — and, because
   * the runner is seam-injected, the orchestrate() wiring is finally
   * unit-testable (the PR #516 inert-concurrency critical could not recur
   * unobserved).
   */
  const buildOrchestratedDeps = (
    missionText: string,
    taskPhases: DeliveryPhase[],
    parallelTasks: number,
    parentTaskId: string | undefined = missionTask?.id,
    // Resume wiring — supplied ONLY by the top-level orchestrated dispatch.
    // Epic-inner orchestration must never seed or clobber the mission-level
    // task-outcome resume state (each epic is its own fresh DAG).
    resume?: {
      initialDone: Array<{ id: string; summary: string; contract?: string }>;
      onProgress: (completed: Array<{ id: string; summary: string; contract?: string }>) => void;
      onPlanChange: (freshTasks: DeliveryPhase[]) => void;
    }
  ): Parameters<typeof runOrchestratedMissionCore>[0] => {
    const mergeProtected = new Set<string>(
      [
        ...(options.protectTests !== false
          ? [...snapshotProtection(projectRoot).protectedFiles, ...listGateConfigFiles(projectRoot)]
          : []),
        // Locked contract files are read-only for later epics; the merge
        // boundary re-checks them like the other protected surfaces instead
        // of trusting the in-worktree write_file guard transitively.
        ...contractLock,
      ].map((f) => f.toLowerCase())
    );
    return {
      instruction: missionText,
      projectRoot,
      tasks: taskPhases.map((ph) => ({
        id: ph.id,
        title: ph.title,
        goal: ph.goal,
        ...(ph.deps ? { deps: ph.deps } : {}),
      })),
      parallelTasks,
      contextBudgetChars: Number(process.env.UAP_DELIVER_CONTEXT_BUDGET ?? 6000),
      maxTasks: Number(process.env.UAP_DELIVER_MAX_TASKS ?? 40),
      workspaceManager: parallelTasks > 1 ? createTaskWorkspaceManager(projectRoot) : null,
      note: (line) =>
        console.log(
          line.startsWith('▶')
            ? chalk.bold(line)
            : line.includes('unavailable') || line.includes('conflicted')
              ? chalk.yellow(line)
              : line.includes('parallel tasks:') || line.includes('post-merge verification')
                ? chalk.cyan(line)
                : chalk.dim(line)
        ),
      ...(resume ? { initialDone: resume.initialDone, onProgress: resume.onProgress, onPlanChange: resume.onPlanChange } : {}),
      beginTaskSpec: (root, spec) => specs.begin(root, spec),
      // Task specs are strictly per-root: end() just drops the entry and the
      // root falls back to the shared (mission/phase/epic) spec — a later
      // watch-ci re-converge never sees a stale task prompt.
      endTaskSpec: (root) => specs.end(root),
      openTask: (title) => openDeliveryTask(title, projectRoot, parentTaskId),
      completeTask: (record, r) => completeDeliveryTask(record, r),
      // P3 — per-task memory retrieval: pull the few most relevant established
      // decisions/patterns/gotchas for THIS task's goal (a small semantic
      // query, not the full spec), so a fresh-context task reconstructs "what
      // am I building and why" from memory. Fail-soft → no design lines.
      retrieveDesign: async (task) => {
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
      publish: async (outcome, task) => {
        if (!outcome.success) return;
        await recordOrchestratorTaskOutcome(task.id, task.title, outcome.contract ?? outcome.summary, projectRoot);
      },
      isMergeBlocked: (f) => mergeProtected.has(f.toLowerCase()),
      verifyCombined: () => {
        // Redetection REASSIGNS the loop's local rungs and never mutates this
        // captured t0 array — re-merge (same pure policy the loop uses) or
        // the combined tree is verified against stale t0 gates only.
        let combinedRungs = rungs;
        try {
          combinedRungs = mergeRedetectedRungs(rungs, detectRungs(projectRoot), loopConfig.redetectFilter);
        } catch {
          // detection unavailable - verify against the t0 rungs
        }
        return Promise.resolve(tieredRunner(combinedRungs, projectRoot, {}));
      },
      runLoop: async ({ root, prompt, taskId, isolated }) => {
        // The agentic executor binds tools to a root at construction — give
        // an isolated task its own, with the same protections re-derived for
        // its tree. The blind executor is root-free (the per-task loop's
        // projectRoot directs the applier and gates).
        const exec =
          isolated && agentic
            ? createAgenticExecutor(model, {
                projectRoot: root,
                endpoint: agenticEndpoint,
                // #2a per-tool-call heartbeat. Stamp projectRoot (NOT the
                // per-task `root`): the deliver heartbeat is a project-global
                // wedge signal the watchdog + lock reclaim read at projectRoot;
                // stamping `root` here would leave projectRoot's advancing only
                // per-turn, re-opening the false-wedge window for isolated tasks.
                onToolProgress: () => updateDeliverHeartbeat(projectRoot),
                temperature,
                contextTokenBudget: sessionBudget,
                contractFiles: contractLock,
                protectedFiles:
                  options.protectTests !== false ? snapshotProtection(root).protectedFiles : new Set<string>(),
                protectGateConfigs: options.protectTests !== false,
                allowBash: options.allowBash === true || process.env.UAP_DELIVER_ALLOW_BASH === '1',
                onEvent: (e) =>
                  console.log(
                    chalk.dim(`    [${taskId} r${e.round} ${e.kind}${e.tool ? `:${e.tool}` : ''}] ${e.detail ?? ''}`)
                  ),
              })
            : executor;
        const loop = new ConvergenceLoop(
          {
            ...loopConfig,
            projectRoot: root,
            baselineCheck: false,
            resumeFrom: undefined,
            // Checkpoints describe THE mission tree, and the inherited
            // explorer's workspaceProvider is bound to the MAIN projectRoot —
            // neither may run inside an isolated task.
            ...(isolated ? { onCheckpoint: undefined, explorer: undefined } : {}),
            onIteration: makeIterationHook(root),
          },
          exec,
          seams
        );
        return loop.deliver(prompt);
      },
    };
  };
  const runOrchestratedMission = async (): Promise<DeliveryResult> => {
    const parallelTasks = resolveParallelTasks(
      (cfgRaw.deliver as Record<string, unknown> | undefined)?.parallelTasks
    );
    return runOrchestratedMissionCore(
      buildOrchestratedDeps(instruction, phases!, parallelTasks, undefined, {
        // Deterministic task-boundary resume: accepted tasks (with the
        // summaries/contracts dependents read) seed the scheduler's done set
        // and blackboard — completed work is skipped, never redone.
        initialDone: resumeState?.runnerKind === 'orchestrated' ? (resumeState.taskOutcomes ?? []) : [],
        onProgress: (completed) => {
          runState.taskOutcomes = completed;
          // Any mid-task loop checkpoint belongs to finished work now.
          runState.checkpoint = undefined;
          saveRunState(runState);
        },
        onPlanChange: (freshTasks) => {
          // Persist the GROWN DAG (original plan + P5 discoveries) so resume
          // schedules discovered-but-unfinished work too. Capped at the
          // sanitizer's ceiling — anything past it would be dropped on
          // reload anyway.
          runState.phases = [...(runState.phases ?? []), ...freshTasks].slice(0, MAX_PERSISTED_PHASES);
          saveRunState(runState);
        },
      })
    );
  };

  /**
   * Wire deliver's ambient context into the extracted phased runner
   * (src/delivery/phased-mission.ts) — the cursor-honoring resume path and
   * the fallback when orchestration is explicitly disabled.
   */
  const runPhasedMission = async (): Promise<DeliveryResult> => {
    const startCheckpoint = resumeCheckpoint;
    return runPhasedMissionCore({
      instruction,
      phases: phases!,
      startIndex: phaseIndex,
      initialSummaries: [...phaseSummaries],
      hasResumeCheckpoint: Boolean(startCheckpoint),
      resumedTurns: startCheckpoint?.history.length ?? 0,
      runPhaseLoop: async ({ prompt, resume }) => {
        const loop = new ConvergenceLoop(
          {
            ...loopConfig,
            baselineCheck: false,
            resumeFrom: resume ? startCheckpoint : undefined,
            onIteration: makeIterationHook(),
          },
          // The interrupted run may have escalated models; only the RESUMED
          // loop re-binds the escalated executor (historic behavior).
          resume && startCheckpoint ? runExecutor : executor,
          seams
        );
        if (resume) resumeCheckpoint = undefined; // consumed by this loop
        return loop.deliver(prompt);
      },
      setPhaseSpec: (spec) => specs.setShared(spec),
      openTask: (title) => openDeliveryTask(title, projectRoot, missionTask?.id),
      completeTask: (record, r) => completeDeliveryTask(record, r),
      persistCursor: (index) => {
        phaseIndex = index;
        runState.phaseIndex = index;
        saveRunState(runState);
      },
      persistCompleted: (summaries) => {
        phaseSummaries.length = 0;
        phaseSummaries.push(...summaries);
        runState.phaseSummaries = [...summaries];
        runState.checkpoint = undefined; // belongs to the finished phase
        saveRunState(runState);
      },
      note: (line) => console.log(line.startsWith('▶') ? chalk.bold(line) : chalk.dim(line)),
    });
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
  /**
   * Wire deliver's ambient context into the extracted epic-mission runner
   * (src/delivery/epic-mission.ts) — the DEFAULT delivery path, now driven
   * through a unit-tested core instead of a 230-line untested closure.
   */
  const runEpicMission = async (): Promise<DeliveryResult> => {
    const epicParallelTasks = resolveParallelTasks(
      (cfgRaw.deliver as Record<string, unknown> | undefined)?.parallelTasks
    );
    const contractsFirst = process.env.UAP_DELIVER_CONTRACTS !== '0';
    const scaffoldFirst = process.env.UAP_DELIVER_SCAFFOLD !== '0';
    return runEpicMissionCore({
      instruction,
      projectRoot,
      planEpics: () =>
        planDeliveryPhases(instruction, verdictExecutor, undefined, {
          sessionTokenBudget: sessionBudget,
          contractsFirst,
          scaffoldFirst,
        }),
      // Re-decomposition is already reactive (the failure text is in the
      // goal) — the extra thought-experiment judge call buys nothing here.
      planSplit: (subGoal) =>
        planDeliveryPhases(subGoal, verdictExecutor, undefined, {
          sessionTokenBudget: sessionBudget,
          thoughtExperiment: false,
        }),
      planEpicTasks: (goal) =>
        planDeliveryPhases(goal, verdictExecutor, undefined, {
          sessionTokenBudget: sessionBudget,
          thoughtExperiment: false,
        }),
      epicParallelTasks,
      // Deterministic epic-boundary resume: reuse the PERSISTED plan and
      // accepted-epic set — replanning on resume would mint new epic ids
      // (resetting the completion ledger's done marks) and draw new
      // boundaries over already-built work, which the anti-no-op rail then
      // refuses to accept (a wedge).
      initialEpics: resumeState?.runnerKind === 'epic' ? resumeState.phases : undefined,
      initialDone: resumeState?.runnerKind === 'epic' ? (resumeState.completedEpicIds ?? []) : [],
      initialPriorSummaries:
        resumeState?.runnerKind === 'epic' ? (resumeState.phaseSummaries ?? []) : [],
      persistPlan: (plan) => {
        runState.phases = plan;
        saveRunState(runState);
      },
      persistCompleted: ({ summaries, completed }) => {
        runState.phaseSummaries = [...summaries];
        runState.completedEpicIds = [...completed];
        // The checkpoint belongs to the finished epic (phased-path parity) —
        // never seed a later loop with a completed epic's session state.
        runState.checkpoint = undefined;
        saveRunState(runState);
      },
      runOrchestrated: (missionText, plan, parentTaskId) =>
        runOrchestratedMissionCore(buildOrchestratedDeps(missionText, plan, epicParallelTasks, parentTaskId)),
      runEpicLoop: async (scoped) => {
        const loop = new ConvergenceLoop(
          { ...loopConfig, baselineCheck: false, resumeFrom: undefined, onIteration: makeIterationHook() },
          executor,
          seams
        );
        return loop.deliver(scoped);
      },
      setEpicSpec: (spec) => specs.setShared(spec), // fresh epic — breaker needs fresh diff evidence
      judgeEpic:
        options.acceptance && !skipJudgeForSimple
          ? async (spec) => {
              try {
                const judged = await runAcceptanceGate({
                  spec,
                  projectRoot,
                  executor: verdictExecutor,
                  runtimeNote:
                    'Objective project gates ALL PASSED for every task and on the combined tree — treat build/test requirements as objectively verified.',
                });
                return resolveAcceptanceVerdict(judged, acceptancePrimary);
              } catch {
                return null; // judge unavailable — the objective verdicts stand
              }
            }
          : null,
      openTask: (title) => openDeliveryTask(title, projectRoot, missionTask?.id),
      completeTask: (record, r) => completeDeliveryTask(record, r),
      ledgerInit: (items) =>
        initLedger(projectRoot, instruction, items.map((i) => ({ ...i, kind: 'epic' as const }))),
      ledgerMark: (id, status, noteText) => markItem(projectRoot, id, status, noteText),
      lockedContracts: () => [...contractLock],
      lockContracts: (files) => {
        const locked = lockContractFiles(contractLock, projectRoot, files);
        for (const p of locked) if (!contractPaths.includes(p)) contractPaths.push(p);
        return locked;
      },
      // P1: concatenate the locked contract files' CONTENTS (original-cased
      // paths) for verbatim injection into later epics (build against the EXACT
      // shared surface). Reads are contained to the project root.
      readContractFiles: () => {
        if (contractPaths.length === 0) return null;
        const parts: string[] = [];
        for (const rel of contractPaths) {
          const abs = resolve(projectRoot, rel);
          if (relative(projectRoot, abs).startsWith('..')) continue; // never read outside the project
          try {
            parts.push(`// ===== ${rel} =====\n${readFileSync(abs, 'utf8')}`);
          } catch { /* a locked path that vanished — skip it */ }
        }
        return parts.length > 0 ? parts.join('\n\n') : null;
      },
      // P1 contract-lint source: a bounded walk of the project's delivered
      // source (js/ts family), skipping tooling dirs. Fed to the structural
      // lint so `new Singleton()` mismatches are caught at the epic boundary.
      readSourceFiles: () => {
        const out: Array<{ path: string; content: string }> = [];
        const SKIP = new Set(['node_modules', '.git', '.uap', '.uap-backups', 'dist', 'build', '.worktrees', 'coverage', 'vendor', 'third_party']);
        const EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
        const MAX_FILES = 120;
        const MAX_BYTES = 200_000;
        const walk = (dir: string, depth: number): void => {
          if (out.length >= MAX_FILES || depth > 8) return;
          let entries: import('fs').Dirent[];
          try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (out.length >= MAX_FILES) return;
            if (SKIP.has(e.name)) continue;
            const abs = join(dir, e.name);
            // Skip ALL dot-directories (.next/.nuxt/.svelte-kit/.output/.cache/…) —
            // they hold compiled/vendored JS that would seed false positives.
            if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(abs, depth + 1); continue; }
            if (!EXT.test(e.name)) continue;
            try {
              if (statSync(abs).size > MAX_BYTES) continue;
              out.push({ path: relative(projectRoot, abs).split('\\').join('/'), content: readFileSync(abs, 'utf8') });
            } catch { /* unreadable — skip */ }
          }
        };
        walk(projectRoot, 0);
        return out;
      },
      maxAttemptsPerEpic: Number(process.env.UAP_DELIVER_EPIC_ATTEMPTS ?? 3), // (#4b) 2→3
      // (#4c) Recursive split depth: a huge epic that still can't land after
      // a split is split again, one level shallower — bounded.
      splitDepth: Math.max(1, Number(process.env.UAP_DELIVER_EPIC_SPLIT_DEPTH ?? 2)),
      // (#5) Auto-escalation on any exhausted-attempts failure; disable with
      // UAP_DELIVER_SPLIT_ON_ANY_FAILURE=0 for budget-exhaustion-only.
      splitOnAnyFailure: process.env.UAP_DELIVER_SPLIT_ON_ANY_FAILURE !== '0',
      sessionBudget,
      note: (line) =>
        console.log(
          line.startsWith('▶')
            ? chalk.bold(line)
            : line.startsWith('  ✗')
              ? chalk.red(line)
              : line.startsWith('  ✓')
                ? chalk.green(line)
                : line.startsWith('  ✂')
                  ? chalk.yellow(line)
                  : line.includes('epic controller:') ||
                      line.includes('contracts locked') ||
                      line.includes('orchestrated parallel dispatch')
                    ? chalk.cyan(line)
                    : chalk.dim(line)
        ),
    });
  };

  // --keep-best (never regress): capture the starting required-gate score and a
  // project snapshot so we can roll back if deliver ends up WORSE than it
  // started. Only meaningful with real gates — a self-authored proxy gate is
  // not a trustworthy regression signal.
  // Regression scoring uses only the fast tier — a cheap, synchronous, always-
  // run signal. Integration/deploy-dev gates may not run at baseline (promotion
  // is cheap-first), so they are not a trustworthy regression comparison.
  // keep-best scores the DETERMINISTIC objective gates — build/test/lint (fast) PLUS
  // the execution smoke (runtime) and user-path (final) gates — not just the fast tier.
  // On a project whose only meaningful gates are runtime/final (e.g. a vanilla-JS web
  // app with no build step) the fast subset is trivially 1.00 every turn, so
  // best-intermediate never advanced and a 100%-functional turn that later regressed
  // was DISCARDED (octopus, 2026-07-24: the lazy turn hit 100% of gates, the
  // vision-chasing turns then rewrote game.js and broke the HUD wiring, and the win was
  // lost — the harness kept the regressed end state). Exclude the LLM judge rungs
  // (bootstrap/acceptance): non-deterministic, they would make the rollback target flap.
  const KEEP_BEST_TIERS = new Set<GateTier>(['fast', 'runtime', 'integration', 'final']);
  const KEEP_BEST_EXCLUDE_IDS = new Set(['bootstrap', 'acceptance']);
  const fastRungs = rungs.filter((r) => KEEP_BEST_TIERS.has(tierOf(r)) && !KEEP_BEST_EXCLUDE_IDS.has(r.id));
  // DEFAULT ON. This was opt-in, and the cost of that default was measured:
  // across three Octopus Invaders runs (2026-08-01) a run reached a fully
  // working, playable game at turn 2, then a later turn fixed an unrelated
  // TypeError and in the same whole-file rewrite deleted the line that started
  // the program. captureBestKeep would have snapshotted the peak and rolled
  // back to it — but it is armed only by this flag, so it never ran and the
  // working artifact was lost. A convergence loop that applies turns in place
  // without preserving its best result is strictly worse than one that does;
  // nobody wants the regressed end state, they just did not know to ask.
  //
  // Safe to default: snapshotTree is disk-backed (never RAM tmpfs), excludes
  // node_modules/target/.git, and is size-capped (UAP_SNAPSHOT_MAX_MB, 4096)
  // — over the cap it degrades to "no rollback this run" with a warning rather
  // than failing the run. Opt out with --no-keep-best or UAP_DELIVER_KEEP_BEST=0.
  const keepBest = resolveKeepBest(options.keepBest) && fastRungs.length > 0 && !needsSelfGate;
  let regressSnapshot: string | null = null;
  let baselineGateScore = 0;
  if (keepBest) {
    baselineGateScore = runLadder(fastRungs, projectRoot).score;
    const snapResult = snapshotTree(projectRoot);
    if (snapResult.ok) {
      regressSnapshot = snapResult.path;
      // Arm best-intermediate tracking: the baseline is the initial best, and
      // captureBestKeep advances regressSnapshot/baselineGateScore to any
      // higher-scoring turn (disposing the superseded snapshot).
      bestFastRungIds = new Set(fastRungs.map((r) => r.id));
      keepBestArmed = true;
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
          // The acceptance contract is a REQUIREMENT spec, not a convergence aid:
          // carry it into the bare turn so a one-shot build already exposes the
          // journeys/selectors the gate will drive (otherwise the lazy turn builds
          // blind, e.g. a canvas-only UI with no DOM handles, and only later turns
          // — which do get the contract — can recover it).
          acceptanceContract: loopConfig.acceptanceContract,
          onIteration: (record) => { updateDeliverHeartbeat(projectRoot); printProgress(record); },
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
    // Resume routing: an epic-kind resume re-enters the epic path (fidelity —
    // completed epics carry forward as prior summaries). Everything else takes
    // a cursor-honoring sequential path — phased when a phase plan was
    // persisted, otherwise the single flat loop. When that CHANGES the
    // execution model (e.g. an epic run resumed under --no-epics), warn
    // loudly, never silently: different prompts, no contract publication,
    // DAG flattened to linear order.
    if (resumeState?.runnerKind) {
      const resumeTarget = epicsEnabled
        ? 'epic'
        : phases && phases.length >= 2 && orchestrateEnabled && resumeState.runnerKind === 'orchestrated'
          ? 'orchestrated'
          : phases && phases.length >= 2
            ? 'phased'
            : 'single';
      if (resumeState.runnerKind !== resumeTarget) {
        const targetDesc =
          resumeTarget === 'phased'
            ? 'sequential phased path (the only cursor-honoring runner)'
            : 'single-loop path (no phase plan was persisted by the original run)';
        console.log(
          chalk.yellow(
            `  ⚠ resume: the interrupted run executed as '${resumeState.runnerKind}'; resuming on the ${targetDesc} — prompts and per-phase context will differ from the original execution model.`
          )
        );
        // A cross-model checkpoint would replay a FOREIGN prompt scope (a
        // task- or epic-scoped session) into the downgraded loop — discard.
        resumeCheckpoint = undefined;
      }
    }
    if (lazySolved) {
      runState.runnerKind = 'single';
      saveRunState(runState);
      result = result!;
    } else if (epicsEnabled) {
      if (resumeState && resumeCheckpoint) {
        console.log(
          chalk.dim(
            '  resume: mid-epic loop checkpoint discarded — epic missions resume at the epic boundary (completed epics carry forward as summaries).'
          )
        );
        resumeCheckpoint = undefined;
      }
      runState.runnerKind = 'epic';
      saveRunState(runState);
      result = await runEpicMission();
    } else if (
      phases &&
      phases.length >= 2 &&
      orchestrateEnabled &&
      (!resumeState || resumeState.runnerKind === 'orchestrated')
    ) {
      // Resume routing: ONLY an orchestrated-kind resume may re-enter this
      // path — it resumes at the task boundary (persisted taskOutcomes seed
      // the done set + blackboard). A resumed PHASED run must not route
      // here: the orchestrated runner ignores phaseIndex, and
      // runPhasedMission below is the only phase-cursor-honoring path.
      if (resumeState && resumeCheckpoint) {
        console.log(
          chalk.dim(
            '  resume: mid-task loop checkpoint discarded — orchestrated missions resume at the task boundary (completed tasks carry forward via persisted outcomes).'
          )
        );
        resumeCheckpoint = undefined;
      }
      runState.runnerKind = 'orchestrated';
      saveRunState(runState);
      result = await runOrchestratedMission();
    } else if (phases && phases.length >= 2) {
      runState.runnerKind = 'phased';
      saveRunState(runState);
      result = await runPhasedMission();
    } else {
      runState.runnerKind = 'single';
      saveRunState(runState);
      if (resumeCheckpoint) loopConfig.resumeFrom = resumeCheckpoint;
      const loop = new ConvergenceLoop(loopConfig, runExecutor, seams);
      result = await loop.deliver(instruction);
    }

    // CI watch boundary + re-converge: once local tiers are green, commit/push
    // the worktree branch and watch the CI run — extracted policy, see
    // src/delivery/ci-reconverge.ts. Skipped when nothing changed.
    if (watchCi && result.success && !result.alreadyDelivered) {
      // Re-point the judge at the MISSION: epic/phased runners leave
      // acceptanceSpec on the LAST epic/phase spec, and a re-converge pass
      // would otherwise be judged against that stale slice.
      specs.setShared(instruction); // evidence resets wherever the spec re-points
      const branch = currentBranch(projectRoot) ?? undefined;
      result = await runCiReconverge({
        instruction,
        initial: result,
        ciPasses,
        changedFiles: () => changedFiles(projectRoot),
        greenDetail: watchEnvironments ? ` (${watchEnvironments.join('/')} deploy verified)` : '',
        commitAndWatch: async (files) => {
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
          return watch;
        },
        reconverge: async (prompt) => {
          const reconvergeLoop = new ConvergenceLoop(
            { ...loopConfig, baselineCheck: false, resumeFrom: undefined, onCheckpoint: undefined },
            executor,
            seams
          );
          return reconvergeLoop.deliver(prompt);
        },
        note: (line) =>
          console.log(
            line.startsWith('  ✓')
              ? chalk.green(line)
              : line.startsWith('  ⚠') || line.startsWith('  ✗')
                ? chalk.yellow(line)
                : line.startsWith('  ⟲')
                  ? chalk.cyan(line)
                  : line.includes('exhausted') || line.includes('did not reach')
                    ? chalk.red(line)
                    : chalk.dim(line)
          ),
      });
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
    // The loop is over: from here a normal exit is expected, so stop treating a
    // signal as a mystery death.
    disposeExitRecorder();
    // Stop the wedge watchdog on the normal completion path too (not only on
    // process exit) — avoids a stray requestStop on a finished runId and, for
    // repeated in-process callers, interval/listener accumulation.
    if (wedgeWatchdog) { clearInterval(wedgeWatchdog); wedgeWatchdog = null; }
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
            `  ↩ no-regress: reverted to best (end gate score ${endScore.toFixed(2)} < best ${baselineGateScore.toFixed(2)})`
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
        chalk.dim(`  no-regress: kept (end gate score ${endScore.toFixed(2)} ≥ best ${baselineGateScore.toFixed(2)})`)
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
    // Same --json contract as the guards above. This is the likeliest state a
    // caller reaches right after the duplicate-launch case: the detached mission
    // finished, the caller relaunched, and the gates are now green. Returning
    // without JSON here would have handed it the same unparseable output that
    // sent the last one looking for a gate override.
    if (options.json) {
      const { finalOutput: alreadyFinal, ...alreadyRest } = result;
      console.log(
        JSON.stringify(
          { ...alreadyRest, runId, finalOutput: alreadyFinal.slice(0, 4000) },
          null,
          2
        )
      );
    }
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

  // Verification provenance banner (S1) — makes the judge boundary observable.
  if (!options.json && !options.dryRun) {
    const line = formatVerificationProvenance({
      executorModel: model.id,
      judgeModel: judgeModelId,
      distinct: judgeDistinct,
    });
    console.log(judgeDistinct ? chalk.dim(line) : chalk.yellow(line));
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
