/**
 * Host probes for the capacity doctor: systemd unit state and GPU headroom.
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

export interface DoctorDeps {
  probeSystemd: typeof probeSystemd;
  probeGpuFreeMiB: typeof probeGpuFreeMiB;
}

/** Probe every declared service and compute its health. Deps are injectable
 * so the matrix is testable without a host. */
export function runDoctor(policy: CapacityPolicy, deps: DoctorDeps = { probeSystemd, probeGpuFreeMiB }): ServiceReport[] {
  // One GPU probe per run, shared across services (nvidia-smi is not cheap).
  const gpuFree = deps.probeGpuFreeMiB();
  return policy.services.map((svc) => {
    const sys = deps.probeSystemd(svc.systemd.unit, svc.systemd.scope);
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
