/**
 * Session context budget — size deliver epics/sessions to the serving rail.
 *
 * The local llama server exposes N parallel slots ("rails"), each with a fixed
 * per-slot context (e.g. --parallel 2 over ctx 360k = 180k/rail). A deliver
 * session that outgrows its rail either gets pruned by the anthropic-proxy
 * (losing mid-mission state) or wedges on overflow — both defeat convergence.
 * This module resolves the per-session token budget and provides the shared
 * estimator used to (a) tell the epic planner how big a phase may be and
 * (b) hard-stop an agentic session before it outgrows the rail.
 *
 * Resolution order (first hit wins):
 *   1. UAP_DELIVER_SESSION_TOKEN_BUDGET env var
 *   2. `.uap.json` deliver.sessionTokenBudget
 *   3. model preset: modelContextBudget ?? maxContextTokens
 *   4. DEFAULT_SESSION_TOKEN_BUDGET
 */

import type { ModelConfig } from '../models/types.js';
import { estimateTokens } from '../memory/context-compressor.js';

/** Conservative fallback when neither env, config, nor preset provide a size. */
export const DEFAULT_SESSION_TOKEN_BUDGET = 131072;

/**
 * Fraction of the rail a session may actually fill. Aligned with the
 * anthropic-proxy's prune threshold (PROXY_CONTEXT_PRUNE_THRESHOLD=0.70): a
 * session that finishes below 70% of the rail is never pruned mid-mission, so
 * an epic sized to the working budget completes with its full context intact.
 */
export const SESSION_WORKING_FRACTION = 0.7;

/** Floor below which a budget value is treated as a misconfiguration. */
const MIN_SANE_BUDGET = 8192;

function saneBudget(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_SANE_BUDGET ? Math.floor(n) : undefined;
}

/** Resolve the full per-session (per-rail) token budget. */
export function resolveSessionTokenBudget(
  model?: Pick<ModelConfig, 'modelContextBudget' | 'maxContextTokens'>,
  cfgRaw?: Record<string, unknown>
): number {
  const fromEnv = saneBudget(process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET);
  if (fromEnv) return fromEnv;
  const deliverCfg = cfgRaw?.deliver as Record<string, unknown> | undefined;
  const fromCfg = saneBudget(deliverCfg?.sessionTokenBudget);
  if (fromCfg) return fromCfg;
  const fromModel = saneBudget(model?.modelContextBudget ?? model?.maxContextTokens);
  if (fromModel) return fromModel;
  return DEFAULT_SESSION_TOKEN_BUDGET;
}

/** The budget a session may actually consume (rail × working fraction). */
export function sessionWorkingBudget(fullBudget: number): number {
  return Math.floor(fullBudget * SESSION_WORKING_FRACTION);
}

/**
 * Estimate one text's token count for BUDGET purposes: the shared word-based
 * heuristic, floored at chars/4. The floor matters — estimateTokens() is
 * word-split-based, so long unbroken content (minified JS, base64, huge
 * single-line tool output) would otherwise count as a handful of tokens and
 * blow straight through the rail.
 */
function estimateTextTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 4));
}

/**
 * Estimate the token footprint of an OpenAI-style message array (system +
 * user + assistant + tool results + serialized tool calls). Deliberately
 * rough; consumers must leave headroom, which SESSION_WORKING_FRACTION
 * already provides.
 */
export function estimateMessagesTokens(
  messages: Array<{ content?: string | null; tool_calls?: unknown }>
): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTextTokens(m.content);
    if (m.tool_calls) {
      try {
        total += estimateTextTokens(JSON.stringify(m.tool_calls));
      } catch {
        /* unserializable tool calls contribute nothing to the estimate */
      }
    }
  }
  return total;
}

/**
 * Marker embedded in an executor's summary when a session was stopped for
 * hitting its context budget — the epic controller keys its split-and-retry
 * path off this exact token.
 */
export const CONTEXT_BUDGET_MARKER = '[context-budget]';
