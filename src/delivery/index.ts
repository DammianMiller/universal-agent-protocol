/**
 * Delivery harness — Fable-parity convergence loop.
 *
 * Drives underlying models through execute → apply → verify → feedback
 * iterations against the project's real completion gates until delivery
 * is achieved.
 */

export {
  ConvergenceLoop,
  composeIterationHooks,
  defaultPromptBuilder,
  type CandidateSummary,
  type ConvergenceConfig,
  type DeliveryResult,
  type ExplorerSettings,
  type IterationDirective,
  type IterationRecord,
  type LoopExecutor,
  type LadderRunner,
  type OnIteration,
  type PracticeProvider,
  type PromptBuilder,
  type PromptContext,
  type LoopCheckpoint,
} from './convergence-loop.js';

export {
  saveRunState,
  loadRunState,
  newRunId,
  isValidRunId,
  deliverRunsDir,
  type DeliverRunState,
  type DeliverRunStatus,
} from './run-state.js';

export {
  extractContract,
  type ContractResult,
} from './contract-extractor.js';

export {
  orchestrate,
  assembleTaskContext,
  governContext,
  type OrchestratorTask,
  type TaskOutcome,
  type AssembledContext,
  type OrchestratorConfig,
  type OrchestratorResult,
} from './task-orchestrator.js';

export {
  planDeliveryPhases,
  parsePhaseArray,
  phaseInstruction,
  shouldDecompose,
  type DeliveryPhase,
} from './decompose.js';

export {
  validatePhaseGraph,
  parsePlanVerdict,
  runPlanThoughtExperiment,
  reviewPlanText,
  type PhaseGraphValidation,
  type PlanReviewVerdict,
} from './plan-check.js';

export {
  runOrchestratedMission,
  foldDeliveryResult,
  type OrchestratedMissionDeps,
} from './orchestrated-mission.js';

export {
  createTaskWorkspaceManager,
  resolveParallelTasks,
  type TaskWorkspace,
  type TaskWorkspaceManager,
} from './task-workspace.js';

export {
  autoMineHaloTraces,
  summarizeWeaknesses,
  isAutoMineEnabled,
  weaknessGuidance,
  loadPersistedWeaknesses,
  type AutoMineResult,
} from './auto-mine.js';

export {
  judgeScreenshots,
  parseVisionVerdict,
  visionSummary,
  visionJudgeConfigured,
  type VisionVerdict,
} from './vision-judge.js';

export {
  runVisualGate,
  discoverEntryPages,
  judgePage,
  motionBetween,
  visualRuntimeNote,
  readVisualTargets,
  type VisualVerdict,
  type PageVisualReport,
  type VisualGateOptions,
  type VisualBrowserDriver,
} from './visual-gate.js';

export {
  createGitWorktreeProvider,
  isParallelExploreEnabled,
  type CandidateWorkspace,
  type WorkspaceProvider,
} from './candidate-workspace.js';

export {
  openDeliveryTask,
  completeDeliveryTask,
  recordDeliveryOutcome,
  hasTaskDb,
  type DeliveryTaskHandle,
} from './task-sync.js';

export {
  createEscalationController,
  defaultEscalationLadder,
  type DefaultLadderOptions,
  type EscalationConfig,
  type EscalationController,
  type EscalationTier,
} from './escalation.js';

export {
  InMemoryPracticeStore,
  FilePracticeStore,
  extractKeywords,
  distillPractice,
  defaultPracticePath,
  retrievePracticesSemantic,
  type PracticeCard,
  type PracticeInput,
  type PracticeStore,
  type SemanticRetriever,
  type SemanticRetrieveOptions,
} from './practice.js';

export {
  exploreAndCommit,
  DEFAULT_STRATEGY_SEEDS,
  MAX_CANDIDATES,
  type CandidateResult,
  type ExplorationResult,
  type ExplorerConfig,
  type StrategySeed,
} from './explorer.js';

export {
  createModelJudge,
  extractJson,
  type Judge,
  type JudgeCandidate,
  type JudgeVerdict,
} from './judge.js';

export {
  createModelCritic,
  parseFixList,
  type Critic,
  type Critique,
  type CritiqueInput,
} from './critic.js';

export {
  detectRungs,
  runLadder,
  runRung,
  formatFeedback,
  type GateRung,
  type RungResult,
  type RungFailureReason,
  type LadderResult,
  type LadderOptions,
} from './verifier-ladder.js';

export {
  applyFileBlocks,
  applyFileBlocksWithRollback,
  parseFileBlocks,
  findProtectedTestFiles,
  isGateConfigBasename,
  isTestFilePath,
  type Applier,
  type ApplyOptions,
  type ApplyResult,
  type FileBlock,
  type RevertibleApply,
} from './applier.js';

export {
  planAutoOptimization,
  DELIVERY_COMPLEXITY_THRESHOLDS,
  type AutoPlan,
  type DeliveryComplexity,
} from './auto-optimizer.js';

export {
  captureIntegrity,
  verifyAndRestore,
  integrityViolationFeedback,
  type IntegritySnapshot,
  type IntegrityCheck,
} from './integrity.js';

export {
  snapshotProtection,
  expandSpecImports,
  resolveRelativeImport,
  resolveAliasImport,
  loadTsconfigAliases,
  isOraclePath,
  type ProtectionSnapshot,
  type TsconfigAliases,
} from './spec-imports.js';

export {
  generateStrategySeeds,
  parseSeedArray,
  seedsFromIdeas,
  type IdeationOptions,
} from './ideation.js';

export {
  createHaloDeliveryTracer,
  type HaloDeliveryTracer,
  type HaloDeliveryTracerOptions,
} from './halo-trace.js';

export {
  createRunCoordinator,
  collectAppliedFiles,
  type RunCoordinator,
  type RunCoordinatorOptions,
} from './run-coordinator.js';

export { OpenAICompatClient, type OpenAICompatClientOptions } from '../models/openai-compat-client.js';
