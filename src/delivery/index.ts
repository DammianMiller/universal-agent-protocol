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
  type ConvergenceConfig,
  type DeliveryResult,
  type IterationRecord,
  type LoopExecutor,
  type LadderRunner,
  type PromptBuilder,
  type PromptContext,
} from './convergence-loop.js';

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
  parseFileBlocks,
  type Applier,
  type ApplyResult,
  type FileBlock,
} from './applier.js';

export { OpenAICompatClient, type OpenAICompatClientOptions } from '../models/openai-compat-client.js';
