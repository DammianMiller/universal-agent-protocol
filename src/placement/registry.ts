/**
 * Model placement registry: repo defaults merged with machine-local
 * measurements.
 *
 * Two files, deep-merged local-over-repo (ADR-0006, decision 1):
 *   - `config/model-registry.json`  (repo): shape — models, configs, units,
 *     profiles, affinity, device kinds. Reviewable, machine-independent.
 *   - `~/.uap/model-registry.json`  (local): measurements — device totals,
 *     `reserved_mib`, and each config's `resident_gpu_mib` / `host_rss_mib`.
 *     A footprint is a property of this hardware, not of the repo.
 *
 * Fail-closed doctrine (docs/specs/operator-model-placement.md §4.1): a config
 * without a measurement is `unmeasured`. It may be served if already
 * resident; it may never be loaded, and it never enters an eviction candidate
 * set. Unknown cost is never guessed — guessing is how a 24 GiB card gets
 * OOM-killed.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import type { CapacityPolicy } from '../capacity/policy.js';

export const REGISTRY_VERSION = 1;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DeviceSchema = z.object({
  kind: z.enum(['gpu', 'cpu']),
  name: z.string().optional(),
  total_mib: z.number().int().positive().optional(),
  reserved_mib: z.number().int().nonnegative().optional(),
  reserve_reason: z.string().optional(),
});
export type RegistryDevice = z.infer<typeof DeviceSchema>;

/** Valid systemd unit name (for the effects placement builds from it:
 * systemctl argv, drop-in file paths, drop-in content). Charset excludes
 * `/`, whitespace, and control characters (no path traversal, no line
 * injection into drop-in files); a leading dot or any `..` run is refused.
 * The registry comes from the repo's config/ — a cloned repo must not get
 * to write outside ~/.config/systemd/user or inject `[Service]` sections. */
const UNIT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;
export function validUnitName(unit: string): boolean {
  return UNIT_NAME_RE.test(unit) && !unit.includes('..');
}
const UnitNameSchema = z.string().refine(validUnitName, {
  message: 'invalid systemd unit name (charset [A-Za-z0-9_.@-], no leading dot, no ..)',
});

/** Identity fields a config carries regardless of measured state, so a
 * `measure` write never drops the unit/profile/service it was found through. */
const configIdentity = {
  engine: z.string().optional(),
  unit: UnitNameSchema.optional(),
  profile: z.string().optional(),
  /** Capacity-policy service name this config is cross-checked against
   * (overrides the model-level `service`). The policy's `services` is a
   * LIST keyed by `name` — never assume a map. */
  service: z.string().optional(),
  note: z.string().optional(),
  flags: z.array(z.string()).optional(),
  rails: z.number().int().positive().optional(),
};

/** A measured footprint. `measured_at` is the discriminator in practice: it
 * is present iff the config has a measurement. `measured_on` gates reuse —
 * a footprint measured on one device class is not valid for another. */
export const MeasuredConfigSchema = z.object({
  ...configIdentity,
  resident_gpu_mib: z.number().int().positive(),
  host_rss_mib: z.number().int().positive(),
  context_pool_cells: z.number().int().positive(),
  per_session_cap_cells: z.number().int().positive().optional(),
  kv_resident_cells: z.number().int().positive(),
  kv_kind: z.string().optional(),
  /** Marginal KV cost above the resident pool. Absent = unknown, and cost
   * above the pool fails closed rather than extrapolating. */
  kv_mib_per_1k_cells: z.number().positive().optional(),
  measured_at: z.string(),
  measured_on: z.string(),
});
export type MeasuredConfigEntry = z.infer<typeof MeasuredConfigSchema>;

export const UnmeasuredConfigSchema = z.object({
  ...configIdentity,
  status: z.literal('unmeasured'),
});
export type UnmeasuredConfigEntry = z.infer<typeof UnmeasuredConfigSchema>;

export const ConfigEntrySchema = z.union([MeasuredConfigSchema, UnmeasuredConfigSchema]);
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

export const ModelEntrySchema = z.object({
  display: z.string(),
  engine: z.string().optional(),
  unit: UnitNameSchema.optional(),
  service: z.string().optional(),
  launch: z.string().optional(),
  endpoint: z.string().optional(),
  task_affinity: z.array(z.string()).optional(),
  affinity: z.object({ device: z.array(z.string()) }).optional(),
  advertises: z.array(z.string()).optional(),
  configs: z.record(z.string(), ConfigEntrySchema),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ModelRegistrySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  devices: z.record(z.string(), DeviceSchema),
  models: z.record(z.string(), ModelEntrySchema),
});
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

/** The machine-local file is an overlay, not a full document: it may carry
 * only models (or only devices). `measure` writes exactly this shape. */
export const RegistryOverlaySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  devices: z.record(z.string(), DeviceSchema).optional(),
  models: z.record(z.string(), ModelEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Type guards and cost math
// ---------------------------------------------------------------------------

export function isMeasuredConfig(cfg: ConfigEntry): cfg is MeasuredConfigEntry {
  return 'measured_at' in cfg && 'resident_gpu_mib' in cfg;
}

/** A config is placeable only with a measurement. This is the fail-closed
 * gate: `unmeasured` never becomes a load or eviction candidate. */
export function isPlaceable(cfg: ConfigEntry): boolean {
  return isMeasuredConfig(cfg);
}

/** Admission cost (MiB) of serving `cells` context on a measured config:
 * whole-config resident figure, plus marginal KV beyond the pool the config
 * already paid for at startup. Returns null when the answer is unknown —
 * `cells` beyond the resident pool with no `kv_mib_per_1k_cells`. Null is
 * "refuse", never "free". */
export function configCostMiB(cfg: MeasuredConfigEntry, cells: number): number | null {
  const overPool = Math.max(0, cells - cfg.kv_resident_cells);
  if (overPool === 0) return cfg.resident_gpu_mib;
  if (cfg.kv_mib_per_1k_cells === undefined) return null;
  return cfg.resident_gpu_mib + (overPool / 1000) * cfg.kv_mib_per_1k_cells;
}

// ---------------------------------------------------------------------------
// Loader: repo defaults + machine-local overrides
// ---------------------------------------------------------------------------

export interface RegistryLoadResult {
  registry: ModelRegistry;
  /** Where each file lives (or would live); existence is checked by the
   * caller via existsSync — a missing file is not an error, it is "no
   * measured footprints on this machine". */
  repoPath: string;
  localPath: string;
  /** Which file supplied each measured config, keyed `${model}/${config}`.
   * Absent = the config is unmeasured. */
  measuredFrom: Map<string, 'repo' | 'local'>;
  /** Parse/merge errors. Non-empty means fail closed on everything that
   * depends on the registry. */
  errors: string[];
}

export function repoRegistryPath(projectDir: string): string {
  return join(projectDir, 'config', 'model-registry.json');
}

export function localRegistryPath(): string {
  return process.env.UAP_MODEL_REGISTRY_LOCAL ?? join(homedir(), '.uap', 'model-registry.json');
}

function parseRegistryFile<S extends z.ZodTypeAny>(path: string, schema: S, errors: string[]): z.infer<S> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    errors.push(`${path}: unreadable (${(err as Error).message})`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    errors.push(`${path}: unparseable JSON (${(err as Error).message})`);
    return null;
  }
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    errors.push(`${path}: invalid registry: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return null;
  }
  return parsed.data;
}

/** Deep-merge local over repo. Devices merge field-by-field; models merge
 * per key; configs merge per key with local winning wholesale (a measured
 * local entry replaces an unmeasured repo entry). */
function mergeRegistries(repo: ModelRegistry, local: ModelRegistry): ModelRegistry {
  const devices: ModelRegistry['devices'] = { ...repo.devices };
  for (const [key, dev] of Object.entries(local.devices)) {
    devices[key] = { ...devices[key], ...dev };
  }
  const models: ModelRegistry['models'] = { ...repo.models };
  for (const [key, model] of Object.entries(local.models)) {
    const base = models[key];
    if (!base) {
      models[key] = model;
      continue;
    }
    models[key] = { ...base, ...model, configs: { ...base.configs, ...model.configs } };
  }
  return { version: REGISTRY_VERSION, devices, models };
}

export function loadModelRegistry(
  projectDir: string,
  opts?: { repoPath?: string; localPath?: string },
): RegistryLoadResult {
  const errors: string[] = [];
  const repoPath = opts?.repoPath ?? repoRegistryPath(projectDir);
  const localPath = opts?.localPath ?? localRegistryPath();

  const repo = parseRegistryFile(repoPath, ModelRegistrySchema, errors);
  const local = parseRegistryFile(localPath, RegistryOverlaySchema, errors);
  if (!repo) {
    return { registry: { version: REGISTRY_VERSION, devices: {}, models: {} }, repoPath, localPath, measuredFrom: new Map(), errors };
  }
  const merged = local
    ? mergeRegistries(repo, { version: REGISTRY_VERSION, devices: local.devices ?? {}, models: local.models ?? {} })
    : repo;
  const measuredFrom = new Map<string, 'repo' | 'local'>();
  for (const [mKey, model] of Object.entries(merged.models)) {
    for (const [cKey, cfg] of Object.entries(model.configs)) {
      if (!isMeasuredConfig(cfg)) continue;
      const inLocal = local?.models?.[mKey]?.configs[cKey];
      measuredFrom.set(`${mKey}/${cKey}`, inLocal && isMeasuredConfig(inLocal) ? 'local' : 'repo');
    }
  }
  return { registry: merged, repoPath, localPath, measuredFrom, errors };
}

// ---------------------------------------------------------------------------
// Validation: registry ↔ capacity-policy cross-check
// ---------------------------------------------------------------------------

export interface RegistryFinding {
  severity: 'error' | 'warning';
  scope: string;
  message: string;
}

/** The capacity policy service a model/config is cross-checked against
 * (config-level overrides model-level). */
export function crossCheckService(model: ModelEntry, cfg: ConfigEntry): string | undefined {
  return isMeasuredConfig(cfg) ? cfg.service ?? model.service : (cfg as UnmeasuredConfigEntry).service ?? model.service;
}

/** Cross-check the registry against the capacity policy and its own internal
 * consistency. One source of truth per number: a registry entry that
 * contradicts the policy it should agree with is an error, not a warning. */
export function validateRegistry(registry: ModelRegistry, policy: CapacityPolicy): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const serviceByName = new Map(policy.services.map((s) => [s.name, s]));
  const deviceKeys = new Set(Object.keys(registry.devices));

  for (const [mKey, model] of Object.entries(registry.models)) {
    const scope = (cfg: string) => `${mKey}/${cfg}`;
    for (const device of model.affinity?.device ?? []) {
      if (!deviceKeys.has(device)) {
        findings.push({ severity: 'error', scope: `model:${mKey}`, message: `affinity device '${device}' is not declared in devices` });
      }
    }
    for (const [cKey, cfg] of Object.entries(model.configs)) {
      if (isMeasuredConfig(cfg)) {
        if (!deviceKeys.has(cfg.measured_on)) {
          findings.push({ severity: 'error', scope: scope(cKey), message: `measured_on device '${cfg.measured_on}' is not declared in devices` });
        } else if (registry.devices[cfg.measured_on]?.kind !== 'gpu') {
          findings.push({ severity: 'error', scope: scope(cKey), message: `measured_on device '${cfg.measured_on}' is not a gpu` });
        }
        if (cfg.kv_resident_cells > cfg.context_pool_cells) {
          findings.push({ severity: 'error', scope: scope(cKey), message: `kv_resident_cells ${cfg.kv_resident_cells} exceeds context_pool_cells ${cfg.context_pool_cells}` });
        }
        if (cfg.per_session_cap_cells !== undefined && cfg.per_session_cap_cells > cfg.context_pool_cells) {
          findings.push({ severity: 'error', scope: scope(cKey), message: `per_session_cap_cells ${cfg.per_session_cap_cells} exceeds context_pool_cells ${cfg.context_pool_cells}` });
        }
      }

      const svcName = crossCheckService(model, cfg);
      const svc = svcName ? serviceByName.get(svcName) : undefined;
      if (svcName && !svc) {
        findings.push({ severity: 'error', scope: scope(cKey), message: `declares service '${svcName}' but capacity policy has no service by that name` });
        continue;
      }
      if (!svc) {
        if (isMeasuredConfig(cfg)) {
          findings.push({ severity: 'warning', scope: scope(cKey), message: 'measured but no capacity-policy service to cross-check against' });
        }
        continue;
      }
      if (svc.http?.metricsMustMatch && isMeasuredConfig(cfg)) {
        const want = svc.http.metricsMustMatch;
        if ('max_context' in want && want.max_context !== cfg.context_pool_cells) {
          findings.push({ severity: 'error', scope: scope(cKey), message: `context_pool_cells ${cfg.context_pool_cells} contradicts policy metricsMustMatch max_context=${want.max_context}` });
        }
        if ('kv' in want && want.kv !== cfg.kv_kind) {
          findings.push({ severity: 'error', scope: scope(cKey), message: `kv_kind '${cfg.kv_kind}' contradicts policy metricsMustMatch kv='${want.kv}'` });
        }
      } else if (svc.http?.metricsMustMatch && !isMeasuredConfig(cfg)) {
        findings.push({ severity: 'warning', scope: scope(cKey), message: 'cannot cross-check metricsMustMatch: config is unmeasured' });
      }
      if (svc.systemd && model.unit && svc.systemd.unit !== model.unit) {
        findings.push({ severity: 'warning', scope: scope(cKey), message: `unit '${model.unit}' differs from policy service systemd unit '${svc.systemd.unit}'` });
      }
    }
  }

  for (const [dKey, dev] of Object.entries(registry.devices)) {
    if (dev.total_mib !== undefined && dev.reserved_mib !== undefined && dev.reserved_mib > dev.total_mib) {
      findings.push({ severity: 'error', scope: `device:${dKey}`, message: `reserved_mib ${dev.reserved_mib} exceeds total_mib ${dev.total_mib}` });
    }
  }
  return findings;
}
