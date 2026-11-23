import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_EMBEDDING_ENDPOINT,
  LlamaCppEmbeddingProvider,
} from '../../src/memory/embeddings.js';
import { AgentExecutionSchema } from '../../src/types/config.js';

/**
 * Regression tests for the stale-LAN-IP defaults (monitoring round 5,
 * 2026-11-23): the box's subnet moved from 192.168.1.x to 192.168.8.x and
 * every hardcoded 192.168.1.165 endpoint silently died. The defaults must
 * be loopback (fail fast, and correct once the local service is restored),
 * and the env override must keep winning.
 */

describe('default embedding endpoint (stale-LAN-IP regression)', () => {
  const savedEndpoint = process.env.UAP_EMBEDDING_ENDPOINT;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedEndpoint === undefined) {
      delete process.env.UAP_EMBEDDING_ENDPOINT;
    } else {
      process.env.UAP_EMBEDDING_ENDPOINT = savedEndpoint;
    }
  });

  it('defaults to the loopback nomic server, never a LAN IP', () => {
    expect(DEFAULT_EMBEDDING_ENDPOINT).toBe('http://127.0.0.1:8081');
    expect(DEFAULT_EMBEDDING_ENDPOINT).not.toMatch(/192\.168\./);
  });

  it('probes the loopback default when no env override is set', async () => {
    delete process.env.UAP_EMBEDDING_ENDPOINT;
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      (async (url: string | URL | Request) => {
        const target = String(url);
        seen.push(target);
        if (target.endsWith('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }),
          { status: 200 }
        );
      }) as typeof fetch
    );

    const provider = new LlamaCppEmbeddingProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith('http://127.0.0.1:8081'))).toBe(true);
  });

  it('still prefers UAP_EMBEDDING_ENDPOINT over the default', async () => {
    process.env.UAP_EMBEDDING_ENDPOINT = 'http://127.0.0.1:9999';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      (async (url: string | URL | Request) => {
        const target = String(url);
        seen.push(target);
        if (target.endsWith('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }),
          { status: 200 }
        );
      }) as typeof fetch
    );

    const provider = new LlamaCppEmbeddingProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(seen.every((u) => u.startsWith('http://127.0.0.1:9999'))).toBe(true);
  });
});

describe('webSearchEndpoint default (stale-LAN-IP regression)', () => {
  it('defaults to loopback so a missing SearXNG fails fast, not on a dead LAN route', () => {
    const parsed = AgentExecutionSchema.shape.webSearchEndpoint.parse(undefined);
    expect(parsed).toBe('http://127.0.0.1:8888');
    expect(parsed).not.toMatch(/192\.168\./);
  });
});
