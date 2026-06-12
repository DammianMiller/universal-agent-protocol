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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('overloaded', { status: 503 })));
    const client = new OpenAICompatClient();
    await expect(client.complete(model(), 'hi')).rejects.toThrow(/503.*overloaded/s);

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
