/**
 * Model-call progress hook: planner/judge/critic completions run minutes with
 * zero tool calls, and a deliver run in its PLANNING phase read as dead —
 * external agents kept trying to kill it (2026-08-16). The compat client
 * ticks a registered callback while any completion is in flight; unregistered
 * it must be a perfect no-op.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatClient, setModelCallProgress } from '../../src/models/openai-compat-client.js';
import type { ModelConfig } from '../../src/models/types.js';

const model = (): ModelConfig =>
  ({
    id: 'm',
    apiModel: 'test-1',
    endpoint: 'http://127.0.0.1:9/v1',
    provider: 'openai-compat',
  }) as unknown as ModelConfig;

afterEach(() => {
  setModelCallProgress(null);
  vi.unstubAllGlobals();
});

describe('setModelCallProgress', () => {
  it('ticks the registered callback while a completion is in flight and stops after', async () => {
    let beats = 0;
    setModelCallProgress(() => { beats++; }, 20);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 120));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
          { status: 200 }
        );
      })
    );
    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi');
    expect(result.content).toBe('ok');
    expect(beats).toBeGreaterThanOrEqual(2); // ticked during the 120ms call
    const after = beats;
    await new Promise((r) => setTimeout(r, 80));
    expect(beats).toBe(after); // ticker stopped with the call
  });

  it('is a no-op when unregistered', async () => {
    let beats = 0;
    // Registered then explicitly cleared — the cleared state must not tick.
    setModelCallProgress(() => { beats++; }, 5);
    setModelCallProgress(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 60));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
          { status: 200 }
        );
      })
    );
    const client = new OpenAICompatClient();
    await client.complete(model(), 'hi');
    expect(beats).toBe(0);
  });

  it('captures the callback at call start — clearing mid-flight does not stop an in-flight ticker', async () => {
    // The design relies on per-call capture of the module-level hook: a
    // teardown (setModelCallProgress(null)) racing an in-flight completion
    // must not silence that completion's liveness signal.
    let beats = 0;
    setModelCallProgress(() => { beats++; }, 15);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 40));
        setModelCallProgress(null); // teardown races the in-flight call
        await new Promise((r) => setTimeout(r, 80));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
          { status: 200 }
        );
      })
    );
    const client = new OpenAICompatClient();
    await client.complete(model(), 'hi');
    expect(beats).toBeGreaterThanOrEqual(3); // kept ticking after the mid-flight clear
  });

  it('a throwing callback never breaks the completion', async () => {
    setModelCallProgress(() => { throw new Error('beat exploded'); }, 10);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 60));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'survived' } }], usage: {} }),
          { status: 200 }
        );
      })
    );
    const client = new OpenAICompatClient();
    const result = await client.complete(model(), 'hi');
    expect(result.content).toBe('survived');
  });
});
