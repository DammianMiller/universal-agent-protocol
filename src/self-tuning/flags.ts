/**
 * LLM Self-Tuning — the tunable-flag domain model (P1).
 *
 * This is the SEARCH SPACE. It selects the subset of the UAP settings registry
 * that is safe + impactful to tune toward quality, and enriches each flag with
 * what the optimizer needs: a search domain (bool / enum values / numeric range)
 * and a DEPENDENCY (a flag only "matters" when its parent is in a given state,
 * e.g. `recipes.fusionN` only when `recipes.recipe='fusion'`). The dependency
 * map is the design's §11 flag-dependency graph, and it is what lets the
 * Bayesian optimizer and the LLM tuner prune the 3^42 blow-up to a tractable
 * space (design §3.3.3).
 *
 * Flag values are drawn straight from `settings-registry.ts` where it declares
 * them (type, enumValues, min/max) so the catalog can never drift from the
 * canonical settings; search bounds absent from the registry (e.g. a good range
 * for `memory.shortTerm.maxEntries`) are supplied here.
 */

import { getSetting, SettingCategoryId } from '../config/settings-registry.js';

export type FlagValue = string | number | boolean;

/** A flat tuning configuration: settings-registry key → value. */
export type FlagConfig = Record<string, FlagValue>;

/** A change to one flag (the atom the LLM tuner and flag-writer operate on). */
export interface FlagChange {
  /** settings-registry key, e.g. `recipes.confidenceThreshold` or `PROXY_LOOP_BREAKER`. */
  key: string;
  from: FlagValue | null;
  to: FlagValue;
  category: SettingCategoryId;
}

export type FlagDomain =
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'number'; min: number; max: number; int: boolean; step: number };

/** A dependency: this flag only affects behavior when `key` holds one of `values`. */
export interface FlagDependency {
  key: string;
  values: readonly FlagValue[];
}

export interface TunableFlag {
  key: string;
  category: SettingCategoryId;
  domain: FlagDomain;
  /** Default value when unset in a config. */
  default: FlagValue;
  /** All dependencies must be satisfied for this flag to be "active". */
  dependsOn: FlagDependency[];
}

/**
 * Curated catalog of tunable flags. `range`/`enum` come from the registry when
 * present; `search` overrides the numeric search bounds for flags the registry
 * leaves open. Kept small and high-signal on purpose — every added dim widens
 * the search.
 */
interface CatalogSpec {
  key: string;
  /** Numeric search bounds when the registry declares none (or to tighten them). */
  search?: { min: number; max: number; int?: boolean; step?: number };
  dependsOn?: FlagDependency[];
  /** Default override when the registry default is null/unhelpful for search. */
  defaultOverride?: FlagValue;
}

const CATALOG: CatalogSpec[] = [
  // ── Recipes / escalation ──────────────────────────────────────────────────
  { key: 'recipes.enabled' },
  { key: 'recipes.recipe', dependsOn: [{ key: 'recipes.enabled', values: [true] }] },
  {
    key: 'recipes.confidenceThreshold',
    search: { min: 0.3, max: 0.8, step: 0.05 },
    dependsOn: [{ key: 'recipes.recipe', values: ['confidence', 'auto'] }],
  },
  {
    key: 'recipes.fusionN',
    dependsOn: [{ key: 'recipes.recipe', values: ['fusion', 'auto'] }],
  },
  { key: 'recipes.allowSelfJudge', dependsOn: [{ key: 'recipes.enabled', values: [true] }] },

  // ── Hands-free ────────────────────────────────────────────────────────────
  { key: 'handsfree.enabled' },
  { key: 'handsfree.intensity', dependsOn: [{ key: 'handsfree.enabled', values: [true] }] },
  {
    key: 'UAP_HANDSFREE_STAGNATION_LIMIT',
    search: { min: 3, max: 12, int: true, step: 1 },
    dependsOn: [{ key: 'handsfree.enabled', values: [true] }],
    defaultOverride: 8,
  },

  // ── Concurrency ───────────────────────────────────────────────────────────
  { key: 'modelConcurrency.slots', search: { min: 1, max: 8, int: true, step: 1 }, defaultOverride: 4 },
  { key: 'modelConcurrency.adaptive' },

  // ── Memory ────────────────────────────────────────────────────────────────
  { key: 'memory.shortTerm.maxEntries', search: { min: 20, max: 120, int: true, step: 10 }, defaultOverride: 50 },
  { key: 'memory.patternRag.enabled' },

  // ── Verification / delivery ───────────────────────────────────────────────
  { key: 'delivery.runtimeVerify' },

  // ── Proxy guardrails (hot-reloadable-ish; applied via proxy.env) ──────────
  { key: 'PROXY_RECON_CONVERGENCE_THRESHOLD', search: { min: 20, max: 120, int: true, step: 10 }, defaultOverride: 40 },
  { key: 'PROXY_LOOP_BREAKER' },
  { key: 'PROXY_STUCK_BREAK' },
];

function domainFor(spec: CatalogSpec): { domain: FlagDomain; category: SettingCategoryId; def: FlagValue } {
  const s = getSetting(spec.key);
  if (!s) {
    throw new Error(`self-tuning flags: '${spec.key}' is not in the settings registry`);
  }
  const category = s.category;
  if (s.type === 'boolean') {
    return { domain: { kind: 'bool' }, category, def: spec.defaultOverride ?? (s.default as boolean ?? false) };
  }
  if (s.type === 'enum') {
    const values = s.enumValues ?? [];
    return {
      domain: { kind: 'enum', values },
      category,
      def: spec.defaultOverride ?? (s.default as string) ?? values[0],
    };
  }
  // number
  const min = spec.search?.min ?? s.min ?? 0;
  const max = spec.search?.max ?? s.max ?? Math.max(1, (Number(s.default) || 1) * 4);
  const int = spec.search?.int ?? s.int ?? false;
  const step = spec.search?.step ?? (int ? 1 : (max - min) / 10);
  const def = spec.defaultOverride ?? (typeof s.default === 'number' ? s.default : (min + max) / 2);
  return { domain: { kind: 'number', min, max, int, step }, category, def };
}

/** The resolved tunable-flag catalog. */
export const TUNABLE_FLAGS: readonly TunableFlag[] = CATALOG.map((spec) => {
  const { domain, category, def } = domainFor(spec);
  return { key: spec.key, category, domain, default: def, dependsOn: spec.dependsOn ?? [] };
});

const FLAG_BY_KEY = new Map(TUNABLE_FLAGS.map((f) => [f.key, f]));

export function getTunableFlag(key: string): TunableFlag | undefined {
  return FLAG_BY_KEY.get(key);
}

/** The all-defaults configuration over every tunable flag. */
export function defaultFlagConfig(): FlagConfig {
  const cfg: FlagConfig = {};
  for (const f of TUNABLE_FLAGS) cfg[f.key] = f.default;
  return cfg;
}

/** Resolve a flag's effective value in a config (its value, or its default). */
export function flagValue(cfg: FlagConfig, key: string): FlagValue | undefined {
  if (key in cfg) return cfg[key];
  return FLAG_BY_KEY.get(key)?.default;
}

/**
 * Is `flag` ACTIVE in `cfg` — i.e. do all its dependencies hold, TRANSITIVELY?
 * A flag is inactive if any dependency value is unsatisfied OR the dependency
 * flag is itself inactive (e.g. `recipes.fusionN` needs `recipes.recipe` to be
 * `fusion`/`auto` AND `recipes.recipe` needs `recipes.enabled`). An inactive
 * flag's value is irrelevant, so the optimizer never spends search on it and the
 * tuner never proposes changing it. The dependency graph is acyclic.
 */
export function isFlagActive(flag: TunableFlag, cfg: FlagConfig): boolean {
  for (const dep of flag.dependsOn) {
    const v = flagValue(cfg, dep.key);
    if (v === undefined || !dep.values.includes(v)) return false;
    const depFlag = FLAG_BY_KEY.get(dep.key);
    if (depFlag && !isFlagActive(depFlag, cfg)) return false; // transitive gate
  }
  return true;
}

/** The keys of every flag active in `cfg`. */
export function activeFlags(cfg: FlagConfig): string[] {
  return TUNABLE_FLAGS.filter((f) => isFlagActive(f, cfg)).map((f) => f.key);
}

/** Human-readable `key = value` lines for the flags active in `cfg`. */
export function describeActiveFlagsList(cfg: FlagConfig): string[] {
  return TUNABLE_FLAGS.filter((f) => isFlagActive(f, cfg)).map(
    (f) => `${f.key} = ${JSON.stringify(flagValue(cfg, f.key))}`,
  );
}

/**
 * Coerce/clamp a value into a flag's domain. Numbers are clamped + optionally
 * snapped to int; enums fall back to the default on an unknown value; bools are
 * truth-tested. Returns null when `key` is not a tunable flag.
 */
export function coerceToDomain(key: string, value: FlagValue): FlagValue | null {
  const flag = FLAG_BY_KEY.get(key);
  if (!flag) return null;
  const d = flag.domain;
  if (d.kind === 'bool') {
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  if (d.kind === 'enum') {
    return d.values.includes(String(value)) ? String(value) : flag.default;
  }
  // number
  let n = Number(value);
  if (!Number.isFinite(n)) n = Number(flag.default);
  n = Math.max(d.min, Math.min(d.max, n));
  if (d.int) n = Math.round(n);
  return n;
}

/** Diff two configs into the minimal FlagChange[] (only keys that differ). */
export function diffConfigs(from: FlagConfig, to: FlagConfig): FlagChange[] {
  const changes: FlagChange[] = [];
  for (const flag of TUNABLE_FLAGS) {
    const a = flagValue(from, flag.key);
    const b = flagValue(to, flag.key);
    if (b !== undefined && a !== b) {
      changes.push({ key: flag.key, from: a ?? null, to: b, category: flag.category });
    }
  }
  return changes;
}

/** Every flag of a config expressed as a FlagChange (from unknown), for a full apply. */
export function configToChanges(cfg: FlagConfig): FlagChange[] {
  const changes: FlagChange[] = [];
  for (const flag of TUNABLE_FLAGS) {
    const v = flagValue(cfg, flag.key);
    if (v !== undefined) changes.push({ key: flag.key, from: null, to: v, category: flag.category });
  }
  return changes;
}

/** Apply FlagChange[] onto a config, returning a new config (coerced to domain). */
export function applyChanges(cfg: FlagConfig, changes: FlagChange[]): FlagConfig {
  const next = { ...cfg };
  for (const c of changes) {
    const coerced = coerceToDomain(c.key, c.to);
    if (coerced !== null) next[c.key] = coerced;
  }
  return next;
}
