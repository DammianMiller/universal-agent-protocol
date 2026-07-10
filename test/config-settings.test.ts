/**
 * Tests for the settings registry + `uap config` engine + policy recommendations.
 * The registry is the single source of truth for the CLI, the wizard, and the
 * generated docs, so these guard its integrity and the read/write round-trips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATEGORIES,
  SETTINGS,
  getSetting,
  settingsByCategory,
} from '../src/config/settings-registry.js';
import { applySetting, currentValue, listSettingsJson, renderReferenceMarkdown } from '../src/cli/config-command.js';
import { CORE, SCENARIOS, getScenario, recommendedFor } from '../src/config/policy-recommendations.js';
import { loadUapConfig } from '../src/utils/config-loader.js';

const dirs: string[] = [];
function scratch(initial?: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'uapcfg-'));
  dirs.push(d);
  if (initial) writeFileSync(join(d, '.uap.json'), JSON.stringify(initial, null, 2));
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('settings registry integrity', () => {
  const catIds = new Set(CATEGORIES.map((c) => c.id));

  it('has unique keys', () => {
    const keys = SETTINGS.map((s) => s.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every setting is well-formed', () => {
    for (const s of SETTINGS) {
      expect(s.description.length, s.key).toBeGreaterThan(0);
      expect(s.recommendation.length, s.key).toBeGreaterThan(0);
      expect(catIds.has(s.category), `${s.key} → ${s.category}`).toBe(true);
      if (s.type === 'enum') expect(s.enumValues?.length, s.key).toBeGreaterThan(0);
      if (s.kind === 'env') expect(s.target, `${s.key} needs a target`).toBeDefined();
      if (s.secret) expect(s.kind, `${s.key} secret must not be json`).toBe('env');
    }
  });

  it('every category with a title has at least one lookup path', () => {
    for (const c of CATEGORIES) {
      // settingsByCategory must not throw and must be a subset of SETTINGS
      const items = settingsByCategory(c.id);
      for (const s of items) expect(s.category).toBe(c.id);
    }
  });
});

describe('uap config set/get round-trips', () => {
  it('writes a json enum setting to .uap.json and reads it back', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const s = getSetting('delivery.enforcement')!;
    const res = applySetting(cwd, s, 'advisory');
    expect(res.ok).toBe(true);
    const written = JSON.parse(readFileSync(join(cwd, '.uap.json'), 'utf-8'));
    expect(written.delivery.enforcement).toBe('advisory');
    expect(currentValue(cwd, s)).toEqual({ value: 'advisory', source: '.uap.json' });
  });

  it('coerces a boolean and rejects an invalid enum', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const bool = applySetting(cwd, getSetting('reactor.enabled')!, 'false');
    expect(bool.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, '.uap.json'), 'utf-8')).reactor.enabled).toBe(false);

    const bad = applySetting(cwd, getSetting('delivery.enforcement')!, 'nonsense');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/expected one of/);
  });

  it('persists a proxyEnv setting to .uap/proxy.env', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const res = applySetting(cwd, getSetting('PROXY_CONTEXT_WINDOW')!, '32768');
    expect(res.ok).toBe(true);
    expect(readFileSync(join(cwd, '.uap', 'proxy.env'), 'utf-8')).toMatch(/PROXY_CONTEXT_WINDOW=32768/);
  });

  it('a shell-kind setting is not persisted but returns the export line', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const res = applySetting(cwd, getSetting('UAP_MAX_PARALLEL')!, '8');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/export UAP_MAX_PARALLEL=8/);
  });

  it('reports the default when a setting is absent', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const s = getSetting('reactor.enabled')!;
    expect(currentValue(cwd, s)).toEqual({ value: true, source: 'default' });
  });

  it('rejects out-of-range / non-integer numbers instead of corrupting the config', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    expect(applySetting(cwd, getSetting('recipes.fusionN')!, '100').ok).toBe(false); // max 6
    expect(applySetting(cwd, getSetting('recipes.fusionN')!, '1.5').ok).toBe(false); // int
    expect(applySetting(cwd, getSetting('modelConcurrency.slots')!, '0').ok).toBe(false); // min 1
    expect(applySetting(cwd, getSetting('recipes.confidenceThreshold')!, '5').ok).toBe(false); // max 1
    // A valid set keeps the config strictly parseable (the whole point of the bounds).
    expect(applySetting(cwd, getSetting('recipes.fusionN')!, '4').ok).toBe(true);
    expect(applySetting(cwd, getSetting('recipes.confidenceThreshold')!, '0.7').ok).toBe(true);
    expect(loadUapConfig(cwd)).not.toBeNull(); // strict schema still accepts it
  });

  it('rejects a value containing a newline (proxy.env line injection)', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const res = applySetting(cwd, getSetting('ANTHROPIC_PASSTHROUGH_MODELS')!, 'x\nPROXY_LOOP_BREAKER=0');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/newline/);
  });
});

describe('secret masking', () => {
  it('never emits a set secret value in `config list --json`', () => {
    const cwd = scratch({ version: '1.0.0', project: { name: 't' } });
    const secretVal = 'sk-supersecret-DO-NOT-LEAK';
    applySetting(cwd, getSetting('PROXY_ESCALATE_API_KEY')!, secretVal); // → .uap/proxy.env
    const list = listSettingsJson(cwd);
    const entry = list.find((e) => e.key === 'PROXY_ESCALATE_API_KEY')!;
    expect(entry.secret).toBe(true);
    expect(entry.isSet).toBe(true);
    expect(entry.current).toBeNull(); // masked
    expect(JSON.stringify(list)).not.toContain(secretVal); // nowhere in the payload
  });
});

describe('generated reference doc', () => {
  it('covers every category and a known setting', () => {
    const md = renderReferenceMarkdown();
    expect(md).toContain('# UAP Configuration Reference');
    expect(md).toContain('`delivery.enforcement`');
    for (const c of CATEGORIES) {
      if (settingsByCategory(c.id).length) expect(md, c.title).toContain(`## ${c.title}`);
    }
  });
});

describe('policy recommendations', () => {
  it('recommendedFor merges core + scenario extras, de-duplicated', () => {
    const team = recommendedFor('team');
    const slugs = team.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // no dupes
    for (const c of CORE) expect(slugs).toContain(c.slug); // core always present
    expect(slugs).toContain('coord-overlap'); // a team extra
  });

  it('an unknown scenario falls back to the core set only', () => {
    expect(recommendedFor('does-not-exist').map((r) => r.slug)).toEqual(CORE.map((c) => c.slug));
  });

  it('every scenario is well-formed', () => {
    for (const s of SCENARIOS) {
      expect(getScenario(s.id)).toBe(s);
      expect(s.title.length).toBeGreaterThan(0);
      for (const e of s.extra) expect(e.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
