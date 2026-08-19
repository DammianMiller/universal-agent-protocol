/**
 * Automatic local-model identity.
 *
 * The pinned name was a latent outage for three model generations: llama.cpp
 * IGNORES the OpenAI `model` field, so `qwen35-a3b-iq4xs` → `qwen36-35b-a3b-iq4xs`
 * → `qwen3.8-27b` drifted harmlessly and invisibly. A backend that VALIDATES the
 * field turned every stale pin into `404 model_not_found` at once — including four
 * `claude-*` ids the proxy advertises and this repo's own `roles.fallback`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AUTO_MODEL,
  isAutoModel,
  probeServedModel,
  resolveWireModel,
  resetLocalModelCache,
} from '../../src/models/local-model.js';
import { ModelPresets } from '../../src/models/types.js';
import { profileForModelId } from '../../src/models/profile-map.js';

const ENDPOINT = 'http://127.0.0.1:9/v1';
const okModels = (ids: string[]) =>
  ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id, object: 'model' })) }) }) as unknown as Response;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetLocalModelCache();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
  resetLocalModelCache();
});

describe('resolveWireModel', () => {
  it('resolves the sentinel to whatever the endpoint serves', async () => {
    fetchSpy.mockResolvedValue(okModels(['qwen3.8-27b']));
    expect(await resolveWireModel(AUTO_MODEL, ENDPOINT)).toBe('qwen3.8-27b');
  });

  it('leaves a PINNED model name alone', async () => {
    // Automatic resolution is opt-in. An operator who pinned a model must never
    // be silently redirected to a different one.
    expect(await resolveWireModel('claude-sonnet-4-6', ENDPOINT)).toBe('claude-sonnet-4-6');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the SENTINEL, not a guess, when the endpoint cannot answer', async () => {
    // A guessed name looks like a real request for a real model and 404s. The
    // sentinel is an id no backend serves, so the proxy's wire reconciliation
    // rewrites it to the served one — the failure still lands on its feet.
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await resolveWireModel(AUTO_MODEL, ENDPOINT)).toBe(AUTO_MODEL);
  });

  it('survives a non-200, a non-JSON body and an empty list', async () => {
    fetchSpy.mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response);
    expect(await probeServedModel(ENDPOINT)).toBeNull();
    resetLocalModelCache();
    fetchSpy.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } } as unknown as Response);
    expect(await probeServedModel(ENDPOINT)).toBeNull();
    resetLocalModelCache();
    fetchSpy.mockResolvedValue(okModels([]));
    expect(await probeServedModel(ENDPOINT)).toBeNull();
  });

  it('rejects an id that is not a plausible model name', async () => {
    resetLocalModelCache();
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 12345 }] }) } as unknown as Response);
    expect(await probeServedModel(ENDPOINT)).toBeNull();
    resetLocalModelCache();
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: ['bare-string'] }) } as unknown as Response);
    expect(await probeServedModel(ENDPOINT)).toBeNull();
    resetLocalModelCache();
    fetchSpy.mockResolvedValue(okModels(['x'.repeat(500)]));
    expect(await probeServedModel(ENDPOINT)).toBeNull();
  });

  it('never resolves a LOCAL model to a cloud id', async () => {
    // REGRESSION, found by running it against the live proxy. The UAP proxy
    // advertises the four Claude contract ids alongside the local model and
    // listed them FIRST, so "take the first id" resolved the local model to
    // `claude-haiku-4-5-20251001` — a cloud name, on a local endpoint.
    fetchSpy.mockResolvedValue(
      okModels(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'qwen3.8-27b'])
    );
    expect(await resolveWireModel(AUTO_MODEL, ENDPOINT)).toBe('qwen3.8-27b');
  });

  it('skips other providers\' names too, not just Claude', async () => {
    fetchSpy.mockResolvedValue(okModels(['gpt-5.4', 'gemini-3-pro', 'my-local-llm']));
    expect(await resolveWireModel(AUTO_MODEL, ENDPOINT)).toBe('my-local-llm');
  });

  it('falls back to the sentinel when a list holds ONLY cloud ids', async () => {
    // Nothing local is being served, so there is no local answer to give. The
    // sentinel lets the proxy reconcile rather than sending a cloud id to a
    // local engine.
    fetchSpy.mockResolvedValue(okModels(['claude-sonnet-4-6', 'gpt-5.4']));
    expect(await resolveWireModel(AUTO_MODEL, ENDPOINT)).toBe(AUTO_MODEL);
  });

  it('asks ONCE per endpoint, not once per call', async () => {
    // This runs on the hot path of every model request; an unbounded probe would
    // double the request count against a single-rail local server.
    fetchSpy.mockResolvedValue(okModels(['qwen3.8-27b']));
    for (let i = 0; i < 5; i++) await resolveWireModel(AUTO_MODEL, ENDPOINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches the FAILURE too, so an unreachable server is not probed per call', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    for (let i = 0; i < 5; i++) await resolveWireModel(AUTO_MODEL, ENDPOINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keys the cache per endpoint', async () => {
    fetchSpy.mockImplementation(
      (async (u: string) =>
        okModels([u.includes('4000') ? 'served-by-proxy' : 'served-direct'])) as unknown as typeof fetch
    );
    expect(await resolveWireModel(AUTO_MODEL, 'http://127.0.0.1:4000/v1')).toBe('served-by-proxy');
    expect(await resolveWireModel(AUTO_MODEL, 'http://127.0.0.1:8080/v1')).toBe('served-direct');
  });

  it('normalises a trailing slash so one endpoint is not cached twice', async () => {
    fetchSpy.mockResolvedValue(okModels(['qwen3.8-27b']));
    await resolveWireModel(AUTO_MODEL, ENDPOINT);
    await resolveWireModel(AUTO_MODEL, `${ENDPOINT}/`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('the local-auto preset', () => {
  it('pins no model name', () => {
    const p = ModelPresets['local-auto'];
    expect(p).toBeDefined();
    expect(isAutoModel(p.apiModel)).toBe(true);
    expect(p.costPer1MInput).toBe(0);
    expect(p.costPer1MOutput).toBe(0);
    expect(p.provider).toBe('custom');
  });

  it('routes through the proxy, not the inference server directly', () => {
    // The proxy applies the tool/finalize guardrails and advertises the real
    // context window; talking to the engine directly skips both.
    expect(ModelPresets['local-auto'].endpoint).toMatch(/:4000/);
  });

  it('claims no model family until one is resolved', () => {
    // Guessing a sampling profile for an unknown model is worse than the generic
    // one: the qwen profiles carry tool-call-tuned temperature and a GBNF grammar
    // that belong to a specific model.
    expect(profileForModelId('local-auto')).toBe('generic');
  });

  it('every OTHER local preset still names its model, so pins keep working', () => {
    expect(ModelPresets['qwen38-27b'].apiModel).toBe('qwen3.8-27b');
    expect(ModelPresets['qwen36-a3b'].apiModel).toBe('qwen36-35b-a3b-iq4xs');
  });
});
