/**
 * Cross-process model-slot lease: a semaphore over the inference backend's
 * concurrent slots, shared via the coordination DB so multiple agents AND
 * multiple `uap` processes hitting the same endpoint never exceed the budget.
 *
 * `withModelSlot(holder, fn)` acquires a slot (waiting when the budget is full),
 * runs `fn`, and releases — the right wrapper around any model call / agent spawn.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { CoordinationService } from '../coordination/service.js';
import { getModelSlotBudget } from './model-slots.js';
import { loadUapConfigRaw } from './config-loader.js';

export interface SlotLeaseOptions {
  cwd?: string;
  /** Budget override (else resolved from model-slots). */
  budget?: number;
  /** Lease TTL — a crashed holder is reaped after this. Default 120s. */
  ttlMs?: number;
  /** Max time to wait for a slot before proceeding anyway (fail-open). Default 5m. */
  timeoutMs?: number;
  /** Poll interval while the budget is full. Default 200ms. */
  pollMs?: number;
  /** Reuse an existing service (else one is constructed on the default DB). */
  service?: CoordinationService;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Heuristic: does this inference error indicate the backend is saturated? */
export function isExhaustionError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\((?:429|408|502|503|504|529)\)|timed out|timeout|overloaded|too many requests|no slot|slots? (?:are )?full/i.test(m);
}

// Re-entrancy guard: nested withModelSlot calls within one async context reuse
// the outer lease (count as one slot) so layered wrappers can't deadlock or
// double-count. Cross-process callers (subprocesses) have a fresh store and
// lease independently, which is correct.
const holding = new AsyncLocalStorage<boolean>();

function adaptiveEnabled(cwd?: string): boolean {
  try {
    const raw = loadUapConfigRaw(cwd ?? process.cwd()) as { modelConcurrency?: { adaptive?: boolean } } | null;
    return raw?.modelConcurrency?.adaptive !== false; // on by default (no-op until exhaustion)
  } catch {
    return true;
  }
}

async function staticBudget(opts: SlotLeaseOptions): Promise<number> {
  if (opts.budget && opts.budget > 0) return opts.budget;
  // No probing on the per-call hot path — use env/config/cache/default. The
  // cache is warmed by orchestrators (warmModelSlotBudget) and `uap coord slots`.
  return (await getModelSlotBudget(opts.cwd, { probe: false })).budget;
}

/** Effective budget = min(static, adaptive). When backpressure is active the
 *  adaptive limit is below the static ceiling, throttling the whole fleet. */
async function effectiveBudget(service: CoordinationService, opts: SlotLeaseOptions): Promise<number> {
  const ceiling = await staticBudget(opts);
  if (!adaptiveEnabled(opts.cwd)) return ceiling;
  return service.getAdaptiveLimit(ceiling);
}

/** Record a model-backend exhaustion signal (429 / timeout / slot-busy). */
export async function recordModelExhaustion(opts: SlotLeaseOptions = {}): Promise<number> {
  const service = opts.service ?? new CoordinationService();
  return service.recordModelExhaustion(await staticBudget(opts));
}

/** Record a healthy model call so the limit can recover. */
export async function recordModelSuccess(opts: SlotLeaseOptions = {}): Promise<number> {
  const service = opts.service ?? new CoordinationService();
  return service.recordModelSuccess(await staticBudget(opts));
}

/**
 * Acquire a model slot, waiting (up to timeoutMs) when the budget is full.
 * Returns a lease id, or null if it timed out (caller may proceed best-effort).
 */
export async function acquireModelSlot(
  holder: string,
  opts: SlotLeaseOptions = {}
): Promise<{ leaseId: number | null; service: CoordinationService }> {
  const service = opts.service ?? new CoordinationService();
  const ttlMs = opts.ttlMs ?? 120_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const budget = await effectiveBudget(service, opts);
    const leaseId = service.acquireModelSlot(holder, budget, ttlMs);
    if (leaseId !== null) return { leaseId, service };
    if (Date.now() >= deadline) return { leaseId: null, service }; // fail-open
    await sleep(pollMs);
  }
}

/** Run `fn` while holding a model slot (acquire → fn → release). */
export async function withModelSlot<T>(
  holder: string,
  fn: () => Promise<T>,
  opts: SlotLeaseOptions = {}
): Promise<T> {
  // Already holding a slot in this async context → reuse it (re-entrant).
  if (holding.getStore()) return fn();

  // Fail-open: if the coordination layer is unavailable, run the call rather
  // than block real work on infra problems.
  let acquired: { leaseId: number | null; service: CoordinationService };
  try {
    acquired = await acquireModelSlot(holder, opts);
  } catch {
    return fn();
  }
  const { leaseId, service } = acquired;
  // Couldn't get a slot before the deadline → the backend is saturated.
  if (leaseId === null && adaptiveEnabled(opts.cwd)) {
    try {
      service.recordModelExhaustion(await staticBudget({ ...opts, service }));
    } catch {
      /* ignore */
    }
  }
  // Heartbeat renewal while fn runs: the TTL reaps CRASHED holders, but a
  // local-model decode routinely outlives 120s — without renewal the lease
  // expired mid-decode and admission control oversubscribed the GPU exactly
  // when it was busiest (review 2026-08-13 F3). A live holder renews at
  // ttl/3; a crashed one stops renewing and still reaps at TTL. Renewal
  // failure is fail-open by design, matching every other edge in this module.
  const ttlMs = opts.ttlMs ?? 120_000;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  if (leaseId !== null) {
    renewTimer = setInterval(() => {
      try {
        service.renewModelSlot(leaseId, ttlMs);
      } catch {
        /* fail-open: a lost lease degrades to today's behavior */
      }
    }, Math.max(1_000, Math.floor(ttlMs / 3)));
    // Never hold the event loop open for a heartbeat.
    renewTimer.unref?.();
  }
  try {
    return await holding.run(true, fn);
  } finally {
    if (renewTimer !== null) clearInterval(renewTimer);
    if (leaseId !== null) {
      try {
        service.releaseModelSlot(leaseId);
      } catch {
        /* ignore */
      }
    }
  }
}
