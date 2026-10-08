/**
 * `uap models` — model placement surface (spec §4.7).
 *
 *   validate — registry (repo + machine-local merge) ↔ capacity-policy
 *              cross-check, provenance per measured config. Read-only.
 *   measure  — record the LIVE backend's footprint into
 *              ~/.uap/model-registry.json. Fails closed on anything
 *              unverifiable.
 *   status   — sync + print the placement ledger: devices (probe fact),
 *              residents, headroom.
 *   pending  — list parked placement requests awaiting the operator.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  REGISTRY_VERSION,
  configCostMiB,
  isMeasuredConfig,
  loadModelRegistry,
  validateRegistry,
  type ModelRegistry,
} from '../placement/registry.js';
import {
  gpuComputeMiB,
  gpuStatsByIndex,
  hostRssMiB,
  hostTotalMiB,
  listeningPortPid,
  unitCgroupPids,
  unitMainPid,
  isUnitActive,
} from '../placement/probes.js';
import {
  loadLedger,
  placementLedgerPath,
  syncLedger,
  type PlacementLedger,
} from '../placement/ledger.js';
import { loadPolicy } from '../capacity/probe.js';
import { looksLikeStrataMetrics, parseStrataEngine } from '../inference/strata.js';

const PROBE_TIMEOUT_MS = 5000;

function fail(msg: string): never {
  throw new Error(msg);
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
    if (!liveModel) continue;
    if ((model.advertises ?? []).includes(liveModel)) {
      const configKeys = Object.keys(model.configs);
      for (const cKey of configKeys) matches.push({ modelKey: mKey, configKey: cKey, registry });
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
  const mainPid = unit ? unitMainPid(unit) : null;
  const pids = (unit ? unitCgroupPids(unit) : null) ?? (mainPid ? [mainPid] : null) ?? (port ? [listeningPortPid(port) as number] : []);
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

  // Device facts (spec §4.1.1): the gpu reserve is DERIVED — capacity minus
  // free minus the backend's own compute apps — so unattributed graphics
  // memory lands in the reserve whether or not a PID owns it. The cpu
  // reserve is the documented spec floor, not a measurement.
  const deviceFacts: Record<string, unknown> = {};
  const gpuIdx = /^gpu(\d+)$/.exec(device);
  if (gpuIdx) {
    const stats = gpuStatsByIndex().get(Number(gpuIdx[1]));
    if (stats?.total_mib !== undefined && stats?.free_mib !== undefined) {
      const reserved = Math.max(0, stats.total_mib - stats.free_mib - residentGpu);
      deviceFacts[device] = {
        kind: 'gpu',
        total_mib: stats.total_mib,
        reserved_mib: reserved,
        reserve_reason: `derived: total ${stats.total_mib} − free ${stats.free_mib} − backend compute apps ${residentGpu}; captures desktop + unattributed graphics memory`,
      };
      console.log(`  ${device}: total ${stats.total_mib} MiB, derived reserve ${reserved} MiB (desktop + graphics)`);
    }
  }
  const hostTotal = hostTotalMiB();
  if (hostTotal !== null) {
    deviceFacts.cpu0 = {
      kind: 'cpu',
      total_mib: hostTotal,
      reserved_mib: 8192,
      reserve_reason: 'spec §4.1 floor: page cache and the TS side must survive a 52 GiB engine attach',
    };
    console.log(`  cpu0: total ${hostTotal} MiB, reserve 8192 MiB (spec floor)`);
  }

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
  if (Object.keys(deviceFacts).length > 0) {
    localDoc.devices = { ...localDoc.devices, ...deviceFacts } as typeof localDoc.devices;
  }
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
// status / pending
// ---------------------------------------------------------------------------

export interface ModelsStatusOptions {
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
  ledgerPath?: string;
}

function printLedger(ledger: PlacementLedger): void {
  for (const [dKey, dev] of Object.entries(ledger.devices)) {
    const free = dev.free_mib !== undefined ? `${dev.free_mib} MiB free` : 'free unprobed';
    const total = dev.total_mib !== undefined ? `${dev.total_mib} MiB total` : 'total unmeasured';
    const reserved = dev.reserved_mib !== undefined ? `, ${dev.reserved_mib} reserved` : ', reserve unmeasured';
    console.log(`device ${dKey}: ${dev.kind}, ${total}, ${free}${reserved}  [${dev.source ?? '?'}]`);
  }
  console.log('');
  if (ledger.residents.length === 0) {
    console.log('residents: none');
  }
  for (const r of ledger.residents) {
    const gpu = r.gpu_mib !== undefined ? `, ${r.gpu_mib} MiB GPU` : ', GPU unknown';
    const rss = r.host_rss_mib !== undefined ? `, ${r.host_rss_mib} MiB RSS` : '';
    console.log(`resident ${r.model}/${r.config}  ${r.state} on ${r.device}${gpu}${rss}${r.unit ? `  (${r.unit})` : ''}`);
  }
  console.log('');
  console.log(ledger.pending.length === 0 ? 'pending: none' : `pending: ${ledger.pending.length}`);
  for (const p of ledger.pending) {
    console.log(`  ${p.id} ${p.requested_model} (client ${p.client ?? '?'}, expires ${p.expires_at}) — ${p.reason ?? 'parked'}`);
  }
}

export async function modelsStatusCommand(opts: ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  if (loaded.errors.length > 0) return 1;
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = syncLedger(loaded.registry, ledgerPath, isUnitActive);
  printLedger(ledger);
  return 0;
}

export async function modelsPendingCommand(opts: ModelsStatusOptions = {}): Promise<number> {
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = loadLedger(ledgerPath);
  if (ledger.pending.length === 0) {
    console.log('no pending placement requests');
    return 0;
  }
  const now = Date.now();
  for (const p of ledger.pending) {
    const expires = new Date(p.expires_at).getTime();
    console.log(`${p.id}  ${p.requested_model}`);
    console.log(`  client ${p.client ?? '?'}${p.session ? `, session ${p.session}` : ''}${p.pid ? `, pid ${p.pid}` : ''}`);
    console.log(`  parked ${p.created_at}, expires ${p.expires_at} (${expires > now ? `${Math.round((expires - now) / 1000)}s left` : 'EXPIRED'})`);
    console.log(`  reason: ${p.reason ?? 'parked'}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export type ModelsAction = 'validate' | 'measure' | 'status' | 'pending';

export async function modelsCommand(action: ModelsAction, opts: Record<string, unknown>): Promise<number> {
  if (action === 'validate') return modelsValidateCommand(opts as ModelsValidateOptions);
  if (action === 'measure') return modelsMeasureCommand(opts as ModelsMeasureOptions);
  if (action === 'status') return modelsStatusCommand(opts as ModelsStatusOptions);
  return modelsPendingCommand(opts as ModelsStatusOptions);
}
