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
 * Operator-tunable via UAP_DELIVER_WORKING_FRACTION (0<f≤1) to push toward
 * maximum ctx use — but keep it ALIGNED with the proxy prune threshold, or
 * sessions sized past the threshold get pruned mid-mission (defeating it).
 */
export const SESSION_WORKING_FRACTION = ((): number => {
  const raw = Number(process.env.UAP_DELIVER_WORKING_FRACTION);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
})();

/** Floor below which a budget value is treated as a misconfiguration. */
const MIN_SANE_BUDGET = 8192;

function saneBudget(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_SANE_BUDGET ? Math.floor(n) : undefined;
}

/**
 * Resolve the full per-session (per-rail) token budget.
 *
 * Precedence: explicit operator override (env) → project config → the
 * DISCOVERED live window of the model actually being called (see
 * discoverModelContextWindow) → the model preset → a conservative default. The
 * discovered value sits above the preset so sizing auto-adapts to whatever
 * model/ctx is live (a rail resize, a different model) instead of a hardcoded
 * preset, while an explicit env/config value still wins for a deliberate cap.
 */
export function resolveSessionTokenBudget(
  model?: Pick<ModelConfig, 'modelContextBudget' | 'maxContextTokens'>,
  cfgRaw?: Record<string, unknown>,
  discovered?: number
): number {
  const fromEnv = saneBudget(process.env.UAP_DELIVER_SESSION_TOKEN_BUDGET);
  if (fromEnv) return fromEnv;
  const deliverCfg = cfgRaw?.deliver as Record<string, unknown> | undefined;
  const fromCfg = saneBudget(deliverCfg?.sessionTokenBudget);
  if (fromCfg) return fromCfg;
  const fromDiscovered = saneBudget(discovered);
  if (fromDiscovered) return fromDiscovered;
  const fromModel = saneBudget(model?.modelContextBudget ?? model?.maxContextTokens);
  if (fromModel) return fromModel;
  return DEFAULT_SESSION_TOKEN_BUDGET;
}

/**
 * Auto-discover the SERVING model's actual per-rail context window so sizing
 * adapts to whatever model/ctx is live, rather than a hardcoded preset. Queries
 * the anthropic-proxy's `/v1/context` first (authoritative per-rail window,
 * auto-updated from llama's `/slots`), then falls back to llama.cpp's native
 * `/props` (`n_ctx`). Returns undefined on any failure — the caller falls back
 * to the preset. Fail-soft and time-boxed so discovery can never block or wedge
 * a deliver run.
 */
export async function discoverModelContextWindow(
  endpoint: string | undefined,
  timeoutMs = 1500
): Promise<number | undefined> {
  if (!endpoint) return undefined;
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return undefined;
  }
  const attempts: Array<{ url: string; pick: (j: Record<string, unknown>) => unknown }> = [
    { url: `${origin}/v1/context`, pick: (j) => j.context_window },
    {
      url: `${origin}/props`,
      pick: (j) => {
        const gen = j.default_generation_settings as Record<string, unknown> | undefined;
        return gen?.n_ctx ?? j.n_ctx;
      },
    },
  ];
  for (const a of attempts) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(a.url, { signal: ctl.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) continue;
      const j = (await res.json()) as Record<string, unknown>;
      const n = saneBudget(a.pick(j));
      if (n) return n;
    } catch {
      /* unreachable/timeout/parse — try next attempt, then fall back to preset */
    }
  }
  return undefined;
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
 * Marker embedded in an executor's session output when the session was
 * stopped for hitting its context budget.
 *
 * WIRE PROTOCOL — this module owns both ends of it:
 * - Producer: `formatBudgetStop()` (used by the agentic executor when the
 *   estimate crosses the rail budget). The marker leads the output.
 * - Decoder: `decodeBudgetStop()` (used by the convergence loop to translate
 *   the session output into the structured `IterationRecord.budgetStopped`
 *   field). Everything DOWNSTREAM of the loop — epic-mission's settle, the
 *   epic controller's rail-sizing split — consumes only the structured field
 *   (marker-substring matching there was removed in v1.154.0).
 *
 * The marker string itself stays exported for human-facing summaries and for
 * out-of-tree executors, but no in-tree consumer may sniff it outside
 * `decodeBudgetStop`.
 */
export const CONTEXT_BUDGET_MARKER = '[context-budget]';

/**
 * Compose the budget-stop session output (marker-led, with a compact tail of
 * what the session managed to finish so a split re-plan knows where it stood).
 */
export function formatBudgetStop(args: {
  estimatedTokens: number;
  budget: number;
  rounds: number;
  summaries: string[];
}): string {
  return (
    `${CONTEXT_BUDGET_MARKER} session reached ~${args.estimatedTokens} of ${args.budget} estimated tokens ` +
    `after ${args.rounds} round(s) — the task is too large for one session and must be split. ` +
    `Work completed so far: ${args.summaries.slice(-5).join('; ') || 'none'}`
  );
}

/**
 * How deep into the output the marker may legitimately appear. The producer
 * emits it at position 0; executor wrappers may prepend a short preamble.
 * Anything deeper is an ECHO — a budget-stopped turn's text rides into the
 * next prompt via previous-output context, and models parrot it — and an
 * echo must never tag a non-budget turn as budgetStopped.
 */
const BUDGET_MARKER_WINDOW_CHARS = 512;

/**
 * Decode a session output's budget-stop signal: the marker must appear within
 * the leading window (wrapper-prefix tolerant, echo-proof — see above).
 */
export function decodeBudgetStop(output: string | null | undefined): boolean {
  if (!output) return false;
  const i = output.indexOf(CONTEXT_BUDGET_MARKER);
  return i !== -1 && i < BUDGET_MARKER_WINDOW_CHARS;
}
