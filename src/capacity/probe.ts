/**
 * Host probes for the capacity doctor: systemd unit state, HTTP liveness for
 * unit-less services, and GPU headroom.
 * execFileSync with argument arrays only (no shell); every probe fails soft
 * to an unavailable flag — the health computation decides what that means.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  parsePolicy,
  computeHealth,
  type CapacityPolicy,
  type Health,
  type ServiceReport,
} from './policy.js';
import { sanitizeServerText } from '../inference/probe.js';

export type ProbeState = ServiceReport['probed'];

const PROBE_TIMEOUT_MS = 5000; // a wedged driver/D-Bus must fail soft, not hang

/** systemctl show <unit> for the declared scope. Undefined fields when the
 * unit or systemctl is missing. `--` terminates option parsing so even a
 * validated unit name is never reinterpreted as a flag. */
export function probeSystemd(unit: string, scope: 'user' | 'system'): ProbeState | null {
  // Flags BEFORE `--`, unit AFTER it: `show unit -p ...` would make `-p` a
  // unit name (systemctl then reports the real unit as inactive — false DARK).
  const args = scope === 'user' ? ['--user', 'show'] : ['show'];
  try {
    const out = execFileSync(
      'systemctl',
      [...args, '-p', 'ActiveState,SubState,NRestarts,MainPID,MemoryCurrent,ExecStart', '--', unit],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS },
    );
    const props = Object.fromEntries(
      out.split('\n').filter(Boolean).map((l) => {
        const eq = l.indexOf('=');
        return [l.slice(0, eq), l.slice(eq + 1)];
      }),
    );
    const restarts = Number(props.NRestarts);
    const pid = Number(props.MainPID);
    const mem = Number(props.MemoryCurrent); // bytes; "[not set]" → NaN
    return {
      activeState: props.ActiveState || 'unknown',
      subState: props.SubState || undefined,
      nRestarts: Number.isFinite(restarts) && props.NRestarts ? restarts : undefined,
      mainPid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      memoryCurrentMiB: Number.isFinite(mem) && mem > 0 ? Math.round(mem / 1048576) : undefined,
      // systemd renders ExecStart as a single-line struct; the flags are in
      // there verbatim, which is all execStartMustContain needs. Probed so
      // the doctor can catch a unit whose flags have drifted from the policy
      // — previously it only ever saw liveness, never configuration.
      execStart: props.ExecStart || undefined,
    };
  } catch {
    return null; // no systemctl / timeout (container, macOS) — UNKNOWN, not GREEN
  }
}

/** Free VRAM (MiB) on GPU 0 via nvidia-smi; null when no GPU/tool. */
export function probeGpuFreeMiB(): number | null {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS },
    );
    const first = out.split('\n')[0]?.trim();
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Policy resolution: explicit path, project config/, then user config. */
export function loadPolicy(projectDir: string, explicitPath?: string): { policy: CapacityPolicy; path: string } {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        join(projectDir, 'config', 'capacity-policy.json'),
        join(homedir(), '.config', 'uap', 'capacity-policy.json'),
      ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return { policy: parsePolicy(readFileSync(path, 'utf-8'), path), path };
    }
  }
  throw new Error(
    `no capacity policy found (looked: ${candidates.join(', ')}) — ` +
      'declare one at config/capacity-policy.json; see docs/guides/CAPACITY_POLICY.md',
  );
}

/** Result of an HTTP service probe: liveness plus the engine facts the
 * metricsMustMatch drift check compares. Null = the probe could not run
 * (curl missing, timeout) — UNKNOWN, never a guess. */
export interface HttpProbeState {
  activeState: string;
  subState: string;
  detail?: string;
  metrics?: Record<string, string | number>;
}

/**
 * Probe a unit-less service over HTTP: fetch <url>/metrics with curl and
 * parse it as the declared kind's document. curl (not node fetch) because
 * runDoctor is synchronous and every other probe here shells out the same
 * way — argv array, no shell, timeout, output bounded.
 *
 * The URL comes from the validated policy (http/https, no userinfo, base
 * path only, and canonicalized so what was validated is what is fetched),
 * so it can never start with a dash. NO `-f`: a 4xx/5xx body must reach the
 * parser and classify as unrecognized (DARK — "answering but wrong") rather
 * than turning into a probe failure (UNKNOWN — "tool missing"), which would
 * split one situation across two verdicts.
 */
export function probeHttpService(
  url: string,
  kind: 'strata',
  deps?: { exec?: (cmd: string, args: string[]) => string },
): HttpProbeState | null {
  const exec = deps?.exec ?? ((cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  let body: string;
  try {
    body = exec('curl', [
      '-sS',
      '--max-time',
      `${PROBE_TIMEOUT_MS / 1000}`,
      '--max-filesize',
      '8388608',
      `${url.replace(/\/$/, '')}/metrics`,
    ]);
  } catch {
    return null;
  }
  if (kind !== 'strata') return null; // the only /metrics shape we can parse
  try {
    const doc: unknown = JSON.parse(body);
    const engine = (doc as { engine?: Record<string, unknown> } | null)?.engine;
    if (typeof engine !== 'object' || engine === null) return unrecognized();
    const metrics: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(engine)) {
      if (typeof v === 'string' || typeof v === 'number') metrics[k] = v;
    }
    const model = typeof engine.model === 'string' ? engine.model : undefined;
    if (model === undefined) return unrecognized();
    // The model string is SERVER-PROVIDED and reaches the terminal via the
    // doctor's GREEN reason — strip ANSI/C0 before it ever leaves the probe
    // (CWE-117; shared helper with the inference health path).
    return { activeState: 'active', subState: 'serving', detail: sanitizeServerText(model), metrics };
  } catch {
    return unrecognized();
  }
}

/** curl got a body but it is not the expected document: the service is
 * ANSWERING, which is absent-shaped (DARK), not probe-unavailable (UNKNOWN).
 * A wrong engine behind the port is exactly the misroute this exists to
 * catch. */
function unrecognized(): HttpProbeState {
  return { activeState: 'unrecognized', subState: 'answered, but not the declared document' };
}

export interface DoctorDeps {
  probeSystemd: typeof probeSystemd;
  probeGpuFreeMiB: typeof probeGpuFreeMiB;
  probeHttp?: typeof probeHttpService;
}

/** Probe every declared service and compute its health. Deps are injectable
 * so the matrix is testable without a host. */
export function runDoctor(
  policy: CapacityPolicy,
  deps: DoctorDeps = { probeSystemd, probeGpuFreeMiB, probeHttp: probeHttpService },
): ServiceReport[] {
  // One GPU probe per run, shared across services (nvidia-smi is not cheap).
  const gpuFree = deps.probeGpuFreeMiB();
  const probeHttp = deps.probeHttp ?? probeHttpService;
  return policy.services.map((svc) => {
    if (svc.http) {
      const http = probeHttp(svc.http.url, svc.http.kind);
      const probed: ProbeState = {
        ...(http ?? {}),
        gpuFreeMiB: gpuFree ?? undefined,
      };
      const { health, reasons } = computeHealth(svc, probed, {
        systemd: false,
        gpu: gpuFree !== null,
        http: http !== null,
      });
      return { name: svc.name, health, reasons, probed };
    }
    const sys = svc.systemd ? deps.probeSystemd(svc.systemd.unit, svc.systemd.scope) : null;
    const probed: ProbeState = { ...(sys ?? {}), gpuFreeMiB: gpuFree ?? undefined };
    const { health, reasons } = computeHealth(svc, probed, {
      systemd: sys !== null,
      gpu: gpuFree !== null,
    });
    return { name: svc.name, health, reasons, probed };
  });
}

/** Worst-health rollup for exit codes: DARK > RED > UNKNOWN > GREEN. */
export function worstHealth(reports: ServiceReport[]): Health {
  if (reports.some((r) => r.health === 'DARK')) return 'DARK';
  if (reports.some((r) => r.health === 'RED')) return 'RED';
  if (reports.some((r) => r.health === 'UNKNOWN')) return 'UNKNOWN';
  return 'GREEN';
}
