/**
 * Capacity policy as code (uplift 0.5).
 *
 * Generalizes the 2026-09-18 llama.cpp OOM-fix discipline: every UAP-managed
 * service declares its resource budget, its headroom requirement, and what
 * GREEN/RED/DARK mean for it. `uap doctor` probes each declared service and
 * reports violations. The policy is data (config/capacity-policy.json); the
 * judgment is deterministic code; fail-open posture is per-probe (a missing
 * systemctl/nvidia-smi yields UNKNOWN, never a fabricated GREEN).
 */

export interface ServicePolicy {
  /** Display name. */
  name: string;
  systemd: {
    unit: string;
    scope: 'user' | 'system';
  };
  /** Declared resource budget the service is configured to stay inside. */
  budget?: {
    vramMiB?: number;
    rssMiB?: number;
    /** Free-text provenance, e.g. "--vbr-vram 5120M (OOM fix 2026-09-18)". */
    note?: string;
  };
  /** Headroom the HOST must keep for the service to be safe. */
  headroom?: {
    /** Minimum free VRAM on the GPU; below this, OOM territory. */
    gpuMinFreeMiB?: number;
  };
  /** Restart discipline: crashes since the last fix are budgeted. */
  restartBudget?: {
    /** NRestarts value accepted as historical (pre-fix baseline). */
    knownRestarts: number;
    /** New restarts tolerated beyond the known count before RED. */
    allowedNew: number;
  };
}

export interface CapacityPolicy {
  version: number;
  services: ServicePolicy[];
}

export type Health = 'GREEN' | 'RED' | 'DARK' | 'UNKNOWN';

export interface ServiceReport {
  name: string;
  health: Health;
  reasons: string[];
  probed: {
    activeState?: string;
    subState?: string;
    nRestarts?: number;
    mainPid?: number;
    memoryCurrentMiB?: number;
    gpuFreeMiB?: number;
  };
}

export class PolicyError extends Error {}

/** systemd unit names: strict charset, never a leading dash. A name like
 * "--host=x.service" ends in .service but is parsed by systemctl as a FLAG —
 * --host would open an SSH connection to an attacker-chosen host (CWE-88).
 * The probe also passes `--` before the unit; validation is the first wall. */
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;

/** Parse + validate a policy document. Malformed input throws loudly with
 * the offending path — a capacity policy that half-loads is worse than none. */
export function parsePolicy(text: string, source = 'policy'): CapacityPolicy {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`${source}: invalid JSON — ${(err as Error).message}`);
  }
  const policy = data as Partial<CapacityPolicy>;
  if (policy?.version !== 1) throw new PolicyError(`${source}: "version": 1 required`);
  if (!Array.isArray(policy.services) || policy.services.length === 0) {
    throw new PolicyError(`${source}: "services" must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const [i, svc] of policy.services.entries()) {
    const where = `${source} services[${i}]`;
    if (!svc || typeof svc !== 'object') throw new PolicyError(`${where}: must be an object`);
    if (typeof svc.name !== 'string' || !svc.name.trim()) {
      throw new PolicyError(`${where}: "name" is required`);
    }
    if (seen.has(svc.name)) throw new PolicyError(`${where}: duplicate service "${svc.name}"`);
    seen.add(svc.name);
    if (typeof svc.systemd?.unit !== 'string' || !UNIT_NAME_RE.test(svc.systemd.unit)) {
      throw new PolicyError(
        `${where}: systemd.unit must match ${UNIT_NAME_RE} (no flags, whitespace, or leading dashes)`,
      );
    }
    if (svc.systemd.scope !== 'user' && svc.systemd.scope !== 'system') {
      throw new PolicyError(`${where}: systemd.scope must be "user" or "system"`);
    }
    for (const [section, keys] of [
      ['budget', ['vramMiB', 'rssMiB']],
      ['headroom', ['gpuMinFreeMiB']],
    ] as const) {
      const block = (svc as unknown as Record<string, Record<string, unknown> | undefined>)[section];
      for (const key of keys) {
        const v = block?.[key];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          throw new PolicyError(`${where}: ${section}.${key} must be a non-negative number`);
        }
      }
    }
    const rb = svc.restartBudget;
    if (rb !== undefined) {
      for (const key of ['knownRestarts', 'allowedNew'] as const) {
        const v = rb[key];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          throw new PolicyError(`${where}: restartBudget.${key} must be a non-negative integer`);
        }
      }
    }
  }
  return policy as CapacityPolicy;
}

/** Pure health computation over a probed state — the deterministic core,
 * fully testable without systemd or a GPU. */
export function computeHealth(
  svc: ServicePolicy,
  probed: ServiceReport['probed'],
  probeAvailable: { systemd: boolean; gpu: boolean },
): Pick<ServiceReport, 'health' | 'reasons'> {
  const reasons: string[] = [];
  if (!probeAvailable.systemd) {
    return { health: 'UNKNOWN', reasons: ['systemctl unavailable — cannot probe the unit'] };
  }
  const state = probed.activeState ?? 'unknown';

  // DARK: not serving. The discipline from the OOM fix: a service that is
  // down or crash-looping is not "degraded", it is absent.
  if (state === 'failed' || state === 'inactive' || state === 'unknown') {
    return { health: 'DARK', reasons: [`unit ${svc.systemd.unit} is ${state} — not serving`] };
  }

  // RED: activating (esp. subState=auto-restart) means the unit is NOT yet
  // serving — a Restart=always crash loop sits exactly here. Down-looping is
  // never GREEN, with or without a declared restartBudget.
  if (state === 'activating' || probed.subState === 'auto-restart') {
    return {
      health: 'RED',
      reasons: [`unit ${svc.systemd.unit} is ${state}/${probed.subState ?? '?'} — not yet serving (crash-loop candidate)`],
    };
  }

  // RED: serving, but a budget is violated.
  const rb = svc.restartBudget;
  if (rb && probed.nRestarts !== undefined) {
    const allowed = rb.knownRestarts + rb.allowedNew;
    if (probed.nRestarts > allowed) {
      reasons.push(
        `NRestarts=${probed.nRestarts} exceeds budget ${allowed} ` +
          `(${rb.knownRestarts} known + ${rb.allowedNew} new) — new crashes since the baseline`,
      );
    }
  }
  if (svc.headroom?.gpuMinFreeMiB !== undefined) {
    if (!probeAvailable.gpu || probed.gpuFreeMiB === undefined) {
      reasons.push('gpu headroom declared but nvidia-smi unavailable — headroom unverified');
    } else if (probed.gpuFreeMiB < svc.headroom.gpuMinFreeMiB) {
      reasons.push(
        `GPU free ${probed.gpuFreeMiB} MiB below required headroom ${svc.headroom.gpuMinFreeMiB} MiB — OOM territory`,
      );
    }
  }

  // RSS budget: enforced against the unit's MemoryCurrent. Doctrine: a
  // declared budget that cannot be verified is not healthy (RED), matching
  // the unverified-headroom rule. budget.vramMiB is NOT compared against the
  // process's total GPU footprint — it declares the service's own configured
  // allocator limit (e.g. --vbr-vram), which the server enforces internally;
  // the host-side invariant the doctor owns is gpuMinFreeMiB headroom.
  if (svc.budget?.rssMiB !== undefined) {
    if (probed.memoryCurrentMiB === undefined) {
      reasons.push('rssMiB budget declared but MemoryCurrent unavailable — budget unverified');
    } else if (probed.memoryCurrentMiB > svc.budget.rssMiB) {
      reasons.push(
        `RSS ${probed.memoryCurrentMiB} MiB exceeds declared budget ${svc.budget.rssMiB} MiB`,
      );
    }
  }
  if (reasons.length > 0) return { health: 'RED', reasons };

  reasons.push(`active (${probed.subState ?? 'running'}), all budgets inside policy`);
  return { health: 'GREEN', reasons };
}
