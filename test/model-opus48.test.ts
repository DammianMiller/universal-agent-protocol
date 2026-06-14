/**
 * Tests for the opus-4.8 (xhigh effort) model preset and the reasoning_effort
 * wire plumbing in the OpenAI-compatible client.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatClient } from '../src/models/openai-compat-client';
import { ModelPresets, type ModelConfig } from '../src/models/types';

const baseModel: ModelConfig = {
  id: 'm',
  name: 'm',
  provider: 'custom',
  apiModel: 'test-model',
  maxContextTokens: 1000,
  capabilities: [],
};

function captureRequestBodies(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  global.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return bodies;
}

describe('opus-4.8 preset', () => {
  it('is registered with apiModel claude-opus-4-8 and xhigh reasoning effort', () => {
    const o = ModelPresets['opus-4.8'];
    expect(o).toBeDefined();
    expect(o.provider).toBe('anthropic');
    expect(o.apiModel).toBe('claude-opus-4-8');
    expect(o.reasoningEffort).toBe('xhigh');
  });
});

describe('reasoning_effort wire plumbing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps xhigh effort to reasoning_effort:high on the wire', async () => {
    const bodies = captureRequestBodies();
    const client = new OpenAICompatClient();
    await client.complete({ ...baseModel, reasoningEffort: 'xhigh' }, 'hi');
    expect(bodies[0].reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when the model has no effort set', async () => {
    const bodies = captureRequestBodies();
    const client = new OpenAICompatClient();
    await client.complete(baseModel, 'hi');
    expect(bodies[0].reasoning_effort).toBeUndefined();
  });
});
