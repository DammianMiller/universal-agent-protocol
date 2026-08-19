import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { ModelPresets } from '../../src/models/index.js';
import {
  MODEL_PRESET_PROFILE,
  PROVIDER_DEFAULT_PROFILE,
  profileForModelId,
  profileForRouting,
  profileForProvider,
  clearToolCallProfilePin,
  GENERIC_PROFILE,
} from '../../src/models/profile-map.js';

const PROFILES_DIR = join(process.cwd(), 'config', 'model-profiles');

describe('profileForModelId', () => {
  it('maps every current ModelPresets id to a profile filename', () => {
    expect(profileForModelId('opus-4.8')).toBe('claude-opus-4.8');
    expect(profileForModelId('fable-5')).toBe('claude-fable-5');
    expect(profileForModelId('sonnet-5')).toBe('claude-sonnet-5');
    expect(profileForModelId('haiku-4.5')).toBe('claude-haiku-4.5');
    expect(profileForModelId('gpt-5.4')).toBe('gpt-5.4');
    expect(profileForModelId('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(profileForModelId('qwen36-a3b')).toBe('qwen36');
    expect(profileForModelId('qwen35-a3b')).toBe('qwen35');
  });

  it('fuzzy-matches raw apiModel strings and unknown aliases to the right family', () => {
    expect(profileForModelId('claude-opus-4-8')).toBe('claude-opus-4.8');
    expect(profileForModelId('claude-fable-5')).toBe('claude-fable-5');
    expect(profileForModelId('claude-sonnet-5-20250514')).toBe('claude-sonnet-5');
    expect(profileForModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    expect(profileForModelId('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(profileForModelId('qwen36-35b-a3b-iq4xs')).toBe('qwen36');
    // Ordering guard: the 3.8 rule must be tested BEFORE the 3.6 rule and
    // before the bare /qwen/ fallback, or these land on qwen36 / qwen35.
    expect(profileForModelId('qwen3.8-27b')).toBe('qwen38');
    expect(profileForModelId('qwen38-27b')).toBe('qwen38');
    expect(profileForModelId('Qwen3_8-27B')).toBe('qwen38');
  });

  it('falls back to generic for empty / unknown model ids', () => {
    expect(profileForModelId(undefined)).toBe(GENERIC_PROFILE);
    expect(profileForModelId(null)).toBe(GENERIC_PROFILE);
    expect(profileForModelId('')).toBe(GENERIC_PROFILE);
    expect(profileForModelId('some-random-llm')).toBe(GENERIC_PROFILE);
  });
});

describe('profileForRouting', () => {
  it('derives the profile from the executor role when routing is enabled', () => {
    expect(
      profileForRouting({ enabled: true, roles: { executor: 'qwen36-a3b' } })
    ).toBe('qwen36');
    expect(
      profileForRouting({ enabled: true, roles: { executor: 'haiku-4.5' } })
    ).toBe('claude-haiku-4.5');
  });

  it('returns null when routing is absent, disabled, or missing an executor', () => {
    expect(profileForRouting(undefined)).toBeNull();
    expect(profileForRouting(null)).toBeNull();
    expect(profileForRouting({ enabled: false, roles: { executor: 'qwen36-a3b' } })).toBeNull();
    expect(profileForRouting({ enabled: true, roles: {} })).toBeNull();
  });
});

describe('profileForProvider', () => {
  it('maps each provider to its default profile, generic for unknown/empty', () => {
    expect(profileForProvider('anthropic')).toBe('claude-sonnet-5');
    expect(profileForProvider('openai')).toBe('gpt-5.4');
    expect(profileForProvider('local')).toBe('qwen38');
    expect(profileForProvider('custom')).toBe(GENERIC_PROFILE);
    expect(profileForProvider('unknown')).toBe(GENERIC_PROFILE);
    expect(profileForProvider(undefined)).toBe(GENERIC_PROFILE);
  });
});


describe('clearToolCallProfilePin', () => {
  it('removes a stale modelProfile pin so the profile auto-follows routing', () => {
    const cfg = { toolCalls: { modelProfile: 'qwen35-a3b' }, multiModel: { enabled: true } };
    const { config, cleared } = clearToolCallProfilePin(cfg);
    expect(cleared).toBe('qwen35-a3b');
    expect(config.toolCalls).toBeUndefined();
    // routing block is left intact
    expect((config.multiModel as { enabled?: boolean }).enabled).toBe(true);
  });

  it('preserves other toolCalls keys (e.g. llmServer) when clearing the pin', () => {
    const cfg = { toolCalls: { modelProfile: 'qwen35-a3b', llmServer: 'http://127.0.0.1:4000' } };
    const { config, cleared } = clearToolCallProfilePin(cfg);
    expect(cleared).toBe('qwen35-a3b');
    expect(config.toolCalls).toEqual({ llmServer: 'http://127.0.0.1:4000' });
  });

  it('is a no-op (cleared=null) when there is no pin, and does not mutate input', () => {
    const cfg = { toolCalls: { llmServer: 'x' }, other: 1 };
    const { config, cleared } = clearToolCallProfilePin(cfg);
    expect(cleared).toBeNull();
    expect(config).toBe(cfg);
    const cfg2 = { multiModel: { enabled: true } };
    expect(clearToolCallProfilePin(cfg2).cleared).toBeNull();
  });
});

describe('profile files exist for every mapping (auto-switch integrity)', () => {
  it('every MODEL_PRESET_PROFILE target has a config/model-profiles/*.json', () => {
    for (const profile of Object.values(MODEL_PRESET_PROFILE)) {
      expect(existsSync(join(PROFILES_DIR, `${profile}.json`)), `${profile}.json missing`).toBe(
        true
      );
    }
  });

  it('every PROVIDER_DEFAULT_PROFILE target (and generic) has a profile file', () => {
    for (const profile of [...Object.values(PROVIDER_DEFAULT_PROFILE), GENERIC_PROFILE]) {
      expect(existsSync(join(PROFILES_DIR, `${profile}.json`)), `${profile}.json missing`).toBe(
        true
      );
    }
  });
});

describe('ModelPresets → mapping completeness (fail-loud on drift)', () => {
  it('every ModelPresets id has an EXPLICIT MODEL_PRESET_PROFILE entry with a backing file', () => {
    for (const id of Object.keys(ModelPresets)) {
      const profile = MODEL_PRESET_PROFILE[id];
      // Explicit entry required — do NOT rely on the fuzzy fallback for a known
      // preset, or a newly-added model would silently resolve to a stale/generic
      // profile with no test failure.
      expect(profile, `ModelPresets '${id}' has no MODEL_PRESET_PROFILE entry`).toBeDefined();
      expect(
        existsSync(join(PROFILES_DIR, `${profile}.json`)),
        `${profile}.json (for preset '${id}') missing`
      ).toBe(true);
    }
  });
});
