/**
 * Long model HTTP: transient-failure classification and bounded retry —
 * the guard against undici's 300s headersTimeout killing long local-model
 * turns as opaque `TypeError: fetch failed`.
 */

import { describe, it, expect } from 'vitest';
import {
  isTransientNetworkError,
  fetchModelWithRetry,
  modelHttpTimeoutMs,
} from '../../src/models/long-fetch.js';

function fetchFailed(code?: string): TypeError {
  const err = new TypeError('fetch failed');
  if (code) (err as TypeError & { cause?: { code: string } }).cause = { code };
  return err;
}

describe('isTransientNetworkError', () => {
  it('classifies undici transport failures as transient', () => {
    expect(isTransientNetworkError(fetchFailed())).toBe(true);
    expect(isTransientNetworkError(fetchFailed('UND_ERR_HEADERS_TIMEOUT'))).toBe(true);
    expect(isTransientNetworkError(fetchFailed('ECONNRESET'))).toBe(true);
  });

  it('never retries deliberate aborts or protocol errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientNetworkError(abort)).toBe(false);
    expect(isTransientNetworkError(new Error('agentic chat failed (500): boom'))).toBe(false);
    expect(isTransientNetworkError('not-an-error')).toBe(false);
  });
});

describe('fetchModelWithRetry', () => {
  it('retries transient failures with backoff and succeeds', async () => {
    let calls = 0;
    const retriedAt: number[] = [];
    const impl = (async () => {
      calls++;
      if (calls < 3) throw fetchFailed('UND_ERR_HEADERS_TIMEOUT');
      return { ok: true, status: 200 } as Response;
    }) as never;
    const res = await fetchModelWithRetry('http://x/v1/chat/completions', { method: 'POST' }, {
      fetchImpl: impl,
      backoffMs: 1,
      onRetry: (attempt) => retriedAt.push(attempt),
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
    expect(retriedAt).toEqual([1, 2]);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      throw fetchFailed('ECONNRESET');
    }) as never;
    await expect(
      fetchModelWithRetry('http://x', {}, { fetchImpl: impl, retries: 2, backoffMs: 1 })
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('does NOT retry non-transient errors', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      throw new Error('boom');
    }) as never;
    await expect(fetchModelWithRetry('http://x', {}, { fetchImpl: impl, backoffMs: 1 })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('modelHttpTimeoutMs', () => {
  it('defaults to 30 minutes and honors the env override', () => {
    delete process.env.UAP_MODEL_HTTP_TIMEOUT_MS;
    expect(modelHttpTimeoutMs()).toBe(30 * 60 * 1000);
    process.env.UAP_MODEL_HTTP_TIMEOUT_MS = '60000';
    try {
      expect(modelHttpTimeoutMs()).toBe(60000);
    } finally {
      delete process.env.UAP_MODEL_HTTP_TIMEOUT_MS;
    }
  });
});
