import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autodetectLocalVision, visionJudgeConfigured } from '../../src/delivery/vision-judge.js';

const ENV = ['UAP_VISION_ENDPOINT', 'UAP_VISION_MODEL', 'UAP_INFERENCE_ENDPOINT', 'LLAMA_CPP_BASE'];

describe('autodetectLocalVision', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('sets endpoint+model from a local model advertising modalities.vision', async () => {
    process.env.UAP_INFERENCE_ENDPOINT = 'http://127.0.0.1:8080/v1';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/props')) return new Response(JSON.stringify({ modalities: { vision: true } }), { status: 200 });
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ models: [{ id: 'Qwen3.6-mmproj.gguf' }] }), { status: 200 });
      return new Response('nope', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await autodetectLocalVision()).toBe(true);
    expect(visionJudgeConfigured()).toBe(true);
    expect(process.env.UAP_VISION_ENDPOINT).toBe('http://127.0.0.1:8080/v1');
    expect(process.env.UAP_VISION_MODEL).toBe('Qwen3.6-mmproj.gguf');
  });

  it('returns false and leaves config unset when no local model has vision', async () => {
    process.env.UAP_INFERENCE_ENDPOINT = 'http://127.0.0.1:8080/v1';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/props')) return new Response(JSON.stringify({ modalities: { vision: false } }), { status: 200 });
      return new Response('nope', { status: 404 });
    }));
    expect(await autodetectLocalVision()).toBe(false);
    expect(visionJudgeConfigured()).toBe(false);
  });

  it('keeps an explicit configuration that still answers', async () => {
    process.env.UAP_VISION_ENDPOINT = 'http://explicit/v1';
    process.env.UAP_VISION_MODEL = 'explicit-model';
    // One liveness probe of the pin, then done — no discovery sweep.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await autodetectLocalVision()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://explicit/props', expect.anything());
    expect(process.env.UAP_VISION_ENDPOINT).toBe('http://explicit/v1');
  });

  it('replaces a STALE explicit pin with the live server', async () => {
    // `uap setup` writes a conventional 127.0.0.1:8080 pin. Once llama moves to
    // an ephemeral port that pin is dead, and treating "configured" as
    // "working" made it permanently defeat discovery — the judge then failed
    // later with a connection error instead of finding the server next door.
    process.env.UAP_VISION_ENDPOINT = 'http://127.0.0.1:8080/v1';
    process.env.UAP_VISION_MODEL = 'stale-model';
    process.env.UAP_INFERENCE_ENDPOINT = 'http://127.0.0.1:59879/v1';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('http://127.0.0.1:8080')) throw new Error('ECONNREFUSED');
      if (url.endsWith('/props')) {
        return new Response(JSON.stringify({ modalities: { vision: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'unsloth/Qwen3.8-27B-GGUF' }] }), { status: 200 });
    }));
    expect(await autodetectLocalVision()).toBe(true);
    expect(process.env.UAP_VISION_ENDPOINT).toBe('http://127.0.0.1:59879/v1');
    expect(process.env.UAP_VISION_MODEL).toBe('unsloth/Qwen3.8-27B-GGUF');
  });

  it('falls through unreachable endpoints without throwing', async () => {
    process.env.LLAMA_CPP_BASE = 'http://127.0.0.1:8080/v1';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await autodetectLocalVision()).toBe(false);
  });
});
