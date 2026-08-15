import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatClient } from '../../src/models/openai-compat-client.js';
import type { ModelConfig } from '../../src/models/types.js';

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'custom',
    apiModel: 'test-1',
    endpoint: 'http://localhost:9999/v1',
    maxContextTokens: 8192,
    capabilities: [],
    ...overrides,
  };
}

describe('OpenAICompatClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.UAP_TEST_KEY;
  });

  it('parses content and usage from a chat completion response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi', { temperature: 0.2, maxTokens: 100 });

    expect(result.content).toBe('hello');
    expect(result.tokensUsed).toEqual({ input: 10, output: 5 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:9999/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('test-1');
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100);
  });

  it('throws a descriptive error on non-OK responses and missing choices', async () => {
    // 503 is now a RETRYABLE status (transient upstream window); disable the
    // status-retry budget here so the test exercises the terminal error path
    // rather than waiting out real backoff.
    process.env.UAP_MODEL_STATUS_RETRIES = '0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('overloaded', { status: 503 })));
    const client = new OpenAICompatClient();
    try {
      await expect(client.complete(model(), 'hi')).rejects.toThrow(/503.*overloaded/s);
    } finally {
      delete process.env.UAP_MODEL_STATUS_RETRIES;
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 200 }))
    );
    await expect(client.complete(model(), 'hi')).rejects.toThrow(/missing content: boom/);
  });

  it('refuses to send an API key over plaintext http to a non-local host', async () => {
    process.env.UAP_TEST_KEY = 'sk-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const remote = model({ endpoint: 'http://api.example.com/v1', apiKeyEnvVar: 'UAP_TEST_KEY' });
    await expect(client.complete(remote, 'hi')).rejects.toThrow(/Refusing to send/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows keys to loopback and private-network hosts over http', async () => {
    process.env.UAP_TEST_KEY = 'sk-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const local = model({ endpoint: 'http://192.168.1.165:8080/v1', apiKeyEnvVar: 'UAP_TEST_KEY' });
    const result = await client.complete(local, 'hi');
    expect(result.content).toBe('ok');
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-secret' });
  });

  it('retries once with a raised budget when the completion was truncated (finish_reason=length)', async () => {
    const truncated = {
      choices: [{ message: { content: 'node -e "const { mode' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 500, completion_tokens: 8192 },
    };
    const complete = {
      choices: [{ message: { content: 'node -e "assert(mode([1,2,2]) === 2)"' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 900 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(truncated), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(complete), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'write a script');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('node -e "assert(mode([1,2,2]) === 2)"');
    expect(result.finishReason).toBe('stop');
    // Both calls are paid for; the caller's accounting must see both.
    expect(result.tokensUsed).toEqual({ input: 1000, output: 9092 });
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.max_tokens).toBe(32768);
  });

  it('does NOT retry a truncated completion when the caller pinned maxTokens', async () => {
    const truncated = {
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(truncated), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi', { maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('partial');
    // The truncation is still visible to the caller, who owns the budget.
    expect(result.finishReason).toBe('length');
  });

  it('returns the retry result with finishReason=length when the retry is ALSO truncated (and stops at 2 calls)', async () => {
    const truncated = (content: string) => ({
      choices: [{ message: { content }, finish_reason: 'length' }],
      usage: { prompt_tokens: 100, completion_tokens: 8192 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(truncated('short cut')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(truncated('much longer cut')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'write a script');

    // Exactly one retry — a still-truncated retry must never recurse.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('much longer cut');
    expect(result.finishReason).toBe('length');
    expect(result.tokensUsed).toEqual({ input: 200, output: 16384 });
  });

  it('keeps the FIRST result when a still-truncated retry carries less text', async () => {
    const resp = (content: string, finish: string, out: number) => ({
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: out },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(resp('a long useful partial answer', 'length', 8192)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resp('worse', 'length', 300)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'write a script');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('a long useful partial answer');
    expect(result.finishReason).toBe('length');
    // Both decodes were still paid for.
    expect(result.tokensUsed).toEqual({ input: 200, output: 8492 });
  });

  it('skips the retry when the first call already produced the retry budget', async () => {
    const truncated = {
      choices: [{ message: { content: 'huge' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 100, completion_tokens: 32768 },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(truncated), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi');

    // Re-requesting at the same 32k ceiling is a deterministic duplicate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('length');
  });

  it('falls back to the truncated first result when the retry request fails', async () => {
    // The continuation request's 503 must not spin the status-retry ladder —
    // the fallback answer already exists. Budget pinned to 0 for the test.
    process.env.UAP_MODEL_STATUS_RETRIES = '0';
    const truncated = {
      choices: [{ message: { content: 'partial but real' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(truncated), { status: 200 }))
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = new OpenAICompatClient();
      const result = await client.complete(model(), 'hi');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.content).toBe('partial but real');
      expect(result.finishReason).toBe('length');
    } finally {
      delete process.env.UAP_MODEL_STATUS_RETRIES;
    }
  });

  it('makes a single request when finish_reason is absent and no maxTokens was pinned', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('done');
    expect(result.finishReason).toBeUndefined();
  });

  it('honours the UAP_TRUNCATION_RETRY=0 kill-switch', async () => {
    process.env.UAP_TRUNCATION_RETRY = '0';
    try {
      const truncated = {
        choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 100 },
      };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(truncated), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const client = new OpenAICompatClient();
      const result = await client.complete(model(), 'hi');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.finishReason).toBe('length');
    } finally {
      delete process.env.UAP_TRUNCATION_RETRY;
    }
  });

  it('surfaces timeouts with the configured duration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      })
    );

    const client = new OpenAICompatClient({ timeoutMs: 50 });
    await expect(client.complete(model(), 'hi')).rejects.toThrow(/timed out after 50ms/);
  });
});
