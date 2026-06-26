/**
 * Cross-process model-slot lease: a semaphore over the inference backend's
 * concurrent slots, shared via the coordination DB so multiple agents AND
 * multiple `uap` processes hitting the same endpoint never exceed the budget.
 *
 * `withModelSlot(holder, fn)` acquires a slot (waiting when the budget is full),
 * runs `fn`, and releases — the right wrapper around any model call / agent spawn.
 */
import { CoordinationService } from '../coordination/service.js';
import { getModelSlotBudget } from './model-slots.js';

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

async function resolveBudget(opts: SlotLeaseOptions): Promise<number> {
  if (opts.budget && opts.budget > 0) return opts.budget;
  return (await getModelSlotBudget(opts.cwd)).budget;
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
  const budget = await resolveBudget(opts);
  const ttlMs = opts.ttlMs ?? 120_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
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
  const { leaseId, service } = await acquireModelSlot(holder, opts);
  try {
    return await fn();
  } finally {
    if (leaseId !== null) service.releaseModelSlot(leaseId);
  }
}
