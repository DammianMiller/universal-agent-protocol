/**
 * LLM Self-Tuning — model-specific tuning profiles (P1/P3).
 *
 * A `TuningProfile` is the best-known flag configuration for one executor model
 * family, plus the accepted-step history that produced it. It is the durable
 * output of the tuning loop and the prior for a fresh run on the same model.
 * Persisted as JSON under `.uap/self-tuning/<model>.json`, mirroring the
 * self-harness profile-snapshot pattern.
 *
 * Bundled starter profiles (qwen3.6, opus4.8) ship as typed constants (see
 * ./profiles) so they are always present at runtime, and are used as the seed
 * config + as cross-model transfer priors.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { normalizeModel } from '../self-harness/weakness.js';
import { FlagChange, FlagConfig, defaultFlagConfig } from './flags.js';
import { BUNDLED_PROFILES } from './profiles/index.js';

/** One accepted (or recorded-rejected) tuning step. */
export interface TuningRecord {
  at: string;
  changes: FlagChange[];
  /** Composite quality measured for the resulting config. */
  quality: number;
  /** Quality delta vs the config it was compared against. */
  delta: number;
  accepted: boolean;
  provenance: string;
}

export interface TuningProfile {
  /** Normalized model family (see normalizeModel). */
  model: string;
  /** Best-known flag configuration for this model. */
  config: FlagConfig;
  /** Composite quality (0-100) of `config` when it was accepted. */
  quality: number;
  updatedAt: string;
  provenance: string;
  /** Append-only accepted/rejected step history. */
  history: TuningRecord[];
  /** Monotonic version (bumped each accepted step). */
  version: number;
}

/** A fresh profile seeded from the bundled starter (or all-defaults). */
export function seedProfile(model: string, now: string): TuningProfile {
  const norm = normalizeModel(model);
  const bundled = getBundledProfile(model);
  return {
    model: norm,
    config: bundled ? { ...bundled } : defaultFlagConfig(),
    quality: 0,
    updatedAt: now,
    provenance: bundled ? 'bundled-starter' : 'defaults',
    history: [],
    version: 0,
  };
}

/**
 * Look up a bundled starter config by (normalized) model family. Matches the
 * bundled key against the normalized model so `qwen3.6-a3b-q4` → `qwen36` etc.
 */
export function getBundledProfile(model: string): FlagConfig | null {
  const norm = normalizeModel(model);
  for (const [key, cfg] of Object.entries(BUNDLED_PROFILES)) {
    if (normalizeModel(key) === norm || norm.includes(normalizeModel(key))) {
      return { ...cfg };
    }
  }
  return null;
}

/**
 * Cross-model transfer priors: the best-known configs from OTHER model families
 * — bundled starters plus any stored profiles — used to seed the optimizer for
 * `model` (design §3.3.3 transfer learning). A config that worked elsewhere is a
 * high-value candidate, not a shortcut: it still goes through full validation.
 */
export function crossModelPriors(model: string, store?: TuningProfileStore): FlagConfig[] {
  const norm = normalizeModel(model);
  const priors: FlagConfig[] = [];
  const seen = new Set<string>();
  const add = (key: string, cfg: FlagConfig): void => {
    if (normalizeModel(key) === norm) return; // exclude the target model itself
    const k = normalizeModel(key);
    if (seen.has(k)) return;
    seen.add(k);
    priors.push({ ...cfg });
  };
  for (const [key, cfg] of Object.entries(BUNDLED_PROFILES)) add(key, cfg);
  for (const key of store?.knownModels() ?? []) {
    const p = store!.load(key);
    if (p && p.quality > 0) add(p.model, p.config);
  }
  return priors;
}

/** JSON-file-backed profile store, one file per model under a base dir. */
export class TuningProfileStore {
  constructor(private readonly baseDir: string) {}

  /** The model families with a stored profile (basenames under the base dir). */
  knownModels(): string[] {
    try {
      return readdirSync(this.baseDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  private pathFor(model: string): string {
    return join(this.baseDir, `${normalizeModel(model)}.json`);
  }

  load(model: string): TuningProfile | null {
    const p = this.pathFor(model);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as TuningProfile;
    } catch {
      return null;
    }
  }

  /** Load the stored profile, or a fresh seeded one when none exists yet. */
  loadOrSeed(model: string, now: string): TuningProfile {
    return this.load(model) ?? seedProfile(model, now);
  }

  save(profile: TuningProfile): void {
    const p = this.pathFor(profile.model);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Fold an accepted step into a profile: adopt the new config, bump the version,
 * update quality, and append the record. Rejected steps are appended to history
 * (for learning) without changing the adopted config.
 */
export function recordStep(profile: TuningProfile, record: TuningRecord, newConfig: FlagConfig): TuningProfile {
  if (record.accepted) {
    return {
      ...profile,
      config: { ...newConfig },
      quality: record.quality,
      updatedAt: record.at,
      provenance: record.provenance,
      version: profile.version + 1,
      history: [...profile.history, record],
    };
  }
  return { ...profile, updatedAt: record.at, history: [...profile.history, record] };
}
