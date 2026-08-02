/**
 * P1/P3/P4/P7/P8 — lazy condition, raw-adapter lazy behavior, DAG phase
 * ordering, visual targets, vision-verdict parsing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeLazyCondition, makeFullCondition, makeBaselineCondition } from '../../src/benchmarks/paired/types.js';
import { RawCompletionAdapter } from '../../src/benchmarks/paired/adapter.js';
import { topoOrder } from '../../src/delivery/decompose.js';
import { judgePage } from '../../src/delivery/visual-gate.js';
import { parseVisionVerdict, visionSummary } from '../../src/delivery/vision-judge.js';

describe('lazy condition (P1)', () => {
  it('is a full-components condition flagged lazy', () => {
    const lazy = makeLazyCondition();
    expect(lazy.label).toBe('uap-lazy');
    expect(lazy.lazy).toBe(true);
    expect(lazy.components.size).toBe(makeFullCondition().components.size);
    expect(makeBaselineCondition().components.size).toBe(0);
  });
});

describe('raw adapter lazy behavior (P1+P5)', () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function workdir(): string {
    dir = mkdtempSync(join(tmpdir(), 'uap-lazy-'));
    writeFileSync(join(dir, 'AGENTS.md'), 'UAP SCAFFOLD MARKER');
    writeFileSync(join(dir, 'main.js'), 'module.exports = 1;');
    return dir;
  }

  function stubChat(responses: string[]): string[] {
    const prompts: string[] = [];
    let call = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { messages: Array<{ content: string }> };
      prompts.push(body.messages.map((m) => m.content).join('\n'));
      const content = responses[Math.min(call++, responses.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
      } as unknown as Response;
    });
    return prompts;
  }

  const task = {
    id: 't', name: 't', instruction: 'do it', difficulty: 'hard' as const, tags: [],
    repoDir: '', gateCmd: 'true', verifyCmd: 'true', verifyTimeoutSec: 5, agentTimeoutSec: 5,
  };

  it('lazy first attempt EXCLUDES the UAP scaffold and stops when the gate passes', async () => {
    const prompts = stubChat(['<<<FILE main.js>>>\nmodule.exports = 2;\n<<<END>>>']);
    const adapter = new RawCompletionAdapter({ endpoint: 'http://stub/v1/chat/completions' });
    const result = await adapter.run({
      task: task as never,
      condition: makeLazyCondition(),
      workdir: workdir(),
      seed: 0,
      model: 'm',
    });
    expect(result.turns).toBe(1); // gate `true` passes on the bare attempt
    expect(prompts[0]).not.toContain('UAP SCAFFOLD MARKER');
  });

  it('uap-full includes the scaffold from the first prompt', async () => {
    const prompts = stubChat(['<<<FILE main.js>>>\nmodule.exports = 2;\n<<<END>>>']);
    const adapter = new RawCompletionAdapter({ endpoint: 'http://stub/v1/chat/completions' });
    await adapter.run({
      task: task as never,
      condition: makeFullCondition(),
      workdir: workdir(),
      seed: 0,
      model: 'm',
    });
    expect(prompts[0]).toContain('UAP SCAFFOLD MARKER');
  });

  it('re-prompts are stateless: exactly one system + one user message per iteration', async () => {
    const failing = { ...task, gateCmd: 'false' };
    let lastMessageCount = 0;
    let n = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { messages: unknown[] };
      lastMessageCount = body.messages.length;
      // Must WRITE each turn, or the no-op futility stop ends the loop on turn 1
      // — correctly, since an unchanged workdir cannot change a deterministic
      // gate. This test is about prompt SHAPE across iterations, so it needs a
      // loop that legitimately iterates.
      n++;
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: `<<<FILE main.js>>>\nmodule.exports = ${n};\n<<<END>>>` } }],
          usage: { total_tokens: 5 },
        }),
      } as unknown as Response;
    });
    // `false` emits identical (empty) output every turn, which is a no-progress
    // loop by design. Disable that stop here so the prompt-shape assertion still
    // sees three iterations; the stop itself is covered in raw-futility-stop.
    const adapter = new RawCompletionAdapter({
      endpoint: 'http://stub/v1/chat/completions',
      maxGateIters: 3,
      stopOnNoProgress: false,
    });
    const result = await adapter.run({
      task: failing as never,
      condition: makeFullCondition(),
      workdir: workdir(),
      seed: 0,
      model: 'm',
    });
    expect(result.turns).toBe(3);
    expect(lastMessageCount).toBe(2); // bounded per-iteration prompt (P5)
  });
});

describe('topoOrder (P7)', () => {
  const phase = (id: string, deps?: string[]) => ({ id, title: id, goal: id, ...(deps ? { deps } : {}) });

  it('orders by deps with insertion-order tie-break', () => {
    const out = topoOrder([phase('c', ['a', 'b']), phase('a'), phase('b', ['a'])]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops unknown/self deps and degrades to planner order on cycles', () => {
    const out = topoOrder([phase('a', ['ghost', 'a']), phase('b')]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
    const cyc = topoOrder([phase('x', ['y']), phase('y', ['x'])]);
    expect(cyc.map((p) => p.id)).toEqual(['x', 'y']); // fail-soft: original order
  });
});

describe('visual targets (P8)', () => {
  const base = {
    file: 'index.html', loaded: true, hasCanvas: true, distinctColors: 20,
    dominantRatio: 0.5, motionRatio: 0.1, expectsAnimation: true,
    runtimeErrors: [] as string[], screenshots: [] as string[],
  };

  it('project targets tighten the built-in floors', () => {
    expect(judgePage(base)).toEqual([]);
    const strict = judgePage(base, { minDistinctColors: 40, minMotionRatio: 0.5 });
    expect(strict.join(' ')).toContain('40 required');
    expect(strict.join(' ')).toContain('50.0% required');
  });
});

describe('vision verdict parsing (P8)', () => {
  it('parses and clamps a verdict from noisy output', () => {
    const v = parseVisionVerdict('review follows {"score": 14, "findings": ["fix contrast", 42]} done');
    expect(v).not.toBeNull();
    expect(v!.score).toBe(10);
    expect(v!.findings).toEqual(['fix contrast']);
    expect(visionSummary(v)).toContain('10.0/10');
  });

  it('fails soft on garbage', () => {
    expect(parseVisionVerdict('no json')).toBeNull();
    expect(parseVisionVerdict('{"score":"NaNish"}')).toBeNull();
    expect(visionSummary(null)).toBeNull();
  });
});
