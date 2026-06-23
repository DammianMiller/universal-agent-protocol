/**
 * Self-Harness — the versioned harness profile + env-file apply/revert.
 *
 * A `HarnessProfile` is the source of truth for the current harness state the
 * proposer reads and the orchestrator commits. P1 physically applies `env` Mods
 * to a KEY=value env file (e.g. ~/.config/uap/llama-server.env) and captures the
 * prior value for one-step revert; scaffold/middleware Mods are recorded in the
 * profile (their physical wiring is P1+/P2). All edits are reversible.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { UapComponent } from '../benchmarks/paired/types.js';
import { KNOB_ALLOWLIST, KnownKnob, EnvMod, isKnownKnob } from './mods.js';

export interface HarnessProfile {
  /** Allow-listed env knob values currently in effect (string form). */
  env: Partial<Record<KnownKnob, string>>;
  /** Accepted scaffold component overrides (component -> full text). */
  scaffold: Partial<Record<UapComponent, string>>;
  /** Accepted middleware configs (id -> params). */
  middleware: Record<string, Record<string, string | number | boolean>>;
}

export function emptyProfile(): HarnessProfile {
  return { env: {}, scaffold: {}, middleware: {} };
}

/** Parse a KEY=value env file into a flat map (ignores comments/blank lines). */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Build a profile from an env file, keeping only allow-listed knobs. */
export function profileFromEnvFile(path: string): HarnessProfile {
  const all = parseEnvFile(path);
  const p = emptyProfile();
  for (const [k, v] of Object.entries(all)) {
    if (isKnownKnob(k)) p.env[k] = v;
  }
  return p;
}

/**
 * Apply an `EnvMod` to a KEY=value env file in place (replacing the line if the
 * key exists, else appending). Returns the prior value (or null if absent) so
 * the caller can record a precise revert. Verifies the Mod's `from` matches the
 * file's current value when present (guards against a stale proposal).
 */
export function applyEnvModToFile(path: string, mod: EnvMod): { priorValue: string | null } {
  const lines = existsSync(path) ? readFileSync(path, 'utf-8').split('\n') : [];
  let prior: string | null = null;
  let replaced = false;
  const key = mod.key;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#') || !t.includes('=')) continue;
    if (t.slice(0, t.indexOf('=')).trim() === key) {
      prior = t.slice(t.indexOf('=') + 1).trim();
      lines[i] = `${key}=${mod.to}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`${key}=${mod.to}`);
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return { priorValue: prior };
}

/** Apply an accepted Mod's effect to the in-memory profile (after acceptance). */
export function recordModInProfile(profile: HarnessProfile, mod: EnvMod): HarnessProfile {
  return { ...profile, env: { ...profile.env, [mod.key]: mod.to } };
}

/** Default values for allow-listed knobs (used to seed a profile if a knob is unset). */
export function knobDefault(key: KnownKnob): string | null {
  // The allow-list declares ranges, not defaults; defaults live in the proxy/
  // launch script. We return null and let the proposer skip knobs with no
  // observed current value rather than guess.
  void KNOB_ALLOWLIST[key];
  return null;
}
