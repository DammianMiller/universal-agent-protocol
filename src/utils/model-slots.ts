/**
 * Model-slot budget: how many concurrent model calls the inference backend can
 * actually serve. UAP's other concurrency limits are sized to CPU cores, which
 * silently overruns a slot-limited server (llama.cpp `--parallel N`, or a remote
 * API's concurrency ceiling) and causes timeouts / 429s / proxy doom-loops.
 *
 * Budget resolution (auto-detect + config override):
 *   1. UAP_MODEL_SLOTS env                      (explicit override, no probe)
 *   2. .uap.json modelConcurrency.slots         (config override, no probe)
 *   3. probe the endpoint's llama.cpp `/slots`  (auto-detect)
 *   4. DEFAULT_SLOTS                            (conservative fallback)
 * minus `headroom`, floored at 1. Cached briefly so hot paths stay cheap.
 */
import { loadUapConfigRaw } from './config-loader.js';
import { discoverLocalLlamaBases } from './llama-discovery.js';

export const DEFAULT_SLOTS = 2; // matches llama-server-optimize's `--parallel 2`
const CACHE_TTL_MS = 30_000;

interface ModelConcurrencyConfig {
  slots?: number;
  headroom?: number;
  endpoint?: string;
  adaptive?: boolean;
}

let _cache: { budget: number; slots: number; source: BudgetSource; at: number } | null = null;

export type BudgetSource = 'env' | 'config' | 'probe' | 'default';

function cfg(cwd?: string): ModelConcurrencyConfig {
  try {
    const raw = loadUapConfigRaw(cwd ?? process.cwd()) as
      | { modelConcurrency?: ModelConcurrencyConfig }
      | null;
    return raw?.modelConcurrency ?? {};
  } catch {
    return {};
  }
}

function intEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The inference base URL (without a trailing /v1) for probing `/slots`. */
export function inferenceBase(cwd?: string): string {
  // The literal below is a convention, and llama does not always honour it:
  // Unsloth Studio picks a new random port every launch. When nothing is
  // configured, ask the OS which llama-server is actually listening — otherwise
  // probeSlots() fails and the slot budget silently falls back to DEFAULT_SLOTS,
  // sizing the cross-process lease against a fiction.
  const raw =
    process.env.UAP_MODEL_ENDPOINT ||
    process.env.UAP_INFERENCE_ENDPOINT ||
    cfg(cwd).endpoint ||
    process.env.LLAMA_CPP_BASE ||
    discoverLocalLlamaBases()[0] ||
    'http://localhost:8080';
  return raw.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

export function headroom(cwd?: string): number {
  return intEnv('UAP_MODEL_SLOT_HEADROOM') ?? cfg(cwd).headroom ?? 0;
}

/** Explicit slot count from env/config (no probing). */
export function configuredSlots(cwd?: string): number | undefined {
  return intEnv('UAP_MODEL_SLOTS') ?? cfg(cwd).slots;
}

/**
 * Probe a llama.cpp `/slots` endpoint; returns the slot count or null.
 *
 * `/slots` is a llama.cpp endpoint, and a null answer means two very different
 * things. The caller used to collapse both onto DEFAULT_SLOTS = 2:
 *
 *   - the endpoint is unreachable        -> we know nothing; 2 is a fair guess
 *   - the endpoint answered 404/405      -> this is NOT llama.cpp
 *
 * The second case is now the normal one here: the local backend is ninfer-serve
 * (`--max-concurrency 1`), which serves no `/slots` at all. Guessing 2 against a
 * server that runs ONE request and queues the rest does not double throughput —
 * it puts a second request in a queue and then lets the adaptive controller read
 * the queueing delay as backpressure on a server that was never saturated.
 *
 * So a live server that denies knowing about `/slots` reports 1, not "unknown".
 */
export async function probeSlots(base: string, timeoutMs = 1500): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/slots`, { signal: ctrl.signal });
      if (!res.ok) {
        // 404/405/501 = the server is up and has no such endpoint: not
        // llama.cpp, so it has no `--parallel` rails to divide. Treat it as a
        // single rail rather than as an absent answer. Any OTHER status (5xx,
        // 429) is a server that may well be llama.cpp having a bad moment —
        // that stays "unknown".
        return res.status === 404 || res.status === 405 || res.status === 501 ? 1 : null;
      }
      const body = (await res.json()) as unknown;
      if (Array.isArray(body) && body.length > 0) return body.length;
      return null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

function applyHeadroom(slots: number, cwd?: string): number {
  return Math.max(1, slots - headroom(cwd));
}

/**
 * Resolve the model-slot budget, probing the endpoint when no override is set.
 * Cached for CACHE_TTL_MS. Call this once at the start of a long-running
 * orchestrator (challenge run, deliver) to warm the cache for sync callers.
 */
export async function getModelSlotBudget(
  cwd?: string,
  opts: { probe?: boolean; force?: boolean } = {}
): Promise<{ budget: number; slots: number; source: BudgetSource }> {
  if (!opts.force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return { budget: _cache.budget, slots: _cache.slots, source: _cache.source };
  }
  let slots: number;
  let source: BudgetSource;
  const explicit = configuredSlots(cwd);
  if (intEnv('UAP_MODEL_SLOTS') !== undefined) {
    slots = explicit!;
    source = 'env';
  } else if (explicit !== undefined) {
    slots = explicit;
    source = 'config';
  } else if (opts.probe !== false) {
    const probed = await probeSlots(inferenceBase(cwd));
    if (probed !== null) {
      slots = probed;
      source = 'probe';
    } else {
      slots = DEFAULT_SLOTS;
      source = 'default';
    }
  } else {
    slots = DEFAULT_SLOTS;
    source = 'default';
  }
  const budget = applyHeadroom(slots, cwd);
  _cache = { budget, slots, source, at: Date.now() };
  return { budget, slots, source };
}

/** Warm the cache by probing — call at orchestrator startup. */
export async function warmModelSlotBudget(cwd?: string): Promise<number> {
  return (await getModelSlotBudget(cwd, { probe: true, force: true })).budget;
}

/**
 * Synchronous budget for hot paths (no probe): env > config > cached probe >
 * default, minus headroom. Use after warmModelSlotBudget() has populated the
 * cache, or when an explicit override is set.
 */
export function getMaxModelConcurrency(cwd?: string): number {
  const explicit = configuredSlots(cwd);
  if (explicit !== undefined) return applyHeadroom(explicit, cwd);
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.budget;
  return applyHeadroom(DEFAULT_SLOTS, cwd);
}

export function resetModelSlotCache(): void {
  _cache = null;
}
