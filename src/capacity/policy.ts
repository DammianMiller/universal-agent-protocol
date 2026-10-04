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
  /**
   * systemd probe source. Exactly one of `systemd` or `http` is required:
   * services that run under a unit (the llama.cpp servers) are probed via
   * systemctl; unit-less services (the strata serve layer, launched by a
   * plain script and reparented to systemd --user) are probed over HTTP.
   */
  systemd?: {
    unit: string;
    scope: 'user' | 'system';
  };
  /**
   * HTTP probe source for a service with no systemd unit. The doctor fetches
   * `<url>/metrics`; for kind 'strata' it must parse as the strata JSON
   * document (engine block with a model). Liveness is "it answers /metrics";
   * configuration drift is checked via `metricsMustMatch` against the
   * document's engine fields.
   */
  http?: {
    /** Base URL; http(s) only, no userinfo, no query/fragment. */
    url: string;
    /** Parser kind — the only backend whose /metrics shape we know. */
    kind: 'strata';
    /**
     * engine.<key> values that MUST match the live document, the
     * execStartMustContain doctrine applied to a service with no ExecStart:
     * a note saying "kv int8, 131072 context" drifts silently unless the
     * load-bearing numbers live somewhere the doctor can compare them.
     */
    metricsMustMatch?: Record<string, string | number>;
  };
  /** Declared resource budget the service is configured to stay inside. */
  budget?: {
    vramMiB?: number;
    rssMiB?: number;
    /** Free-text provenance, e.g. "--vbr-vram 5120M (OOM fix 2026-09-18)". */
    note?: string;
    /**
     * Literal flags that MUST appear in the unit's ExecStart.
     *
     * The `note` field is prose and drifts silently: on 2026-09-20 it still
     * read `-np 1` while the unit had been running `-np 2`, and the doctor
     * reported GREEN because it never looked at ExecStart at all. Anything
     * load-bearing enough to write in the note — rail count, context size, a
     * memory budget — belongs here too, where a mismatch is RED.
     *
     * Matched as plain substrings against the probed ExecStart, so
     * "-np 2" also tolerates surrounding flags in any order.
     */
    execStartMustContain?: string[];
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
    /** The unit's ExecStart command line, when systemctl reported it. */
    execStart?: string;
    /** HTTP-probe detail (e.g. the model id the service advertised). */
    detail?: string;
    /** engine.<key> values the HTTP probe read, for metricsMustMatch. */
    metrics?: Record<string, string | number>;
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
    // Exactly one probe source. Both at once is ambiguous (which one is the
    // truth?); neither is a service the doctor cannot check at all.
    if (Boolean(svc.systemd) === Boolean(svc.http)) {
      throw new PolicyError(`${where}: exactly one of "systemd" or "http" is required`);
    }
    if (svc.systemd) {
      if (typeof svc.systemd.unit !== 'string' || !UNIT_NAME_RE.test(svc.systemd.unit)) {
        throw new PolicyError(
          `${where}: systemd.unit must match ${UNIT_NAME_RE} (no flags, whitespace, or leading dashes)`,
        );
      }
      if (svc.systemd.scope !== 'user' && svc.systemd.scope !== 'system') {
        throw new PolicyError(`${where}: systemd.scope must be "user" or "system"`);
      }
    }
    if (svc.http) {
      if (svc.http.kind !== 'strata') {
        throw new PolicyError(`${where}: http.kind must be "strata" (the only known /metrics shape)`);
      }
      const url = svc.http.url;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new PolicyError(`${where}: http.url must be a valid URL`);
      }
      // The probe shells out to curl with the URL as a positional argument.
      // Only http(s) with no userinfo/query/fragment can never smuggle flags
      // or credentials; loopback is not REQUIRED (a remote model server is a
      // legitimate declaration), but anything weird is rejected here.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new PolicyError(`${where}: http.url must be http(s)`);
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new PolicyError(`${where}: http.url must carry no userinfo, query, or fragment`);
      }
      if (parsed.pathname !== '/' && parsed.pathname !== '') {
        throw new PolicyError(`${where}: http.url must be a base URL with no path`);
      }
      // CANONICAL, not just parseable. The WHATWG parser normalizes away
      // what the RAW string preserves — %-encoded dot-segments (%2e%2e),
      // literal dot-segments (/a/..), an empty query (?), leading
      // whitespace — so a raw string can pass every field check above while
      // curl fetches something other than the validated shape. Require the
      // raw string to equal the parsed href modulo one trailing slash, so
      // the form that was validated is the form that is fetched.
      if (parsed.href !== url && parsed.href !== `${url}/`) {
        throw new PolicyError(
          `${where}: http.url must be canonical — "${url}" normalizes to "${parsed.href}", ` +
            'and the probe must fetch exactly the form that was validated',
        );
      }
      // Unit-only budgets on an http service would be SILENTLY ignored by
      // computeHealth (no MemoryCurrent, no NRestarts). A declared budget
      // that cannot be verified is the exact anti-pattern this policy
      // exists to prevent, so reject at parse time instead.
      if (svc.budget?.rssMiB !== undefined || svc.restartBudget !== undefined) {
        throw new PolicyError(
          `${where}: budget.rssMiB and restartBudget require a systemd unit ` +
            '(MemoryCurrent and NRestarts do not exist for an http-probed service)',
        );
      }
      const must = svc.http.metricsMustMatch;
      if (must !== undefined) {
        for (const [key, value] of Object.entries(must)) {
          if (!/^[a-z0-9_]+$/i.test(key) || key.length === 0) {
            throw new PolicyError(`${where}: http.metricsMustMatch keys must be engine field names`);
          }
          if (typeof value !== 'string' && typeof value !== 'number') {
            throw new PolicyError(`${where}: http.metricsMustMatch.${key} must be a string or number`);
          }
        }
      }
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
    const must = svc.budget?.execStartMustContain;
    if (must !== undefined) {
      if (!Array.isArray(must) || must.some((f) => typeof f !== 'string' || f.length === 0)) {
        throw new PolicyError(`${where}: budget.execStartMustContain must be an array of non-empty strings`);
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
  probeAvailable: { systemd: boolean; gpu: boolean; http?: boolean },
): Pick<ServiceReport, 'health' | 'reasons'> {
  if (svc.http) return computeHttpHealth(svc as ServicePolicy & { http: NonNullable<ServicePolicy['http']> }, probed, probeAvailable);
  // parsePolicy guarantees exactly one source, but computeHealth is exported
  // pure and can be handed a policy built in code — without this guard the
  // unit references below would be lying to the type checker.
  if (!svc.systemd) {
    return { health: 'UNKNOWN', reasons: ['no probe source (systemd or http) declared'] };
  }
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
  // Configuration drift: the unit is serving, but NOT with the flags the
  // policy declares. Same doctrine as the budgets — declared vs probed
  // reality. Unverifiable (systemctl gave us no ExecStart) is called out
  // rather than passed silently.
  const mustContain = svc.budget?.execStartMustContain;
  if (mustContain && mustContain.length > 0) {
    if (!probed.execStart) {
      reasons.push('execStartMustContain declared but ExecStart could not be probed — configuration unverified');
    } else {
      const missing = mustContain.filter((flag) => !probed.execStart!.includes(flag));
      if (missing.length > 0) {
        reasons.push(
          `ExecStart is missing declared flag(s) ${missing.map((f) => `"${f}"`).join(', ')} — ` +
            'the running configuration has drifted from the policy',
        );
      }
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

/**
 * Health for an HTTP-probed service — the same declared-vs-probed doctrine
 * with no unit to lean on: liveness is "it answers /metrics as the expected
 * document", configuration is the metricsMustMatch comparison, and the host
 * headroom check is shared with the systemd path.
 */
function computeHttpHealth(
  svc: ServicePolicy & { http: NonNullable<ServicePolicy['http']> },
  probed: ServiceReport['probed'],
  probeAvailable: { systemd: boolean; gpu: boolean; http?: boolean },
): Pick<ServiceReport, 'health' | 'reasons'> {
  if (!probeAvailable.http) {
    return {
      health: 'UNKNOWN',
      reasons: [`could not reach ${svc.http.url}/metrics — probe unavailable (curl missing or timed out)`],
    };
  }
  // DARK: same doctrine as the systemd path — a service that is not answering
  // is absent, not degraded.
  if (probed.activeState !== 'active') {
    return {
      health: 'DARK',
      reasons: [`service at ${svc.http.url} is not answering /metrics as ${svc.http.kind} — not serving`],
    };
  }

  const reasons: string[] = [];
  // Configuration drift: declared engine fields vs the live document. A
  // declared key the document lacks is UNVERIFIED (RED), not silently
  // passing — the same rule as execStartMustContain.
  for (const [key, expected] of Object.entries(svc.http.metricsMustMatch ?? {})) {
    const actual = probed.metrics?.[key];
    if (actual === undefined) {
      reasons.push(`metricsMustMatch declared engine.${key} but /metrics did not report it — configuration unverified`);
    } else if (actual !== expected) {
      reasons.push(
        `engine.${key} is ${JSON.stringify(actual)}, policy declares ${JSON.stringify(expected)} — ` +
          'the running configuration has drifted from the policy',
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
  if (reasons.length > 0) return { health: 'RED', reasons };

  reasons.push(`serving ${probed.detail ? `(${probed.detail}) ` : ''}at ${svc.http.url}, all budgets inside policy`);
  return { health: 'GREEN', reasons };
}
