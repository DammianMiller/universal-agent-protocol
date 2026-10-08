/**
 * Host probes for the placement layer: unit liveness, whole-cgroup process
 * discovery, GPU memory, host RSS, and device free memory.
 *
 * Same doctrine as src/capacity/probe.ts: execFileSync with argv arrays only
 * (no shell), bounded timeouts, every probe fails soft to null — callers
 * decide what null means, and for placement null always means REFUSE, never
 * a guess.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const PROBE_TIMEOUT_MS = 5000;

/** Is a user unit active? Fail-closed to false when systemctl is missing. */
export function isUnitActive(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', '--', unit], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    return out.trim() === 'active';
  } catch {
    return false;
  }
}

/** Main PID of a user unit; null when systemctl is missing or the unit is
 * inactive. Never a guess. */
export function unitMainPid(unit: string): number | null {
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
export function unitCgroupPids(unit: string): number[] | null {
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
export function listeningPortPid(port: number): number | null {
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
 * given PIDs. Null when none of them hold GPU memory — a refusal, not zero. */
export function gpuComputeMiB(pids: number[]): number | null {
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
      if (!p) continue; // trailing newline must not parse as pid 0
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

/** Per-GPU stats keyed by index — one nvidia-smi call for every card.
 * (probeGpuFreeMiB() in src/capacity reads GPU 0 only; the multi-device
 * abstraction needs per-index readings. Spec §5 item 4.) */
export interface GpuStats {
  total_mib?: number;
  free_mib?: number;
}

export function gpuStatsByIndex(): Map<number, GpuStats> {
  const out = new Map<number, GpuStats>();
  try {
    const text = execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS },
    );
    for (const line of text.split('\n')) {
      if (!line.trim()) continue; // trailing newline: Number('')===0 must not become GPU 0
      const [idx, total, free] = line.split(',').map((s) => s.trim());
      const i = Number(idx);
      if (!Number.isFinite(i)) continue;
      const stats: GpuStats = {};
      if (Number.isFinite(Number(total))) stats.total_mib = Math.round(Number(total));
      if (Number.isFinite(Number(free))) stats.free_mib = Math.round(Number(free));
      out.set(i, stats);
    }
  } catch {
    // no nvidia-smi — empty map; every device reads as unprobed
  }
  return out;
}

/** Host total RAM (MiB) from /proc/meminfo MemTotal. Null when unreadable. */
export function hostTotalMiB(): number | null {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const m = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** Host available RAM (MiB) from /proc/meminfo MemAvailable. Null when the
 * file is unreadable (non-Linux). */
export function hostAvailableMiB(): number | null {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** Whole-config host RSS (MiB): sum of VmRSS across the given PIDs.
 * Processes that vanish mid-sum are skipped; null when none could be read. */
export function hostRssMiB(pids: number[]): number | null {
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
