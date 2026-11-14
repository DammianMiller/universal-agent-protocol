import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Model-knowledge chain for the qwen38 local stack, 2026-11-12:
 *
 *   live backend (/props on :8080)
 *     -> profile.model          (rails suite drift-checks this link)
 *     -> registry advertises    (placement can match the served id)
 *     -> sync-local-agent-configs.sh (converges every harness)
 *     -> droid customModels     (user + project .factory settings)
 *
 * This file guards the links the rails suite does not: the registry must
 * know the alias the profile pins, and the Droid settings (machine-local,
 * skipIf absent — CI has no .factory) must call it. The sync-tooling
 * assertions are textual contracts, same doctrine as the rails 'client sync
 * tooling' block: the script must derive ids from the profile and migrate
 * every retired arm alias, never transcribe them. Since 2026-11-14 the
 * chain also carries the baseModelId link: every local route must name a
 * Factory BUILT-IN (qwen3.8-max for the OpenAI shapes) so Droid inherits
 * the model's prompts/tools/reasoning instead of warning the entry "does
 * not map to a built-in model".
 */

const ROOT = resolve(__dirname, '..');

interface Profile {
  model: string;
  context_window: number;
  _engine: string;
  server_optimization: { kv_capacity: number };
}
interface RegistryConfig {
  files?: Array<{ bytes: number; sha256: string }>;
}
interface RegistryModel {
  advertises?: string[];
  configs: Record<string, RegistryConfig>;
}
interface Registry {
  models: Record<string, RegistryModel>;
  retired_local_aliases?: string[];
}
interface DroidModel {
  model?: string;
  id?: string;
  baseUrl?: string;
  provider?: string;
  baseModelId?: string;
  maxContextLimit?: number;
}
interface DroidSettings {
  customModels?: DroidModel[];
  sessionDefaultSettings?: { model?: string };
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

const profile = readJson<Profile>(resolve(ROOT, 'config/model-profiles/qwen38.json'));
const registry = readJson<Registry>(resolve(ROOT, 'config/model-registry.json'));
const arm = registry.models['qwen3.8-flash-next'];

// Retired ids are single-sourced in the registry (retired_local_aliases) —
// the same list the installer migrates from — so this suite never
// transcribes them either.
const RETIRED = registry.retired_local_aliases ?? [];

// Fleet wire ids: every id any family advertises — the set the installer's
// ours-rule matches (at local ports), derived here the same way the script
// derives it, never transcribed.
const FLEET = new Set(
  Object.values(registry.models).flatMap((m) => m.advertises ?? []),
);

// The Factory BUILT-IN written into baseModelId of the OpenAI-shaped local
// routes. Parsed out of the shared contract (the one source of the default),
// then guarded below: a built-in id can never be the served alias, a
// retired arm, or a fleet wire id — those are the LOCAL ids that reproduce
// the "does not map to a built-in model" warning this link exists to close.
const CONTRACTS = readFileSync(resolve(ROOT, 'scripts/lib/droid-sync-contracts.sh'), 'utf8');
const CHAT_BASE_MATCH = /DROID_CHAT_BASE_MODEL:=([^}"\s]+)/.exec(CONTRACTS);
const CHAT_BASE = CHAT_BASE_MATCH?.[1] ?? '';

describe('qwen38 model knowledge — registry follows the profile', () => {
  it('advertises the alias the profile pins, so placement can match the served id', () => {
    expect(arm.advertises).toContain(profile.model);
  });

  it('carries a config entry for the arm the profile describes', () => {
    const m = /strata-[a-z0-9._-]+\.json/.exec(profile._engine);
    expect(m, 'profile._engine names the unit config file').not.toBeNull();
    expect(arm.configs).toHaveProperty(m![0].replace(/\.json$/, ''));
  });

  it('declares the arm the profile names with a verified shard manifest', () => {
    // derived, not hardcoded: after the next arm swap this keeps testing the
    // LIVE arm, not yesterday's
    const key = /strata-[a-z0-9._-]+\.json/.exec(profile._engine)![0].replace(/\.json$/, '');
    const cfg = arm.configs[key];
    if (!cfg) throw new Error(`arm config ${key} missing from the registry`);
    const files = cfg.files ?? [];
    expect(files.length, `${key} carries no shard manifest`).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('qwen38 client sync tooling — droid list follows the profile', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/sync-local-agent-configs.sh'), 'utf8');
  const sandbox = readFileSync(resolve(ROOT, 'scripts/test-sync-sandbox.sh'), 'utf8');

  it('migrates every retired arm alias FROM THE REGISTRY, never transcribed', () => {
    expect(RETIRED.length, 'registry.retired_local_aliases is missing').toBeGreaterThan(0);
    expect(script).toContain('retired_local_aliases');
    // the Droid migration tuple must be DERIVED, not spelled out (the
    // opencode section's legacy is_local_ref matcher may still name an old
    // id as a pattern — different semantic, kept).
    expect(script).not.toMatch(/RETIRED\s*=\s*\(/);
    expect(RETIRED).not.toContain(profile.model);
  });

  it('has a models-only mode that reads the LIVE alias and can target the project settings', () => {
    expect(script).toContain('MODELS_ONLY');
    expect(script).toContain('PROJECT_FACTORY_SET');
    expect(script).toMatch(/\/props/);
  });

  it('derives the fleet wire ids from the registry advertises, never transcribed', () => {
    // The ours-rule must match LIVE arm pins (edge0_145b, the abliterated
    // tiers) that left retired_local_aliases when they went live again —
    // the drift that left the sandbox suite red on master — while the
    // compat ids (gpt-5.1-codex) stay gated on a local base.
    expect(script).toContain('advertises');
    expect(script).toContain('FLEET');
    // the ours rule gates fleet pins on this box's ports (compat ids are
    // ambiguous by name: they collide with real cloud model ids)
    expect(script).toMatch(/if not ours and model in FLEET:/);
  });

  it('names a Factory built-in in baseModelId for every local route shape', () => {
    expect(script).toContain('DROID_CHAT_BASE_MODEL');
    expect(script).toContain('DROID_ANTHROPIC_BASE_MODEL');
    // both shapes set-if-absent (a user's explicit baseModelId choice wins)
    expect(script).toMatch(/if camel and not m\.get\("baseModelId"\)/);
  });

  it('exercises add-if-missing and the models-only isolation in the sandbox test', () => {
    expect(sandbox).toContain('PROJECT_FACTORY_SET');
    expect(sandbox).toContain('MODELS_ONLY=1');
  });
});

describe('chat baseModelId names a Factory built-in, never a local id', () => {
  it('is defined in the shared contract', () => {
    expect(CHAT_BASE, 'DROID_CHAT_BASE_MODEL default is unparsable or absent').not.toBe('');
  });

  it('is not the served alias, a retired arm, or a fleet wire id', () => {
    expect(CHAT_BASE).not.toBe(profile.model);
    expect(RETIRED, 'chat base is a retired local id').not.toContain(CHAT_BASE);
    expect(FLEET, 'chat base is a fleet-advertised local wire id').not.toContain(CHAT_BASE);
  });
});

const PROJECT_SET = resolve(ROOT, '.factory/settings.json');
const USER_SET = resolve(homedir(), '.factory/settings.json');

/**
 * Route invariants for any entry pinned to the live alias: the direct route
 * is pool-sized, both proxy routes are session-sized, and every route names
 * a Factory built-in in baseModelId (or Droid warns it "does not map to a
 * built-in model" and drops prompts/tools/reasoning inheritance).
 */
function expectRoutesConverged(entries: DroidModel[]): void {
  expect(entries.length, 'no entry pinned to the profile alias').toBeGreaterThan(0);
  for (const m of entries) {
    const base = String(m.baseUrl ?? '');
    if (base.includes(':8080')) {
      expect(base, 'direct route').toBe('http://127.0.0.1:8080/v1');
      expect(m.maxContextLimit, 'direct route is pool-sized').toBe(
        profile.server_optimization.kv_capacity,
      );
      expect(
        m.baseModelId,
        'direct entry lacks baseModelId (no prompts/tools inheritance)',
      ).toBeTruthy();
    } else if (base.includes(':4000')) {
      expect(m.maxContextLimit, 'proxy route is session-sized').toBe(profile.context_window);
      if (base.endsWith('/v1')) {
        expect(base, 'chat route').toBe('http://127.0.0.1:4000/v1');
        expect(
          m.baseModelId,
          'chat entry lacks baseModelId (no prompts/tools inheritance)',
        ).toBeTruthy();
      } else {
        expect(base, 'anthropic route is the proxy ROOT (no /v1)').toBe('http://127.0.0.1:4000');
        expect(
          m.baseModelId,
          'anthropic entry lacks baseModelId (no prompts/tools inheritance)',
        ).toBeTruthy();
      }
    } else {
      throw new Error(`entry on unexpected route: ${base}`);
    }
  }
}

/**
 * Fleet wire ids pinned at THIS box's ports are drift the sync converges
 * onto the ONE alias the backend serves (the engine serves one arm at a
 * time; the pin never routes). The MODELS_ONLY hook converges onto the LIVE
 * alias when the profile is stale (its own contract: live reality over a
 * stale profile), so the machine-local invariant is uniformity — every
 * local fleet pin shares ONE non-retired arm id — not the profile alias
 * specifically. Scattered per-arm pins are the drift class.
 */
function expectFleetPinsConverged(models: DroidModel[]): void {
  const localFleetPins = models.filter((m) => {
    const base = String(m.baseUrl ?? '');
    const localPort = base.includes(':4000') || base.includes(':8080');
    return localPort && !!m.model && FLEET.has(m.model);
  });
  if (localFleetPins.length === 0) return;
  const ids = new Set(localFleetPins.map((m) => m.model));
  expect(
    ids.size,
    `local fleet pins did not converge onto one served alias: ${[...ids].join(', ')}`,
  ).toBe(1);
  const pinned = [...ids][0] as string;
  expect(RETIRED, `local entries pinned to a RETIRED arm: ${pinned}`).not.toContain(pinned);
}

/**
 * The alias the settings actually carry: the profile pin when the profile
 * is fresh, else the non-retired fleet id the MODELS_ONLY hook converged
 * onto (the stale-profile case above). Fleet ids are ambiguous BY NAME
 * (the compat list collides with real cloud ids like gpt-5.1-codex), so
 * the fallback gates on this box's ports exactly like the sync's ours-rule.
 * Route invariants apply to either.
 */
function liveAliasEntries(models: DroidModel[]): DroidModel[] {
  const pinned = models.filter((m) => m.model === profile.model);
  if (pinned.length > 0) return pinned;
  return models.filter((m) => {
    const base = String(m.baseUrl ?? '');
    const localPort = base.includes(':4000') || base.includes(':8080');
    return localPort && !!m.model && FLEET.has(m.model) && !RETIRED.includes(m.model);
  });
}

describe('droid settings call the alias the profile pins', () => {
  it.skipIf(!existsSync(PROJECT_SET))('project customModels carry the live alias on all routes', () => {
    const d = readJson<DroidSettings>(PROJECT_SET);
    const entries = liveAliasEntries(d.customModels ?? []);
    expectRoutesConverged(entries);
    expectFleetPinsConverged(d.customModels ?? []);
    for (const m of d.customModels ?? []) {
      expect(RETIRED, `retired id still pinned: ${String(m.model)}`).not.toContain(m.model);
    }
    // The session default (when set to a custom entry) must not dangle.
    const def = d.sessionDefaultSettings?.model;
    if (typeof def === 'string' && def.startsWith('custom:')) {
      expect(
        (d.customModels ?? []).some((m) => m.id === def),
        `default session model ${def} dangles`,
      ).toBe(true);
    }
  });

  it.skipIf(!existsSync(USER_SET))('user settings carry the live alias too (every Droid instance)', () => {
    const d = readJson<DroidSettings>(USER_SET);
    const entries = liveAliasEntries(d.customModels ?? []);
    expectRoutesConverged(entries);
    expectFleetPinsConverged(d.customModels ?? []);
    for (const m of d.customModels ?? []) {
      expect(RETIRED, `retired id still pinned: ${String(m.model)}`).not.toContain(m.model);
    }
  });
});
