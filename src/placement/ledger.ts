/**
 * Placement ledger — `~/.uap/placement.json` (spec §4.2).
 *
 * Live state: devices (probe fact), residents (what is loaded, with state),
 * pending placement requests (what is parked awaiting the operator).
 *
 * The ledger records intent; the probe records fact. Reads refresh device
 * free memory from the live probes — never from the last writer's snapshot —
 * and disagreement between the two is surfaced, not averaged.
 *
 * Writers hold an advisory lock (the mkdirSync-atomic pattern from
 * src/cli/proxy-lifecycle.ts) and re-read before committing, so a stale view
 * cannot clobber. Lock acquisition fails CLOSED (throws): a lost ledger write
 * must be loud.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { z } from 'zod';
import { gpuStatsByIndex, hostAvailableMiB } from './probes.js';
import { isMeasuredConfig, type ModelRegistry } from './registry.js';

export const LEDGER_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const LedgerDeviceStateSchema = z.object({
  kind: z.enum(['gpu', 'cpu']),
  total_mib: z.number().int().positive().optional(),
  free_mib: z.number().int().nonnegative().optional(),
  reserved_mib: z.number().int().nonnegative().optional(),
  source: z.string().optional(),
});
export type LedgerDeviceState = z.infer<typeof LedgerDeviceStateSchema>;

export const ResidentStateSchema = z.enum(['hot', 'warming', 'paused', 'draining']);
export type ResidentState = z.infer<typeof ResidentStateSchema>;

export const LedgerResidentSchema = z.object({
  model: z.string(),
  config: z.string(),
  device: z.string(),
  engine: z.string().optional(),
  endpoint: z.string().optional(),
  unit: z.string().optional(),
  state: ResidentStateSchema,
  gpu_mib: z.number().int().positive().optional(),
  host_rss_mib: z.number().int().positive().optional(),
  holders: z.array(z.string()).default([]),
  since: z.string(),
});
export type LedgerResident = z.infer<typeof LedgerResidentSchema>;

export const LedgerPendingSchema = z.object({
  id: z.string(),
  requested_model: z.string(),
  client: z.string().optional(),
  session: z.string().optional(),
  pid: z.number().int().positive().optional(),
  created_at: z.string(),
  expires_at: z.string(),
  reason: z.string().optional(),
});
export type LedgerPending = z.infer<typeof LedgerPendingSchema>;

export const PlacementLedgerSchema = z.object({
  version: z.literal(LEDGER_VERSION),
  updated_at: z.string().optional(),
  devices: z.record(z.string(), LedgerDeviceStateSchema),
  residents: z.array(LedgerResidentSchema),
  pending: z.array(LedgerPendingSchema),
});
export type PlacementLedger = z.infer<typeof PlacementLedgerSchema>;

// ---------------------------------------------------------------------------
// Paths, load, save
// ---------------------------------------------------------------------------

export function placementLedgerPath(): string {
  return process.env.UAP_PLACEMENT_LEDGER ?? join(homedir(), '.uap', 'placement.json');
}

export function emptyLedger(): PlacementLedger {
  return { version: LEDGER_VERSION, devices: {}, residents: [], pending: [] };
}

export function loadLedger(path: string = placementLedgerPath()): PlacementLedger {
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = PlacementLedgerSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    return parsed.success ? parsed.data : emptyLedger(); // corrupt → empty, fail closed
  } catch {
    return emptyLedger(); // unparseable → empty, never a partial read
  }
}

/** Atomic write: tmp file + rename, so a reader never sees a torn document. */
function saveLedgerAtomically(path: string, ledger: PlacementLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Advisory lock (mkdirSync-atomic, stale-steal — proxy-lifecycle pattern,
// but fail-CLOSED: a ledger writer that cannot take the lock must not write)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;

export function acquireLedgerLock(path: string, timeoutMs = 5000): boolean {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: succeeds only if it did not exist
      return true;
    } catch {
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true }); // steal a crashed holder
          continue;
        }
      } catch {
        continue; // vanished between attempts — retry
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // sleep 100ms, sync context
    }
  }
}

export function releaseLedgerLock(path: string): void {
  rmSync(`${path}.lock`, { recursive: true, force: true });
}

/** Mutate the ledger under the advisory lock: re-read, apply, stamp
 * updated_at, write atomically. Throws (fails closed) when the lock cannot
 * be taken — two writers must never interleave. */
export function withLedger(
  path: string = placementLedgerPath(),
  mutate: (ledger: PlacementLedger) => void,
): PlacementLedger {
  if (!acquireLedgerLock(path)) {
    throw new Error(`placement ledger lock held longer than expected: ${path}.lock`);
  }
  try {
    const ledger = loadLedger(path);
    mutate(ledger);
    ledger.updated_at = new Date().toISOString();
    saveLedgerAtomically(path, ledger);
    return ledger;
  } finally {
    releaseLedgerLock(path);
  }
}

// ---------------------------------------------------------------------------
// Device fact: probe live, overlay onto registry shape
// ---------------------------------------------------------------------------

/** Live free memory for every registry device, from the probes. gpuN keys map
 * to nvidia-smi index N; cpu keys read MemAvailable. Unprobeable devices
 * carry no free_mib — unknown, never guessed. */
export function probeDeviceStates(
  registry: ModelRegistry,
  opts?: { gpu?: Map<number, { total_mib?: number; free_mib?: number }>; hostAvailable?: number | null },
): Record<string, LedgerDeviceState> {
  const gpu = opts?.gpu ?? gpuStatsByIndex();
  const hostAvailable = opts?.hostAvailable !== undefined ? opts.hostAvailable : hostAvailableMiB();
  const out: Record<string, LedgerDeviceState> = {};
  for (const [key, dev] of Object.entries(registry.devices)) {
    const state: LedgerDeviceState = { kind: dev.kind, total_mib: dev.total_mib, reserved_mib: dev.reserved_mib };
    if (dev.kind === 'gpu') {
      const idx = /^gpu(\d+)$/.exec(key);
      const stats = idx ? gpu.get(Number(idx[1])) : undefined;
      if (stats?.free_mib !== undefined) {
        state.free_mib = stats.free_mib;
        state.source = 'nvidia-smi';
      } else {
        state.source = 'unprobed';
      }
    } else {
      if (typeof hostAvailable === 'number') {
        state.free_mib = hostAvailable;
        state.source = 'MemAvailable';
      } else {
        state.source = 'unprobed';
      }
    }
    out[key] = state;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconcile: align ledger residents with what is actually running
// ---------------------------------------------------------------------------

/** Derive residents from live unit activity. A registry config whose unit
 * is active IS a resident (fact), regardless of measurement — the ledger
 * records what runs; measurement gates what may be LOADED. Measured
 * residents carry their declared cost so the admission budget sum has real
 * numbers; unmeasured ones carry none and admission fails closed on them.
 * The `active` predicate is injectable for tests. */
export function deriveLiveResidents(
  registry: ModelRegistry,
  isActive: (unit: string) => boolean = () => false,
): LedgerResident[] {
  const residents: LedgerResident[] = [];
  for (const [mKey, model] of Object.entries(registry.models)) {
    for (const [cKey, cfg] of Object.entries(model.configs)) {
      const unit = cfg.unit ?? model.unit;
      if (!unit || !isActive(unit)) continue;
      residents.push({
        model: mKey,
        config: cKey,
        device: model.affinity?.device[0] ?? 'gpu0',
        engine: cfg.engine ?? model.engine,
        endpoint: model.endpoint,
        unit,
        state: 'hot',
        gpu_mib: isMeasuredConfig(cfg) ? cfg.resident_gpu_mib : undefined,
        host_rss_mib: isMeasuredConfig(cfg) ? cfg.host_rss_mib : undefined,
        holders: [],
        since: new Date().toISOString(),
      });
    }
  }
  return residents;
}

/** Refresh device facts + reconcile residents in one locked write. Returns
 * the resulting ledger. Measured gpu/host figures on reconciled residents
 * come from the registry measurement when present (display), from the live
 * process when possible — Phase 1 keeps registry values and leaves live
 * attribution to `measure`. */
export function syncLedger(
  registry: ModelRegistry,
  path: string = placementLedgerPath(),
  isActive: (unit: string) => boolean = () => false,
  opts?: { gpuFree?: Map<number, number>; hostAvailable?: number | null },
): PlacementLedger {
  const devices = probeDeviceStates(registry, opts);
  const residents = deriveLiveResidents(registry, isActive);
  return withLedger(path, (ledger) => {
    ledger.devices = devices;
    ledger.residents = residents;
    // Pending entries survive the sync: they are requests awaiting the
    // operator, not backend state. Expired ones are pruned.
    const now = new Date().toISOString();
    ledger.pending = ledger.pending.filter((p) => p.expires_at > now);
  });
}
