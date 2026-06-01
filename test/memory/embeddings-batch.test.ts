/**
 * LlamaCppEmbeddingProvider.embedBatch hardening
 *
 * The long-term memory store path embeds in batches; the llama.cpp embedding
 * server caps total tokens per request, so large batches / long docs return
 * 4xx-5xx. embedBatch must truncate long docs, sub-batch requests, and fall back
 * per-item (zero vector for a doc the server still rejects) so storage/prepopulate
 * never aborts mid-run.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LlamaCppEmbeddingProvider } from '../../src/memory/embeddings.js';

const DIM = 4;

// fetch mock: 400 if batch > 8 inputs or any input contains 'REJECT'; else 200.
function mockFetch() {
  return vi.fn(async (_url: string, opts: { body: string }) => {
    const inputs: string[] = JSON.parse(opts.body).input;
    if (inputs.length > 8 || inputs.some((t) => t.includes('REJECT'))) {
      return { ok: false, status: 400, statusText: 'Bad Request' } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        data: inputs.map((_t, i) => ({ index: i, embedding: new Array(DIM).fill(0.1) })),
      }),
    } as unknown as Response;
  });
}

describe('LlamaCppEmbeddingProvider.embedBatch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sub-batches large input sets and preserves order/length', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = new LlamaCppEmbeddingProvider('http://x');
    const texts = Array.from({ length: 20 }, (_, i) => `doc ${i}`);
    const out = await p.embedBatch(texts);
    expect(out).toHaveLength(20); // all returned despite >8 (would 400 as one batch)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3); // 20 / sub-batch(8) => 3 calls
    expect(out.every((v) => v.length === DIM)).toBe(true);
  });

  it('truncates documents longer than the per-request limit', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = new LlamaCppEmbeddingProvider('http://x');
    await p.embedBatch(['x'.repeat(5000)]);
    const sent: string = JSON.parse(fetchMock.mock.calls[0][1].body).input[0];
    expect(sent.length).toBeLessThanOrEqual(2000);
  });

  it('falls back to a zero vector for a doc the server rejects', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = new LlamaCppEmbeddingProvider('http://x');
    // 8 good (sets dimension), then a chunk containing a REJECT doc
    const texts = [...Array.from({ length: 8 }, (_, i) => `ok ${i}`), 'ok last', 'REJECT this'];
    const out = await p.embedBatch(texts);
    expect(out).toHaveLength(10);
    expect(out[8]).toEqual(new Array(DIM).fill(0.1)); // good doc embedded
    expect(out[9]).toEqual(new Array(DIM).fill(0)); // rejected doc -> zero vector
  });
});
