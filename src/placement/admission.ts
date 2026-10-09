/**
 * Admission math and option generation (spec §4.4).
 *
 * The device budget is a SUM, not a free-memory reading:
 *
 *   fits_gpu  = cost_mib ≤ total − Σ(resident figures of everything staying)
 *               − device.reserved_mib
 *   fits_host = host_rss_mib ≤ cpu free + Σ(victims' host_rss_mib) − cpu reserved
 *   fits      = fits_gpu AND fits_host
 *
 * free_mib from nvidia-smi describes what is left AFTER the operator's chosen
 * configuration filled the card — true and useless at the same time. The
 * correct question is whether the intended set fits the device budget.
 *
 * Fail-closed everywhere: an unmeasured config is never a load candidate;
 * an unknown device total, an unknown host free, or an unknown marginal-KV
 * rate each kill the option rather than pass it on a guess.
 */
import { configCostMiB, isMeasuredConfig, type MeasuredConfigEntry, type ModelRegistry } from './registry.js';
import type { LedgerDeviceState, LedgerResident, PlacementLedger } from './ledger.js';

export type OptionKind = 'reuse' | 'load_alongside' | 'displace';

export interface PlacementOption {
  kind: OptionKind;
  model: string;
  config: string;
  device: string;
  /** Admission cost in MiB on the device; null = unknown (only ever present
   * on a reuse option, where nothing is loaded). */
  cost_mib: number | null;
  /** Present only on displace options: the residents that must go. */
  victims?: LedgerResident[];
  /** True when the candidate's task_affinity matches the requesting task. */
  affinityMatch?: boolean;
}

export interface AdmissionResult {
  requested: string;
  /** Does the request map to any registry config at all? */
  matched: boolean;
  /** not_resident_only | not_in_registry | no_measured_config | ok */
  reason: string;
  options: PlacementOption[];
  /** Why each candidate that was not offered was refused. */
  notes: string[];
}

/** Registry configs whose advertised ids (or model key) match the requested
 * wire model. Empty = not in registry → park, never auto-load. */
export function matchingConfigs(registry: ModelRegistry, requested: string): Array<{ model: string; config: string; entry: ModelRegistry['models'][string]['configs'][string] }> {
  const out: Array<{ model: string; config: string; entry: ModelRegistry['models'][string]['configs'][string] }> = [];
  for (const [mKey, model] of Object.entries(registry.models)) {
    const advertises = model.advertises ?? [];
    if (!advertises.includes(requested) && mKey !== requested) continue;
    for (const [cKey, entry] of Object.entries(model.configs)) {
      out.push({ model: mKey, config: cKey, entry });
    }
  }
  return out;
}

function stayingGpuMiB(ledger: PlacementLedger, device: string, victims: LedgerResident[]): number {
  const evicted = new Set(victims.map((v) => `${v.model}/${v.config}`));
  let sum = 0;
  for (const r of ledger.residents) {
    if (r.device !== device || evicted.has(`${r.model}/${r.config}`)) continue;
    // A resident without a measured gpu figure still holds its registry
    // measurement when one exists; without any figure the sum is unknown and
    // the caller must fail closed — handled by returning NaN.
    if (r.gpu_mib === undefined) return Number.NaN;
    sum += r.gpu_mib;
  }
  return sum;
}

/** Enumerate eviction subsets of a device's residents, smallest freed MiB
 * first (spec: smallest displacement ranks above larger). Capped at pairs
 * when the resident set is large, so this stays linear-ish; three+ mutually
 * resident backends on one card is not a real machine state today. */
function evictionSets(residents: LedgerResident[]): LedgerResident[][] {
  const sets: LedgerResident[][] = [];
  const byKey = new Map(residents.map((r) => [`${r.model}/${r.config}`, r]));
  const keys = [...byKey.keys()];
  const max = keys.length <= 6 ? keys.length : 2;
  for (let size = 1; size <= max; size++) {
    const combo: number[] = [];
    const walk = (start: number): void => {
      if (combo.length === size) {
        sets.push(combo.map((i) => byKey.get(keys[i]) as LedgerResident));
        return;
      }
      for (let i = start; i < keys.length; i++) {
        combo.push(i);
        walk(i + 1);
        combo.pop();
      }
    };
    walk(0);
  }
  return sets.sort((a, b) => freedGpuMiB(a) - freedGpuMiB(b));
}

function freedGpuMiB(victims: LedgerResident[]): number {
  return victims.reduce((sum, v) => sum + (v.gpu_mib ?? 0), 0);
}

function freedHostMiB(victims: LedgerResident[]): number | null {
  let sum = 0;
  for (const v of victims) {
    if (v.host_rss_mib === undefined) return null;
    sum += v.host_rss_mib;
  }
  return sum;
}

/** Compute ranked options for a requested model (spec §4.4). Ranking:
 * reuse > load_alongside (affinity match first) > smallest displace >
 * largest displace. Unknown anything = refused, with a note saying why. */
export function computeOptions(
  registry: ModelRegistry,
  ledger: PlacementLedger,
  requested: string,
  opts?: { cells?: number; taskKind?: string },
): AdmissionResult {
  const cells = opts?.cells ?? 32768;
  const candidates = matchingConfigs(registry, requested);
  if (candidates.length === 0) {
    return { requested, matched: false, reason: 'not_in_registry', options: [], notes: [] };
  }
  const notes: string[] = [];
  const options: PlacementOption[] = [];

  // 1. reuse — a resident already satisfies the request. Unmeasured configs
  // are servable when resident; that is the fail-closed rule's other half.
  for (const c of candidates) {
    const resident = ledger.residents.find((r) => r.model === c.model && r.config === c.config && r.state === 'hot');
    if (resident) {
      options.push({ kind: 'reuse', model: c.model, config: c.config, device: resident.device, cost_mib: null });
    }
  }
  if (options.length > 0) return { requested, matched: true, reason: 'ok', options, notes };

  // 2/3. load_alongside and displace — both need a measured config.
  const measured = candidates.filter((c) => isMeasuredConfig(c.entry));
  if (measured.length === 0) {
    return {
      requested,
      matched: true,
      reason: 'no_measured_config',
      options: [],
      notes: ['every matching config is unmeasured — run `uap models measure` against a live instance; fail closed'],
    };
  }

  const cpu = Object.values(ledger.devices).find((d) => d.kind === 'cpu');
  for (const c of measured) {
    const cfg = c.entry as MeasuredConfigEntry;
    const model = registry.models[c.model];
    const cost = configCostMiB(cfg, cells);
    if (cost === null) {
      notes.push(`${c.model}/${c.config}: cost beyond the measured KV pool (cells > ${cfg.kv_resident_cells}) is unknown — refused`);
      continue;
    }
    const affinityMatch = opts?.taskKind !== undefined && (model.task_affinity ?? []).includes(opts.taskKind);
    for (const device of model.affinity?.device ?? [`${cfg.measured_on}`]) {
      const dev = ledger.devices[device];
      if (!dev) {
        notes.push(`${c.model}/${c.config}: device '${device}' not in ledger`);
        continue;
      }
      if (dev.total_mib === undefined || dev.reserved_mib === undefined) {
        notes.push(`${c.model}/${c.config}: device '${device}' total/reserve unmeasured — cannot evaluate load_alongside or displace`);
        continue;
      }

      // 2. load_alongside — nothing displaced.
      const staying = stayingGpuMiB(ledger, device, []);
      const alongsideFits = Number.isFinite(staying) && cost <= dev.total_mib - dev.reserved_mib - staying;
      const hostFits = hostFitsFor(cpu, cfg.host_rss_mib, 0);
      if (alongsideFits && hostFits === true) {
        options.push({ kind: 'load_alongside', model: c.model, config: c.config, device, cost_mib: cost, affinityMatch });
        continue;
      }
      if (alongsideFits && hostFits === null) {
        notes.push(`${c.model}/${c.config}: GPU fits but host free memory unknown — refused`);
      }

      // 3. displace — minimal eviction sets, smallest first.
      const residentsHere = ledger.residents.filter((r) => r.device === device && r.state !== 'draining');
      for (const victims of evictionSets(residentsHere)) {
        const stays = stayingGpuMiB(ledger, device, victims);
        if (!Number.isFinite(stays)) {
          notes.push(`${c.model}/${c.config}: a resident has no measured gpu_mib — cannot compute displacement`);
          break;
        }
        const gpuOk = cost <= dev.total_mib - dev.reserved_mib - stays;
        const freedHost = freedHostMiB(victims);
        const hostOk = freedHost === null ? null : hostFitsFor(cpu, cfg.host_rss_mib, freedHost);
        if (gpuOk && hostOk === true) {
          options.push({ kind: 'displace', model: c.model, config: c.config, device, cost_mib: cost, victims, affinityMatch });
          break; // first (smallest) feasible set per device wins
        }
        if (gpuOk && hostOk === null) {
          notes.push(`${c.model}/${c.config}: victim host_rss unknown — displacement refused`);
          break;
        }
      }
    }
  }

  const rank = (o: PlacementOption): number => {
    if (o.kind === 'reuse') return 0;
    if (o.kind === 'load_alongside') return o.affinityMatch ? 1 : 2;
    return 3 + (o.victims ? freedGpuMiB(o.victims) : 0);
  };
  options.sort((a, b) => rank(a) - rank(b));
  return {
    requested,
    matched: true,
    reason: options.length > 0 ? 'ok' : 'no_feasible_option',
    options,
    notes,
  };
}

/** Host RAM gate: config RSS must fit in (host free + what victims free)
 * minus the cpu reserve. null = unknown (host free unprobeable) → refused. */
function hostFitsFor(
  cpu: LedgerDeviceState | undefined,
  rssMib: number,
  freedMib: number,
): boolean | null {
  if (!cpu) return null;
  if (cpu.free_mib === undefined || cpu.reserved_mib === undefined) return null;
  return rssMib <= cpu.free_mib + freedMib - cpu.reserved_mib;
}
