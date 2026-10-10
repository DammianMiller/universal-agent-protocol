/**
 * Idle-resident sweep (spec §4.4.2) — the missing half of auto-placement.
 *
 * Auto-LOAD parks-and-loads on demand; nothing ever UNLOADED a resident,
 * so the first auto-loaded model held its device forever (an idle dflash
 * sat on 17 GB until a person remembered to stop it). The sweep is the
 * consent-gated reverse: after `unload_idle_after_secs` with no gated
 * request served, an `unload_allow`-listed resident is unloaded by the
 * same drain → in-flight check → stop → verify-free → rollback machinery
 * the operator's `uap models unload` uses (`unloadPlacement`).
 *
 * Doctrine, in order:
 *  - OFF by default: no `unload_idle_after_secs` in the policy → no-op.
 *  - Consent per model: `unload_allow` is standing consent, exactly the
 *    `allow_displace` twin. A resident not on the list is never touched.
 *  - Never sooner than the operator armed it: a resident with no usage
 *    record (hand-started, or the clock predates the feature) seeds its
 *    clock at first observation, so arming the policy can never evict a
 *    backend that was idle-before-we-watched.
 *  - Unknown means BUSY: no usage clock is "idle"; `ss` unable to answer
 *    is "busy"; established connections to the endpoint (a client that
 *    bypassed the gate — direct curl, another agent) reset the clock and
 *    skip the sweep, because the usage clock only sees gated traffic.
 *  - The stop itself re-runs the full safety machinery (drain window,
 *    in-flight refusal, rollback) — the sweep only decides WHEN.
 */
import { loadLedger, placementLedgerPath, withLedger } from './ledger.js';
import { endpointEstablishedConns } from './probes.js';
import { unloadPlacement, type EnforceOpts } from './enforce.js';
import { loadAutoPolicy, MIN_UNLOAD_IDLE_SECS, type AutoPolicy } from './auto.js';

export interface IdleSweepDeps {
  /** Test seam for `ss` — returns established-conn count, null unknown. */
  establishedConns?: (endpoint: string | undefined) => number | null;
  /** Test seam for the unload itself. */
  unload?: typeof unloadPlacement;
  /** Test seam for the clock. */
  now?: () => number;
  /** Where sweep events go (the dashboard's console). */
  log?: (message: string) => void;
}

export interface IdleSweepOpts extends IdleSweepDeps {
  ledgerPath?: string;
  policy?: AutoPolicy;
  enforceOpts?: EnforceOpts;
}

export interface IdleSweepResult {
  /** Residents examined this tick. */
  checked: number;
  /** Residents actually unloaded (by model key). */
  unloaded: string[];
  /** Residents whose idle clock was reset (busy endpoint) — by model. */
  deferred: string[];
}

/** Per-model failure backoff (epoch ms until eligible again) — the
 * auto-load twin of `AUTO_FAILURE_COOLDOWN_MS`: a persistently failing
 * unload (verify-free fails because another process holds GPU memory,
 * rollback restarts the units) would otherwise drain→stop→restart the
 * operator's consented backend every 60s, unsupervised. A later success
 * clears the entry. Module-local state, reset seam for tests. */
const failureCooldown = new Map<string, number>();
export const IDLE_UNLOAD_COOLDOWN_MS = 10 * 60_000;
export function resetIdleSweepForTests(): void {
  failureCooldown.clear();
}

/** One sweep tick. Never throws: a fault inside a tick logs and ends the
 * tick — the next tick (60s later) retries; the sweep is background
 * hygiene, not an admission-path gate. */
export async function sweepIdleResidents(
  projectDir: string,
  opts: IdleSweepOpts = {},
): Promise<IdleSweepResult> {
  const log = opts.log ?? (() => {});
  const result: IdleSweepResult = { checked: 0, unloaded: [], deferred: [] };
  const policy = opts.policy ?? loadAutoPolicy();
  const idleAfterMs = policy.unload_idle_after_secs
    ? policy.unload_idle_after_secs * 1000
    : null;
  if (!idleAfterMs) return result; // feature not armed — cheap no-op
  const allow = new Set(policy.unload_allow ?? []);
  if (allow.size === 0) return result; // no standing consent recorded

  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = loadLedger(ledgerPath);
  const now = (opts.now ?? Date.now)();
  const establishedConns =
    opts.establishedConns ?? ((endpoint: string | undefined) => endpointEstablishedConns(endpoint));

  for (const resident of ledger.residents) {
    // Only HOT residents are sweep candidates: `draining` means an operator
    // or auto swap is in flight, and any future state (warming, paused)
    // deserves the same refusal to guess.
    if (resident.state !== 'hot') continue;
    result.checked += 1;
    if (!allow.has(resident.model)) continue; // not consented — never touched
    // A non-expired pending entry means a gated request WANTS this model —
    // parked for the operator or mid-auto-load. Demand exists; the sweep
    // must not race the enforcement that is about to serve it (the window
    // between a reload and its first forward would otherwise read as idle).
    const pending = ledger.pending.some(
      (p) =>
        p.requested_model === resident.model &&
        (!p.expires_at || Date.parse(p.expires_at) > now),
    );
    if (pending) continue;
    const cooldownUntil = failureCooldown.get(resident.model);
    if (cooldownUntil !== undefined && cooldownUntil > now) {
      log(`[idle-sweep] ${resident.model}: in failure cooldown until ${new Date(cooldownUntil).toISOString()}`);
      continue;
    }
    let lastUsed = ledger.usage[resident.model];
    if (lastUsed === undefined) {
      // Clock starts NOW at first observation — an armed policy never
      // evicts a resident for being idle before it started watching. This
      // also covers a RELOAD: a successful unload clears the usage entry,
      // so the next incarnation of the model gets a fresh window instead
      // of inheriting a stale clock that predates it.
      try {
        withLedger(ledgerPath, (l) => {
          if (l.usage[resident.model] === undefined) l.usage[resident.model] = now;
        });
      } catch {
        /* lost seed → retried next tick; conservative either way */
      }
      continue;
    }
    if (now - lastUsed < idleAfterMs) continue; // recently served — busy
    // Port-level safety: the usage clock only sees GATED traffic; a client
    // past the gate (direct connection) counts as use and resets the clock.
    const conns = establishedConns(resident.endpoint);
    if (conns === null) {
      log(`[idle-sweep] ${resident.model}: endpoint state unknown — skipping this tick`);
      continue; // unknown means busy, never a guess that it's idle
    }
    if (conns > 0) {
      try {
        withLedger(ledgerPath, (l) => {
          l.usage[resident.model] = now;
        });
        result.deferred.push(resident.model);
      } catch {
        /* lost touch → the next tick re-checks; still conservative */
      }
      log(`[idle-sweep] ${resident.model}: ${conns} established connection(s) — clock reset`);
      continue;
    }
    // Idle, consented, and the endpoint is quiet. unloadPlacement does
    // drain → in-flight refusal → stop → verify-free → rollback; its own
    // in-flight guard is the second chance to refuse this stop.
    const unload = opts.unload ?? unloadPlacement;
    try {
      const outcome = await unload(projectDir, resident.model, opts.enforceOpts ?? {});
      if (outcome.ok) {
        result.unloaded.push(resident.model);
        failureCooldown.delete(resident.model);
        // The clock must NOT outlive the resident: stale residue would make
        // the next incarnation of this model inherit a pre-reload "last
        // used" timestamp and let the very next tick evict it.
        try {
          withLedger(ledgerPath, (l) => {
            delete l.usage[resident.model];
          });
        } catch {
          /* lost clear → the prune below catches it next tick */
        }
        log(
          `[idle-sweep] ${resident.model}: idle ${Math.round((now - lastUsed) / 1000)}s ` +
            `(policy ${Math.round(idleAfterMs / 1000)}s) — unloaded`,
        );
      } else {
        failureCooldown.set(resident.model, now + IDLE_UNLOAD_COOLDOWN_MS);
        log(
          `[idle-sweep] ${resident.model}: unload refused — ` +
            `${outcome.error ?? 'in-flight work'} (cooldown ${Math.round(IDLE_UNLOAD_COOLDOWN_MS / 60_000)}min)`,
        );
      }
    } catch (err) {
      failureCooldown.set(resident.model, now + IDLE_UNLOAD_COOLDOWN_MS);
      log(`[idle-sweep] ${resident.model}: unload fault — ${(err as Error).message}`);
    }
  }
  // Prune usage residue for models with no live resident — the record
  // would otherwise grow once per model ever served and (worse) hand a
  // future reload a stale clock. Fail-soft: a lost prune retries next tick.
  const live = new Set(ledger.residents.map((r) => r.model));
  const dead = Object.keys(ledger.usage).filter((m) => !live.has(m));
  if (dead.length > 0) {
    try {
      withLedger(ledgerPath, (l) => {
        for (const m of dead) delete l.usage[m];
      });
    } catch {
      /* lost prune → next tick */
    }
  }
  return result;
}

/** Default sweep cadence in the dashboard process. 60s: coarse enough that
 * the extra ledger read is negligible, fine enough that an idle resident
 * goes within a minute of its window. */
const SWEEP_INTERVAL_MS = 60_000;

/** Run the sweep on an interval inside the dashboard (the process that
 * already owns placement enforcement). The returned stop handle is cleared
 * by the server's close(). All policy state is re-read per tick, so the
 * operator's edits to the policy file take effect without a restart.
 * Re-entrancy guard: an unload's 60s drain window exceeds the 60s tick
 * cadence, so overlapping ticks are possible in principle — the draining
 * skip and the ledger lock make them safe, but two concurrent
 * unloadPlacement runs would interleave verify-free deltas on shared
 * devices, so a tick that overlaps is dropped, never queued. */
export function startIdleSweep(
  projectDir: string,
  opts: IdleSweepOpts & { intervalMs?: number } = {},
): { stop: () => void } {
  const log = opts.log ?? ((m: string) => console.warn(m));
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) {
      log('[idle-sweep] previous tick still running — skipping this tick');
      return;
    }
    sweeping = true;
    void sweepIdleResidents(projectDir, { ...opts, log })
      .catch((err) => log(`[idle-sweep] tick fault — ${(err as Error).message}`))
      .finally(() => {
        sweeping = false;
      });
  }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}

/** Registry sanity for tests and future CLI wiring: does this policy arm
 * the sweep at all? Kept beside the loader so the doctrine (absent knob =
 * off) has exactly one spelling. */
export function idleUnloadArmed(policy: AutoPolicy): boolean {
  return Boolean(
    policy.unload_idle_after_secs &&
      policy.unload_idle_after_secs >= MIN_UNLOAD_IDLE_SECS &&
      (policy.unload_allow ?? []).length > 0,
  );
}
