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
 * every retired arm alias, never transcribe them.
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

const RETIRED = [
  'qwen35-a3b-iq4xs',
  'qwen38-gsq-rco-27b',
  'abliterated-iq2_xs',
  'qwen3.8-flash-next-iq3_s',
  'swift-1.5-iq3_s',
];

describe('qwen38 model knowledge — registry follows the profile', () => {
  it('advertises the alias the profile pins, so placement can match the served id', () => {
    expect(arm.advertises).toContain(profile.model);
  });

  it('carries a config entry for the arm the profile describes', () => {
    const m = /strata-[a-z0-9._-]+\.json/.exec(profile._engine);
    expect(m, 'profile._engine names the unit config file').not.toBeNull();
    expect(arm.configs).toHaveProperty(m![0].replace(/\.json$/, ''));
  });

  it('declares the unsloth arm with a verified 4-shard manifest', () => {
    const cfg = arm.configs['strata-unsloth-ud-iq4_xs-v31'];
    expect(cfg.files).toHaveLength(4);
    for (const f of cfg.files ?? []) {
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('qwen38 client sync tooling — droid list follows the profile', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/sync-local-agent-configs.sh'), 'utf8');
  const sandbox = readFileSync(resolve(ROOT, 'scripts/test-sync-sandbox.sh'), 'utf8');

  it('migrates every retired arm alias, not just the qwen35-era ones', () => {
    for (const retired of RETIRED) {
      expect(script).toContain(`"${retired}"`);
    }
  });

  it('has a models-only mode that reads the LIVE alias and can target the project settings', () => {
    expect(script).toContain('MODELS_ONLY');
    expect(script).toContain('PROJECT_FACTORY_SET');
    expect(script).toMatch(/\/props/);
  });

  it('exercises add-if-missing and the models-only isolation in the sandbox test', () => {
    expect(sandbox).toContain('PROJECT_FACTORY_SET');
    expect(sandbox).toContain('MODELS_ONLY=1');
  });
});

const PROJECT_SET = resolve(ROOT, '.factory/settings.json');
const USER_SET = resolve(homedir(), '.factory/settings.json');

/**
 * Route invariants for any entry pinned to the live alias: the direct route
 * is pool-sized, both proxy routes are session-sized, and the anthropic
 * Messages entry must name a Factory built-in in baseModelId (or Droid warns
 * it "does not map to a built-in model" and drops tool-call inheritance).
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
    } else if (base.includes(':4000')) {
      expect(m.maxContextLimit, 'proxy route is session-sized').toBe(profile.context_window);
      if (base.endsWith('/v1')) {
        expect(base, 'chat route').toBe('http://127.0.0.1:4000/v1');
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

describe('droid settings call the alias the profile pins', () => {
  it.skipIf(!existsSync(PROJECT_SET))('project customModels carry the live alias on all routes', () => {
    const d = readJson<DroidSettings>(PROJECT_SET);
    const entries = (d.customModels ?? []).filter((m) => m.model === profile.model);
    expectRoutesConverged(entries);
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
    const entries = (d.customModels ?? []).filter((m) => m.model === profile.model);
    expectRoutesConverged(entries);
    for (const m of d.customModels ?? []) {
      expect(RETIRED, `retired id still pinned: ${String(m.model)}`).not.toContain(m.model);
    }
  });
});
