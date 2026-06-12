/**
 * Delivery harness — Fable-parity convergence loop.
 *
 * Drives underlying models through execute → apply → verify → feedback
 * iterations against the project's real completion gates until delivery
 * is achieved.
 */

export {
  ConvergenceLoop,
  defaultPromptBuilder,
  type CandidateSummary,
  type ConvergenceConfig,
  type DeliveryResult,
  type ExplorerSettings,
  type IterationRecord,
  type LoopExecutor,
  type LadderRunner,
  type PromptBuilder,
  type PromptContext,
} from './convergence-loop.js';

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
  type Applier,
  type ApplyResult,
  type FileBlock,
  type RevertibleApply,
} from './applier.js';

export { OpenAICompatClient, type OpenAICompatClientOptions } from '../models/openai-compat-client.js';
