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
  unit?: string;
  measured_at?: string;
  resident_gpu_mib?: number;
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
  apiKeyHelper?: string;
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
// The family whose advertises carries the profile's alias — DERIVED, never
// fixed to one family key: the 2026-11-19 arm swap moved the live alias
// from the flash-next family (strata/speedy arms) to the 27B family
// (hyperqwen), and the next swap can move it again.
const ARM_KEY =
  Object.keys(registry.models).find((k) =>
    (registry.models[k]?.advertises ?? []).includes(profile.model),
  ) ?? '';
const arm = registry.models[ARM_KEY];

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
// The second local family the pickers list alongside the live alias. The
// pin comes from the same shared contract the installer reads; the marker
// id shape is the sync's stake that distinguishes the DELIBERATE 27B
// listing (never converged) from a stale pin (always converged).
const PIN27_MATCH = /DROID_LOCAL_27B_PIN:=([^}"\s]+)/.exec(CONTRACTS);
const PIN27 = PIN27_MATCH?.[1] ?? '';
const MARKER27 = /^custom:Qwen[\d.]+-27B-UAP-local-\d+$/;
const FAM27 = registry.models['qwen3.8-27b'];
// The third local family the pickers list alongside both qwen families:
// the registry's gemma-4-31b arm (llama.cpp QAT+MTP). Same rules as the 27B
// listing — the pin from the same shared contract, the marker id shape is
// the sync's gemma stake (the regex its markerg uses) — plus the arm's OWN
// session cap, parsed from the sync's GEMMA_CTX assignment: the fit-probed
// 49152 llama.cpp window minus output, NOT the qwen per-session window.
const PING_MATCH = /DROID_LOCAL_GEMMA_PIN:=([^}"\s]+)/.exec(CONTRACTS);
const PING = PING_MATCH?.[1] ?? '';
const MARKERG = /^custom:gemma-4[\w.-]*-UAP-local-\d+$/;
const FAMG = registry.models['gemma-4-31b'];
const SYNC_SCRIPT = readFileSync(resolve(ROOT, 'scripts/sync-local-agent-configs.sh'), 'utf8');
const GEMMA_CTX = Number(/GEMMA_CTX=(\d+)/.exec(SYNC_SCRIPT)?.[1] ?? 0);
// The FOURTH local family the pickers list: the registry's inkling2 family
// (basalt on the native NVFP4-MX8 pack, squid5090 on the original HF
// checkpoint — one wire id, the placement gate serves whichever arm is
// resident). Same doctrine as the 27B/gemma listings — pin from the same
// shared contract, marker shape is the sync's markeri stake, geometry from
// the family's OWN profile (the qwen session window does not size it). One
// shape difference: the wire id carries a SPACE, so the capture runs to the
// closing brace of the ${…:=…} expansion instead of stopping at whitespace.
const PINI_MATCH = /DROID_LOCAL_INKLING2_PIN:=([^}"\n]+)/.exec(CONTRACTS);
const PINI = PINI_MATCH?.[1] ?? '';
const MARKERI = /^custom:Inkling-2-Mini-UAP-local-\d+$/;
const FAMI = registry.models['inkling2'];
const INK_PROFILE = readJson<Profile>(resolve(ROOT, 'config/model-profiles/inkling2.json'));
/**
 * apiKeyHelper entries are the operator's self-managed arm-switch machinery
 * (the fleet-arm-ensure helpers with apiKeyHelperTtlMs): the sync's
 * self-managed guard skips them — never converged, never re-capped, never
 * deduped — so this suite's uniformity and alias invariants exempt them
 * with the SAME rule. Without it, adding a registry family (which grows
 * FLEET) would make the operator's deliberate per-arm helper pins read as
 * "drift that did not converge".
 */
const selfManaged = (m: DroidModel): boolean =>
  typeof m.apiKeyHelper === 'string' && m.apiKeyHelper !== '';

describe('qwen38 model knowledge — registry follows the profile', () => {
  it('advertises the alias the profile pins, so placement can match the served id', () => {
    expect(ARM_KEY, `no registry family advertises the profile alias ${profile.model}`).not.toBe(
      '',
    );
    expect(arm?.advertises).toContain(profile.model);
  });

  it('carries a config entry for the arm the profile describes', () => {
    // Derived by UNIT: the profile's _engine names the serving unit and the
    // registry config carries it — swap-proof (the strata era named
    // uap-speedy-base-iq3s-server under the flash-next family's speedy-iq3_s
    // config; the 2026-11-19 hyperqwen arm names uap-hyperqwen-server under
    // the 27B family's hyperqwen config).
    const unit = /uap-[a-z0-9-]+-server/.exec(profile._engine)?.[0] ?? '';
    expect(unit, 'profile._engine names no serving unit').not.toBe('');
    const hits = Object.values(registry.models).flatMap((fam) =>
      Object.entries(fam.configs ?? {}).filter(([, c]) => c.unit === unit),
    );
    expect(hits.length, `no registry config carries unit ${unit}`).toBeGreaterThan(0);
  });

  it('declares the arm the profile names with a verified shard manifest or a measured footprint', () => {
    // derived, not hardcoded: after the next arm swap this keeps testing the
    // LIVE arm, not yesterday's
    const unit = /uap-[a-z0-9-]+-server/.exec(profile._engine)?.[0] ?? '';
    const hit = Object.values(registry.models)
      .flatMap((fam) => Object.entries(fam.configs ?? {}).map(([k, c]) => ({ k, c })))
      .find(({ c }) => c.unit === unit);
    expect(hit, `no registry config carries unit ${unit}`).toBeTruthy();
    const cfg = hit!.c;
    const files = cfg.files ?? [];
    if (files.length > 0) {
      for (const f of files) {
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } else {
      // GGUF-less arms (the hyperqwen W4A16 safetensors dir, the exl3 arms)
      // carry no shard manifest — their placeable footprint is the
      // hand-measured record instead (the exl3 precedent: measured_at +
      // resident_gpu_mib, recorded by hand the day the arm went live).
      expect(cfg.measured_at, 'manifest-less arm is unmeasured').toBeTruthy();
      expect(cfg.resident_gpu_mib ?? 0).toBeGreaterThan(0);
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

  it('reads the LIVE alias from /v1/models when the backend has no /props (vLLM arms)', () => {
    // 2026-11-19: the hyperqwen vLLM arm serves OpenAI-shaped /v1 only —
    // /props 404s — and a /props-only probe read the live swap as "backend
    // probe unreachable", keeping a dead flash-next alias in every client
    // config while direct-route requests 404'd (fleet log 18:39:37). The
    // probe must fall back to the model list; a single served id names the
    // alias unambiguously, a multi-id list is a router and stands down.
    expect(script).toContain('/v1/models');
    expect(script).toMatch(/len\(ids\) == 1/);
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

describe('the 27B family is a first-class picker listing, not drift', () => {
  it('is pinned by a contract id the registry family advertises', () => {
    expect(PIN27, 'DROID_LOCAL_27B_PIN default is unparsable or absent').not.toBe('');
    expect(FAM27, 'registry.models["qwen3.8-27b"] is missing').toBeTruthy();
    expect(
      FAM27?.advertises,
      'the 27B pin is not an id the qwen3.8-27b family advertises',
    ).toContain(PIN27);
    // A listed family id is live, not drift: the FLEET rule (not the
    // retired list) converges any stale plain-id pin.
    expect(RETIRED, 'a listed family id must not sit in retired_local_aliases').not.toContain(
      PIN27,
    );
  });

  it('is carried by the sync tooling (Droid marker listing + opencode menu)', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/sync-local-agent-configs.sh'), 'utf8');
    const sandbox = readFileSync(resolve(ROOT, 'scripts/test-sync-sandbox.sh'), 'utf8');
    expect(script).toContain('DROID_LOCAL_27B_PIN');
    // the marker exemption + the add-if-missing listing
    expect(script).toMatch(/marker27/);
    expect(script).toContain('27B family entry added');
    // the sandbox exercises BOTH halves: protection and addition
    expect(sandbox).toContain('DROID_LOCAL_27B_PIN');
    expect(sandbox).toMatch(/27B-UAP-local/);
    // opencode lists both families, keyed apart from the legacy default
    expect(script).toContain('"Qwen3.8-Flash-Next"');
    expect(script).toContain('"qwen3.8-27b"');
  });
});

describe('the gemma-4-31b family is a third picker listing, not drift', () => {
  it('is pinned by a contract id the registry family advertises', () => {
    expect(PING, 'DROID_LOCAL_GEMMA_PIN default is unparsable or absent').not.toBe('');
    expect(FAMG, 'registry.models["gemma-4-31b"] is missing').toBeTruthy();
    expect(
      FAMG?.advertises,
      'the gemma pin is not an id the gemma-4-31b family advertises',
    ).toContain(PING);
    // A listed family id is live, not drift: the FLEET rule (not the
    // retired list) converges any stale plain-id pin.
    expect(RETIRED, 'a listed family id must not sit in retired_local_aliases').not.toContain(
      PING,
    );
  });
});

describe('the inkling2 family is a fourth picker listing, not drift', () => {
  it('is pinned by a contract id the registry family advertises', () => {
    expect(PINI, 'DROID_LOCAL_INKLING2_PIN default is unparsable or absent').not.toBe('');
    expect(FAMI, 'registry.models["inkling2"] is missing').toBeTruthy();
    expect(
      FAMI?.advertises,
      'the inkling2 pin is not an id the inkling2 family advertises',
    ).toContain(PINI);
    // One wire id across both engine arms: the placement gate resolves
    // either arm from this pin and parks image traffic off the text-only
    // squid arm, so the pin never names a config.
    expect(
      INK_PROFILE.model,
      'the inkling2 profile and the contract pin disagree — one place owns the wire id',
    ).toBe(PINI);
    expect(RETIRED, 'a listed family id must not sit in retired_local_aliases').not.toContain(
      PINI,
    );
  });

  it('is carried by the sync tooling with the self-managed guard (Droid marker + opencode provider)', () => {
    expect(SYNC_SCRIPT).toContain('DROID_LOCAL_INKLING2_PIN');
    // the marker exemption (hyphenated id — the wire id carries a space)
    expect(SYNC_SCRIPT).toMatch(/markeri/);
    expect(SYNC_SCRIPT).toContain('inkling2 family entry added');
    // the self-managed guard: helper entries are never converged or re-capped
    expect(SYNC_SCRIPT).toMatch(/if m\.get\("apiKeyHelper"\):\s*continue/);
    // opencode gains its own inkling2-proxy provider (profile.model rewrites
    // the wire model — a shared provider would reroute inkling2 to qwen)
    expect(SYNC_SCRIPT).toContain('inkling2-proxy');
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
    // The deliberate 27B, gemma, and inkling2 family listings are PICKER
    // LINES, not drift: their marker ids are the sync's stakes. Everything
    // else the fleet advertises, pinned at this box's ports, must share the
    // one served id.
    if (typeof m.id === 'string' && (MARKER27.test(m.id) || MARKERG.test(m.id) || MARKERI.test(m.id)))
      return false;
    // Self-managed helper entries are the operator's own per-arm pins —
    // exempt by the same rule the sync's guard uses.
    if (selfManaged(m)) return false;
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
 * Deliberate picker listings (the 27B and gemma marker stakes) are NOT
 * alias pins — the hook never converges them — so they never enter the
 * fallback: a gemma listing sized to its own arm geometry is a picker
 * line, not an alias entry that forgot the qwen session window. Route
 * invariants apply to either.
 */
function liveAliasEntries(models: DroidModel[]): DroidModel[] {
  const pinned = models.filter((m) => m.model === profile.model);
  if (pinned.length > 0) return pinned;
  return models.filter((m) => {
    if (typeof m.id === 'string' && (MARKER27.test(m.id) || MARKERG.test(m.id) || MARKERI.test(m.id)))
      return false;
    if (selfManaged(m)) return false;
    const base = String(m.baseUrl ?? '');
    const localPort = base.includes(':4000') || base.includes(':8080');
    return localPort && !!m.model && FLEET.has(m.model) && !RETIRED.includes(m.model);
  });
}

/**
 * The 27B family listing rides in every settings file the sync touches:
 * exactly one marker entry, on the proxy chat route, session-sized, with
 * the Qwen3.8-family built-in in baseModelId (same inheritance as the
 * alias entries).
 */
function expect27BListed(models: DroidModel[]): void {
  const listed = models.filter(
    (m) => typeof m.id === 'string' && MARKER27.test(m.id) && m.model === PIN27,
  );
  expect(listed, 'the 27B family listing is missing from the picker').toHaveLength(1);
  const m = listed[0] as DroidModel;
  expect(m.baseUrl, '27B listing is not on the proxy chat route').toBe(
    'http://127.0.0.1:4000/v1',
  );
  expect(m.maxContextLimit, '27B listing is not session-sized').toBe(profile.context_window);
  expect(m.baseModelId, '27B listing lacks baseModelId (no prompts/tools inheritance)')
    .toBeTruthy();
}

/**
 * The gemma-4-31b family listing rides in every settings file the sync
 * touches: exactly one marker entry, on the proxy chat route, capped at the
 * arm's OWN geometry — GEMMA_CTX from the sync contract (the fit-probed
 * 49152 llama.cpp window minus output; llama.cpp counts prompt AND output
 * inside the window), NOT the qwen session window the alias and 27B
 * listings carry. baseModelId carries no assertion: the sync stamps one
 * only when the Factory catalog has a Gemma built-in (DROID_GEMMA_BASE_MODEL
 * defaults empty — an honest omission beats a wrong-family mapping).
 */
function expectGemmaListed(models: DroidModel[]): void {
  const listed = models.filter(
    (m) => typeof m.id === 'string' && MARKERG.test(m.id) && m.model === PING,
  );
  expect(listed, 'the gemma family listing is missing from the picker').toHaveLength(1);
  const m = listed[0] as DroidModel;
  expect(m.baseUrl, 'gemma listing is not on the proxy chat route').toBe(
    'http://127.0.0.1:4000/v1',
  );
  expect(m.maxContextLimit, 'gemma listing is not sized to the arm geometry').toBe(GEMMA_CTX);
}

/**
 * The inkling2 family must be listed, but by EITHER of the two shapes the
 * sync's add-if-missing rule produces: its own marker listing (fresh boxes:
 * exactly one, on the proxy chat route, capped at the inkling2 PROFILE
 * geometry — the qwen session window does not size it), or the operator's
 * self-managed helper entries (this box: the arm-switch machinery already
 * pins the family, and the sync's guard refuses to add a marker line on
 * top of it). baseModelId carries no assertion: the sync stamps one only
 * when a Factory Inkling built-in exists (it does not — an honest omission
 * beats a wrong-family mapping).
 */
function expectInkling2Listed(models: DroidModel[]): void {
  const atLocalPort = (m: DroidModel) => {
    const base = String(m.baseUrl ?? '');
    return (base.includes(':4000') || base.includes(':8080')) && m.model === PINI;
  };
  const marked = models.filter(
    (m) => typeof m.id === 'string' && MARKERI.test(m.id) && m.model === PINI,
  );
  const helpers = models.filter((m) => atLocalPort(m) && selfManaged(m));
  if (marked.length > 0) {
    expect(marked, 'more than one inkling2 marker listing').toHaveLength(1);
    const m = marked[0] as DroidModel;
    expect(m.baseUrl, 'inkling2 listing is not on the proxy chat route').toBe(
      'http://127.0.0.1:4000/v1',
    );
    expect(m.maxContextLimit, 'inkling2 listing is not sized to the profile geometry').toBe(
      INK_PROFILE.context_window,
    );
  } else {
    expect(
      helpers.length,
      'the inkling2 family is not listed (neither the sync marker nor a self-managed helper entry)',
    ).toBeGreaterThan(0);
  }
}

describe('droid settings call the alias the profile pins', () => {
  it.skipIf(!existsSync(PROJECT_SET))('project customModels carry the live alias on all routes', () => {
    const d = readJson<DroidSettings>(PROJECT_SET);
    const entries = liveAliasEntries(d.customModels ?? []);
    expectRoutesConverged(entries);
    expectFleetPinsConverged(d.customModels ?? []);
    expect27BListed(d.customModels ?? []);
    expectGemmaListed(d.customModels ?? []);
    expectInkling2Listed(d.customModels ?? []);
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
    expect27BListed(d.customModels ?? []);
    expectGemmaListed(d.customModels ?? []);
    expectInkling2Listed(d.customModels ?? []);
    for (const m of d.customModels ?? []) {
      expect(RETIRED, `retired id still pinned: ${String(m.model)}`).not.toContain(m.model);
    }
  });
});

const OC_GLOBAL = resolve(homedir(), '.config/opencode/opencode.json');

describe('opencode lists both local families', () => {
  it.skipIf(!existsSync(OC_GLOBAL))('the qwen-proxy menu carries Flash-Next (default) + the 27B family', () => {
    const d = readJson<{
      model?: string;
      provider?: Record<string, { models?: Record<string, { name?: string }> }>;
    }>(OC_GLOBAL);
    const qp = d.provider?.['qwen-proxy'];
    expect(qp, 'the qwen-proxy provider is missing').toBeTruthy();
    const keys = new Set(Object.keys(qp?.models ?? {}));
    expect(keys, `expected both local families, got ${[...keys].join(', ')}`).toEqual(
      new Set(['Qwen3.8-Flash-Next', 'qwen3.8-27b']),
    );
    expect(d.model, 'the opencode default is not the Flash-Next listing').toBe(
      'qwen-proxy/Qwen3.8-Flash-Next',
    );
  });
});
