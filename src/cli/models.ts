/**
 * `uap models` — model placement registry surface (spec §4.7, phase 0).
 *
 * Two subcommands:
 *   validate — load registry (repo + machine-local merge), cross-check against
 *              the capacity policy, report per-field provenance, exit 1 on
 *              error findings. Read-only.
 *   measure  — record the LIVE backend's measured footprint into
 *              ~/.uap/model-registry.json (resident GPU MiB via
 *              nvidia-smi compute-apps for the engine PID, host RSS via
 *              /proc/<pid>/status, KV geometry via /metrics). Fails closed:
 *              anything it cannot verify, it refuses to write.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  REGISTRY_VERSION,
  configCostMiB,
  isMeasuredConfig,
  loadModelRegistry,
  validateRegistry,
  type ModelRegistry,
} from '../placement/registry.js';
import { loadPolicy } from '../capacity/probe.js';
import { looksLikeStrataMetrics, parseStrataEngine } from '../inference/strata.js';

const PROBE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Probe helpers (argv arrays only, no shell — probe.ts doctrine)
// ---------------------------------------------------------------------------

/** Main PID of a user unit; null when systemctl is missing or the unit is
 * inactive. Never a guess. */
function unitMainPid(unit: string): number | null {
  try {
    const out = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--', unit], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    const pid = Number(out.trim().split('=')[1]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** All PIDs in a user unit's cgroup. A backend can be multi-process — the
 * strata unit's MainPID is the serve wrapper while the ENGINE child holds
 * the GPU — so the whole-config footprint must aggregate the cgroup, not
 * trust MainPID. Null when the unit or its cgroup is not readable. */
function unitCgroupPids(unit: string): number[] | null {
  try {
    const out = execFileSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--', unit], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    const cg = out.trim().split('=')[1];
    if (!cg) return null;
    const procs = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, 'utf-8');
    return procs
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((p) => Number.isFinite(p) && p > 0);
  } catch {
    return null;
  }
}

/** PID of whatever listens on the port, via `ss -ltnp`. Fallback for
 * unit-less backends. Null when nothing is listening. */
function listeningPortPid(port: number): number | null {
  try {
    const out = execFileSync('ss', ['-ltnp', `sport = :${port}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    const m = out.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Whole-config GPU MiB: sum of nvidia-smi compute-apps memory across the
 * given PIDs. Null when none of them hold GPU memory — which is a refusal,
 * not a zero. */
function gpuComputeMiB(pids: number[]): number | null {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS },
    );
    const want = new Set(pids);
    let total: number | null = null;
    for (const line of out.split('\n')) {
      const [p, mem] = line.split(',').map((s) => s.trim());
      if (!want.has(Number(p))) continue;
      const mib = Number(mem);
      if (!Number.isFinite(mib)) continue;
      total = (total ?? 0) + Math.round(mib);
    }
    return total;
  } catch {
    return null;
  }
}

/** Whole-config host RSS (MiB): sum of VmRSS across the given PIDs. Processes
 * that vanish mid-sum are skipped; null only when none could be read. */
function hostRssMiB(pids: number[]): number | null {
  let total: number | null = null;
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (!m) continue;
      total = (total ?? 0) + Math.round(Number(m[1]) / 1024);
    } catch {
      // process exited between cgroup read and proc read — skip it
    }
  }
  return total;
}

async function fetchMetrics(endpoint: string): Promise<unknown> {
  const url = `${endpoint.replace(/\/+$/, '')}/metrics`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function endpointPort(endpoint: string): number | null {
  try {
    return new URL(endpoint).port ? Number(new URL(endpoint).port) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface ModelsValidateOptions {
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
}

export async function modelsValidateCommand(opts: ModelsValidateOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  let findings: ReturnType<typeof validateRegistry> = [];
  try {
    const { policy } = loadPolicy(projectDir);
    findings = validateRegistry(loaded.registry, policy);
  } catch (err) {
    console.error(`capacity policy unavailable: ${(err as Error).message}`);
  }

  console.log(`repo registry:   ${loaded.repoPath}${existsSync(loaded.repoPath) ? '' : '  (missing)'}`);
  console.log(`local registry:  ${loaded.localPath}${existsSync(loaded.localPath) ? '' : '  (missing — no measured footprints on this machine)'}`);
  console.log('');
  for (const [dKey, dev] of Object.entries(loaded.registry.devices)) {
    const total = dev.total_mib !== undefined ? `${dev.total_mib} MiB` : 'total unmeasured';
    const reserved = dev.reserved_mib !== undefined ? `, ${dev.reserved_mib} MiB reserved` : ', reserve unmeasured';
    console.log(`device ${dKey}: ${dev.kind}, ${total}${reserved}`);
  }
  console.log('');
  for (const [mKey, model] of Object.entries(loaded.registry.models)) {
    console.log(`${model.display}  (${mKey})`);
    for (const [cKey, cfg] of Object.entries(model.configs)) {
      if (isMeasuredConfig(cfg)) {
        const src = loaded.measuredFrom.get(`${mKey}/${cKey}`);
        const cost = configCostMiB(cfg, cfg.kv_resident_cells);
        console.log(`  ${cKey}: measured — ${cfg.resident_gpu_mib} MiB GPU, ${cfg.host_rss_mib} MiB RSS, kv ${cfg.kv_kind ?? '?'} (${cfg.kv_resident_cells}/${cfg.context_pool_cells} cells) [${src}]` + (cost === null ? '  cost above pool: unknown' : ''));
      } else {
        console.log(`  ${cKey}: unmeasured — fails closed (servable if resident, never loadable)`);
      }
    }
  }
  console.log('');
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.severity === 'error' ? 'ERROR' : 'WARN '}  ${f.scope}: ${f.message}`);
  } else {
    console.log('validate: no findings');
  }
  const errors = loaded.errors.length + findings.filter((f) => f.severity === 'error').length;
  return errors > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

export interface ModelsMeasureOptions {
  model?: string;
  config?: string;
  endpoint?: string;
  device?: string;
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
  dryRun?: boolean;
}

interface MeasureTarget {
  modelKey: string;
  configKey: string;
  registry: ModelRegistry;
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** Find the registry entry the live backend's advertised model id maps to.
 * Exactly one match or explicit --model/--config; ambiguity is an error, not
 * a guess — attributing a measurement to the wrong entry poisons the
 * registry. */
function resolveMeasureTarget(registry: ModelRegistry, liveModel: string | undefined, modelKey: string | undefined, configKey: string | undefined): MeasureTarget {
  const wantExplicit = modelKey !== undefined || configKey !== undefined;
  if (wantExplicit && (modelKey === undefined || configKey === undefined)) {
    fail('--model and --config must be given together');
  }
  if (modelKey !== undefined && configKey !== undefined) {
    const entry = registry.models[modelKey]?.configs[configKey];
    if (!entry) fail(`no registry config '${modelKey}/${configKey}'`);
    const advertises = registry.models[modelKey].advertises ?? [];
    if (liveModel && advertises.length > 0 && !advertises.includes(liveModel)) {
      fail(`live backend advertises '${liveModel}' but ${modelKey} advertises [${advertises.join(', ')}] — refusing to attribute this measurement`);
    }
    return { modelKey, configKey, registry };
  }
  const matches: MeasureTarget[] = [];
  for (const [mKey, model] of Object.entries(registry.models)) {
    for (const [cKey] of Object.entries(model.configs)) {
      if (liveModel && (model.advertises ?? []).includes(liveModel)) matches.push({ modelKey: mKey, configKey: cKey, registry });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no registry entry advertises '${liveModel ?? '?'}' — pass --model <key> --config <key> to attribute the measurement`);
  fail(`ambiguous: ${matches.map((m) => `${m.modelKey}/${m.configKey}`).join(', ')} all advertise '${liveModel}' — pass --model and --config`);
}

export async function modelsMeasureCommand(opts: ModelsMeasureOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  if (loaded.errors.length > 0) return 1;

  const endpoint = opts.endpoint ?? 'http://127.0.0.1:8080';
  const metrics = await fetchMetrics(endpoint).catch((err: Error) => fail(`${err.message} — is the backend live? measure only works against a resident backend`));
  if (!looksLikeStrataMetrics(metrics)) fail(`${endpoint}/metrics is not a strata metrics document — v1 measure supports strata-kind backends only`);
  const { engine } = parseStrataEngine(metrics);
  if (engine.maxContext === undefined) fail('/metrics engine.max_context missing — refusing to guess the context pool');
  if (engine.kvResident === undefined) fail('/metrics engine.kv_resident missing — refusing to guess the resident KV pool');
  if (engine.model === undefined) fail('/metrics engine.model missing — cannot attribute the measurement');

  const target = resolveMeasureTarget(loaded.registry, engine.model, opts.model, opts.config);
  const model = loaded.registry.models[target.modelKey];
  const entry = model.configs[target.configKey];

  const unit = entry.unit ?? model.unit;
  const port = endpointPort(endpoint);
  // Prefer the unit's whole cgroup (multi-process backends), then MainPID,
  // then the port listener (unit-less single-process backends).
  const pids = (unit ? unitCgroupPids(unit) : null) ?? (unit && unitMainPid(unit) ? [unitMainPid(unit) as number] : null) ?? (port ? [listeningPortPid(port) as number] : []);
  if (pids.length === 0) fail(`cannot find the backend processes (unit '${unit ?? 'none'}', port ${port ?? '?'}) — nothing to measure`);

  const residentGpu = gpuComputeMiB(pids);
  if (residentGpu === null) fail(`nvidia-smi shows no GPU memory held by [${pids.join(', ')}] — refusing to record zero; is the backend on the GPU?`);
  const rss = hostRssMiB(pids);
  if (rss === null) fail(`no /proc/<pid>/status readable for [${pids.join(', ')}] — refusing to guess host RSS`);

  const device = opts.device ?? Object.entries(loaded.registry.devices).find(([, d]) => d.kind === 'gpu')?.[0] ?? 'gpu0';
  // Identity fields (unit/profile/service/...) come from the merged entry so
  // the measured write never drops how the config was found.
  const measured = {
    engine: entry.engine,
    unit: entry.unit,
    profile: entry.profile,
    service: entry.service,
    note: entry.note,
    flags: entry.flags,
    rails: entry.rails,
    resident_gpu_mib: residentGpu,
    host_rss_mib: rss,
    context_pool_cells: engine.maxContext,
    kv_resident_cells: engine.kvResident,
    kv_kind: engine.kv,
    measured_at: new Date().toISOString(),
    measured_on: device,
  };

  console.log(`${target.modelKey}/${target.configKey} (${pids.join(', ')}${unit ? `, unit ${unit}` : ''}):`);
  console.log(`  resident_gpu_mib: ${residentGpu}`);
  console.log(`  host_rss_mib:     ${rss}`);
  console.log(`  context_pool:     ${engine.maxContext} cells, kv ${engine.kv ?? '?'} resident ${engine.kvResident}`);
  if (opts.dryRun) {
    console.log('dry-run: nothing written');
    return 0;
  }

  const localPath = loaded.localPath;
  let localDoc: { version?: number; devices?: ModelRegistry['devices']; models?: ModelRegistry['models'] } = {};
  if (existsSync(localPath)) {
    localDoc = JSON.parse(readFileSync(localPath, 'utf-8')) as typeof localDoc;
  }
  if (localDoc.version !== undefined && localDoc.version !== REGISTRY_VERSION) {
    fail(`${localPath}: unsupported version ${localDoc.version} (expected ${REGISTRY_VERSION}) — refusing to clobber`);
  }
  localDoc.version = REGISTRY_VERSION;
  localDoc.models = localDoc.models ?? {};
  const localModel = (localDoc.models[target.modelKey] = localDoc.models[target.modelKey] ?? { display: model.display, configs: {} });
  localModel.configs = localModel.configs ?? {};
  localModel.configs[target.configKey] = measured;

  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, `${JSON.stringify(localDoc, null, 2)}\n`);
  console.log(`written: ${localPath}`);
  console.log('next: uap models validate');
  return 0;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export type ModelsAction = 'validate' | 'measure';

export async function modelsCommand(action: ModelsAction, opts: Record<string, unknown>): Promise<number> {
  if (action === 'validate') return modelsValidateCommand(opts as ModelsValidateOptions);
  return modelsMeasureCommand(opts as ModelsMeasureOptions);
}
