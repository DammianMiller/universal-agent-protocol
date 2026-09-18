/**
 * Supervisor policy config — versioned, range-checked, loud.
 *
 * Thresholds are POLICY, not preference: they ship reviewed in
 * `config/supervise-policy.json` and are validated at load. A missing,
 * corrupt, mis-versioned, or out-of-range file throws SupervisorError rather
 * than falling back to invented defaults — supervising with unreviewed
 * numbers is worse than not supervising. Tests and operators may point
 * `UAP_SUPERVISE_POLICY` at an alternate file.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { SupervisorConfig } from './types.js';

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorError';
  }
}

export const POLICY_VERSION = 1;

/** [min, max] per numeric threshold — the review envelope. */
const RANGES: Record<keyof Omit<SupervisorConfig, 'version'>, [number, number]> = {
  stallMinutes: [1, 1440],
  maxMinutes: [1, 2880],
  maxTurns: [1, 1000],
  maxRetries: [0, 10],
  maxFailures: [1, 25],
  debounceMs: [1000, 60_000],
  intervalMs: [5_000, 3_600_000],
  classifierConfidenceMin: [0, 1],
  classifierTau: [0, 1],
  maxVerify: [1, 25],
};

/** The policy shipped with the package (dist/supervise → ../../config). */
export function packagedPolicyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config', 'supervise-policy.json');
}

export function resolvePolicyPath(): string {
  return process.env.UAP_SUPERVISE_POLICY || packagedPolicyPath();
}

/** Validate a parsed policy. Throws SupervisorError on ANY deviation. */
export function validatePolicy(raw: unknown, source: string): SupervisorConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SupervisorError(`supervisor policy ${source}: expected a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== POLICY_VERSION) {
    throw new SupervisorError(
      `supervisor policy ${source}: version must be ${POLICY_VERSION} (got ${JSON.stringify(obj.version)})`
    );
  }
  const out: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new SupervisorError(`supervisor policy ${source}: ${key} must be a finite number`);
    }
    if (v < min || v > max) {
      throw new SupervisorError(`supervisor policy ${source}: ${key}=${v} outside reviewed range [${min}, ${max}]`);
    }
    out[key] = v;
  }
  if (out.intervalMs < out.debounceMs) {
    throw new SupervisorError(
      `supervisor policy ${source}: intervalMs (${out.intervalMs}) must be >= debounceMs (${out.debounceMs})`
    );
  }
  return { version: POLICY_VERSION, ...(out as unknown as Omit<SupervisorConfig, 'version'>) };
}

/** Load + validate the policy. NEVER returns defaults — fail closed. */
export function loadSupervisorConfig(path: string = resolvePolicyPath()): SupervisorConfig {
  if (!existsSync(path)) {
    throw new SupervisorError(
      `supervisor policy not found: ${path} — thresholds ship as reviewed config; refusing to run with defaults`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new SupervisorError(
      `supervisor policy ${path}: unreadable JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  return validatePolicy(parsed, path);
}
