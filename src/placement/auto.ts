/**
 * Placement auto-resolution (spec §4.4.1, phase 4) — request-driven loading.
 *
 * When a gated request parks because its model is not resident, the
 * controller can load it ITSELF instead of waiting for a human `uap models
 * apply`. Two rules, straight from the spec's core invariant ("never evict
 * without explicit operator confirmation"):
 *
 * 1. Non-displacing options (load-alongside, and reuse when a resident
 *    already serves) auto-enforce whenever the policy is enabled — nothing
 *    is evicted, the budget already said it fits.
 * 2. Displacement auto-enforces ONLY for models the operator explicitly
 *    allowlisted (`uap models auto --allow-displace <model> --yes`). The
 *    allowlist is the standing operator confirmation, written deliberately
 *    and auditable in the policy file — never a default.
 *
 * The park reason while an auto load runs is `auto_loading`; the client's
 * retry (retry_after_ms floor) is the protocol — the next admission after
 * the load answers forward. A failed auto attempt marks the pending entry
 * `auto_failed`.
 *
 * Run-shape rules (three reviews, phase 4):
 * - ONE run per requested MODEL, not per placement id — the client-supplied
 *   identity headers can mint fresh ids at request rate, so the id is no
 *   dedupe at all; the model is the real "same load" key.
 * - SINGLE-FLIGHT machine-wide: auto runs queue on one tail promise. Two
 *   alongside options computed against the same pre-load free-memory
 *   snapshot can otherwise both start and oversubscribe the card.
 * - The pending entry's TTL is EXTENDED past the enforcement envelope when
 *   a run schedules: drain + stops + verify-free + start can exceed the
 *   120s operator-prompt TTL, and a mid-run expiry would mint a fresh
 *   entry + a second concurrent run for the same model.
 * - A FAILED run parks its model in a cooldown window: otherwise a
 *   persistently failing load re-enforces every TTL expiry — an unattended
 *   drain→stop→fail→rollback oscillation the operator never consented to.
 * - The run NEVER rejects: every ledger write inside it is caught (a lock
 *   hiccup must not kill the dashboard daemon with an unhandled
 *   rejection), and the entry self-heals via TTL expiry.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { withLedger, placementLedgerPath } from './ledger.js';
import { enforceOption, type EnforceOpts, type EnforceResult } from './enforce.js';
import type { PlacementOption } from './admission.js';
import type { ModelRegistry } from './registry.js';

export interface AutoPolicy {
  enabled: boolean;
  /** Registry model keys whose DISPLACEMENT may auto-enforce. Empty by
   * default: displacement always needs an explicit allowlist entry. */
  allow_displace: string[];
}

/** OPT-IN by design: a missing (or corrupt) policy file means NO auto
 * loading — every park waits for a manual `uap models apply`, exactly as
 * before phase 4. `uap models auto --enable` turns it on deliberately. */
export const DEFAULT_AUTO_POLICY: AutoPolicy = { enabled: false, allow_displace: [] };

export function autoPolicyPath(): string {
  return process.env.UAP_PLACEMENT_AUTO ?? join(homedir(), '.uap', 'placement-auto.json');
}

export function loadAutoPolicy(path: string = autoPolicyPath()): AutoPolicy {
  if (!existsSync(path)) return { ...DEFAULT_AUTO_POLICY };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoPolicy>;
    return {
      // Explicit opt-in in the FILE too: only a literal `enabled: true`
      // enables; anything else (missing key, null, garbage) stays off.
      enabled: raw.enabled === true,
      allow_displace: Array.isArray(raw.allow_displace)
        ? raw.allow_displace.filter((m): m is string => typeof m === 'string')
        : [],
    };
  } catch {
    // Fail closed on a corrupt policy: auto alongside off, displacement
    // allowlist empty — parking for the operator is always safe.
    return { enabled: false, allow_displace: [] };
  }
}

export function saveAutoPolicy(policy: AutoPolicy, path: string = autoPolicyPath()): void {
  // Atomic tmp+rename (the ledger's own save shape): a torn or half-written
  // policy fails closed on read, but the operator's consent record should
  // not silently vanish on a crashed write either.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Hard cap on in-flight/queued auto runs: single-flight serializes them,
 * the cap bounds the queue and the map so a parked flood cannot queue an
 * unbounded backlog of machine mutations. */
const AUTO_MAX_CONCURRENT_RUNS = 2;
/** A failed auto load parks its MODEL for this window (no oscillation). */
const AUTO_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** An auto-loading entry must outlive the enforcement it supervises: drain
 * (~60s) + stops (~30s each) + verify-free (~30s) + start/verify-up (~120s)
 * exceeds the 120s operator-prompt TTL, and a queued run waits on the
 * single-flight tail besides. */
const AUTO_PENDING_WINDOW_MS = 10 * 60_000;

// Process-local by design: the LEDGER is the cross-process dedupe; these
// maps only bound what THIS controller process runs.
const autoRuns = new Map<string, Promise<void>>(); // keyed by requested model
const autoFailures = new Map<string, number>(); // model → epoch ms of last failure
let autoTail: Promise<void> = Promise.resolve();

/** Pick the option an auto load may enforce, or null when it may not.
 * Includes the runnability gates (in-flight cap, failure cooldown) so the
 * caller never advertises `auto_loading` for a run that will be refused. */
export function autoOptionFor(
  options: PlacementOption[],
  policy: AutoPolicy,
  requestedModel: string,
): PlacementOption | null {
  if (!policy.enabled || options.length === 0) return null;
  if (autoRuns.has(requestedModel)) return null; // a run for this model is in flight
  if (autoRuns.size >= AUTO_MAX_CONCURRENT_RUNS) return null; // envelope cap
  if ((autoFailures.get(requestedModel) ?? 0) > Date.now() - AUTO_FAILURE_COOLDOWN_MS) return null;
  const alongside = options.find((o) => o.kind !== 'displace');
  if (alongside) return alongside;
  const displace = options.find((o) => o.kind === 'displace');
  if (displace && policy.allow_displace.includes(displace.model)) return displace;
  return null;
}

/** Fire-and-forget the auto enforcement for one parked placement id.
 * Resolves the pending entry on success; marks it auto_failed on failure.
 * Never throws to the caller (the admission answer is already built) and
 * never REJECTS (a ledger-write throw inside the run would otherwise be an
 * unhandled rejection that kills the dashboard daemon). */
export function scheduleAutoResolution(
  registry: ModelRegistry,
  requestedModel: string,
  option: PlacementOption,
  placementId: string,
  opts: EnforceOpts & { enforce?: typeof enforceOption } = {},
): void {
  if (autoRuns.has(requestedModel)) return; // one run per model
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  // The entry must outlive the enforcement it supervises (and the queue
  // wait in front of it), or the client's next retry mints a fresh entry
  // and a second concurrent run for the same model.
  try {
    withLedger(ledgerPath, (l) => {
      const p = l.pending.find((e) => e.id === placementId);
      if (p) p.expires_at = new Date(Date.now() + AUTO_PENDING_WINDOW_MS).toISOString();
    });
  } catch {
    // Lock contention at schedule time: run anyway; TTL expiry is the
    // fallback heal for whatever the run cannot update.
  }
  // Snapshot the tail BEFORE reassigning it below: the run must await the
  // PREVIOUS runs' tail, never a promise derived from itself (a self-await
  // deadlocks the run forever — found live during phase-4 review fixes).
  const tail = autoTail;
  const run = (async () => {
    // Return the park answer FIRST: enforcement's synchronous prefix
    // (device probes, systemctl is-active, the ledger lock) must not run
    // inline in the admit handler, which the proxy holds to a 2s timeout.
    await new Promise((r) => setImmediate(r));
    // Single-flight: one machine-wide mutation at a time.
    await tail;
    let result: EnforceResult;
    try {
      result = await (opts.enforce ?? enforceOption)(registry, requestedModel, option, opts);
    } catch (err) {
      result = { ok: false, steps: [], error: (err as Error).message };
    }
    try {
      withLedger(ledgerPath, (l) => {
        if (result.ok) {
          l.pending = l.pending.filter((p) => p.id !== placementId);
        } else {
          // One attempt per placement id: mark it so retries park with the
          // honest reason and the operator sees it in `uap models pending`.
          const p = l.pending.find((e) => e.id === placementId);
          if (p) p.reason = 'auto_failed';
        }
      });
    } catch {
      // Never reject: the entry stays auto_loading and self-heals via TTL
      // expiry; killing the controller over a lock hiccup is the one
      // outcome this background run must never produce.
    }
    if (result.ok) autoFailures.delete(requestedModel);
    else autoFailures.set(requestedModel, Date.now());
  })();
  const tracked = run.finally(() => autoRuns.delete(requestedModel));
  tracked.catch(() => undefined); // no-op: the body cannot reject, and this keeps it that way
  autoRuns.set(requestedModel, tracked);
  autoTail = run.then(
    () => undefined,
    () => undefined,
  );
}

/** Test seam only: the run/failure maps are process-local, and a suite run
 * in one process would otherwise carry cooldowns across test cases. */
export function resetAutoSchedulerForTests(): void {
  autoRuns.clear();
  autoFailures.clear();
  autoTail = Promise.resolve();
}
