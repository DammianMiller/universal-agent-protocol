import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawCompletionAdapter, rawMaxTokens } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { TaskSpec } from '../../src/benchmarks/paired/types.js';

/**
 * A reasoning model spends its completion budget on a hidden thinking channel
 * BEFORE emitting any answer tokens. So a budget that comfortably fits the
 * answer can still yield an EMPTY completion with finish_reason=length — which
 * parses to zero file blocks and is indistinguishable, in the record, from the
 * model answering in the wrong format.
 *
 * That conflation is what sent the first investigation after a prompt-format
 * fix for what was really a max_tokens ceiling. These tests pin the budget and
 * the attribution so the same misreading can't recur.
 */
function mockChat(bodies: { content: string; finish?: string }[]): { captured: unknown[] } {
  const captured: unknown[] = [];
  let i = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    captured.push(JSON.parse(String((init as RequestInit).body)));
    const b = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: b.content }, finish_reason: b.finish ?? 'stop' }],
        usage: { total_tokens: 100 },
      }),
    } as unknown as Response;
  });
  return { captured };
}

const fileBlock = (p: string, body: string): string => `<<<FILE ${p}>>>\n${body}\n<<<END>>>`;

describe('raw adapter completion-budget truncation', () => {
  let dir: string;
  let task: TaskSpec;
  const savedEnv = process.env.UAP_RAW_MAX_TOKENS;

  beforeEach(() => {
    delete process.env.UAP_RAW_MAX_TOKENS;
    dir = mkdtempSync(join(tmpdir(), 'uap-trunc-'));
    mkdirSync(join(dir, 'repo'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'a.js'), 'broken');
    task = {
      id: 't',
      name: 't',
      instruction: 'fix it',
      gateCmd: 'exit 1',
      verifyCmd: 'exit 1',
      verifyTimeoutSec: 5,
      agentTimeoutSec: 5,
    } as TaskSpec;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.UAP_RAW_MAX_TOKENS;
    else process.env.UAP_RAW_MAX_TOKENS = savedEnv;
  });

  const run = (a: RawCompletionAdapter) =>
    a.run({ task, condition: makeFullCondition(), workdir: join(dir, 'repo'), seed: 0, model: 'm' });

  it('budgets enough tokens for the thinking channel plus an answer', () => {
    // Measured on this model: at 4096, 8/15 first turns returned EMPTY with
    // finish_reason=length; at 8192 that fell to 2/15, with successes ranging
    // to 7631 tokens. The budget has to clear the long tail of thinking
    // length, not its mean — 8192 sits inside the tail.
    expect(rawMaxTokens()).toBeGreaterThan(8192);
  });

  it('honours an explicit budget override and ignores a garbage one', () => {
    // Deliberately NOT the default, or this asserts nothing about the override.
    process.env.UAP_RAW_MAX_TOKENS = '32768';
    expect(rawMaxTokens()).toBe(32768);
    process.env.UAP_RAW_MAX_TOKENS = 'not-a-number';
    expect(rawMaxTokens()).toBe(16384);
    process.env.UAP_RAW_MAX_TOKENS = '-5';
    expect(rawMaxTokens()).toBe(16384);
  });

  it('sends the configured budget on the wire', async () => {
    process.env.UAP_RAW_MAX_TOKENS = '12345';
    const { captured } = mockChat([{ content: fileBlock('a.js', 'v1') }]);
    await run(new RawCompletionAdapter({ maxGateIters: 1 }));
    expect((captured[0] as { max_tokens: number }).max_tokens).toBe(12345);
  });

  it('attributes an empty finish_reason=length turn to budget, not format', async () => {
    const r = await (async () => {
      mockChat([{ content: '', finish: 'length' }]);
      return run(new RawCompletionAdapter({ maxGateIters: 1 }));
    })();
    expect(r.rawLog).toContain('TRUNCATED');
    expect(r.rawLog).toContain('1/1 turn(s) truncated');
  });

  it('does NOT call a wrong-format turn truncated', async () => {
    // Stopped normally, just not in the marker format. Zero blocks, but the
    // model DID answer — a genuine format failure, and it must stay legible as
    // one rather than being blamed on the budget.
    mockChat([{ content: 'here is your code: function f(){}', finish: 'stop' }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 1 }));
    expect(r.rawLog).toContain('0 file(s)');
    expect(r.rawLog).not.toContain('TRUNCATED');
  });

  it('does NOT call a truncated-but-non-empty turn a lost turn', async () => {
    // finish_reason=length with real content means the answer started and got
    // clipped — the blocks that did land are still applied.
    mockChat([{ content: fileBlock('a.js', 'v1'), finish: 'length' }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 1 }));
    expect(r.rawLog).toContain('1 file(s)');
    expect(r.rawLog).not.toContain('TRUNCATED');
  });

  it('records finish_reason on every turn so the cause is in the artifact', async () => {
    mockChat([{ content: fileBlock('a.js', 'v1'), finish: 'stop' }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 1 }));
    expect(r.rawLog).toContain('finish=stop');
  });
});
