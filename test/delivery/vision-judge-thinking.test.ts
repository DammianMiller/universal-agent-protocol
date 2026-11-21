import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { judgeScreenshots } from '../../src/delivery/vision-judge.js';

// A 1x1 PNG so readFileSync has real bytes to base64.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('judgeScreenshots — reasoning model robustness', () => {
  let dir: string;
  let shot: string;
  const saved = {
    e: process.env.UAP_VISION_ENDPOINT,
    m: process.env.UAP_VISION_MODEL,
    t: process.env.UAP_VISION_THINKING,
    s: process.env.UAP_VISION_SAMPLES,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-vjudge-'));
    shot = join(dir, 's.png');
    writeFileSync(shot, PNG);
    process.env.UAP_VISION_ENDPOINT = 'http://x/v1';
    process.env.UAP_VISION_MODEL = 'local';
    delete process.env.UAP_VISION_THINKING;
    process.env.UAP_VISION_SAMPLES = '1';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.e === undefined) delete process.env.UAP_VISION_ENDPOINT; else process.env.UAP_VISION_ENDPOINT = saved.e;
    if (saved.m === undefined) delete process.env.UAP_VISION_MODEL; else process.env.UAP_VISION_MODEL = saved.m;
    if (saved.t === undefined) delete process.env.UAP_VISION_THINKING; else process.env.UAP_VISION_THINKING = saved.t;
    if (saved.s === undefined) delete process.env.UAP_VISION_SAMPLES; else process.env.UAP_VISION_SAMPLES = saved.s;
  });

  const mkFetch = (message: Record<string, unknown>) =>
    (async () => ({ ok: true, json: async () => ({ choices: [{ message }] }) })) as never;

  it('defaults to thinking ON (enable_thinking=true, max_tokens=4096, x-uap-reasoning=1)', async () => {
    let sentBody: unknown;
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: { body: string; headers?: Record<string, string> }) => {
      sentBody = JSON.parse(init.body);
      sentHeaders = init.headers ?? {};
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score":7,"findings":[]}' } }] }) };
    }) as never;
    await judgeScreenshots([shot], 'spec', '', fetchImpl);
    const parsed = sentBody as { max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } };
    expect(parsed.chat_template_kwargs?.enable_thinking).toBe(true);
    expect(parsed.max_tokens).toBe(4096);
    expect(sentHeaders['x-uap-reasoning']).toBe('1');
  });

  it('supports legacy fast mode when UAP_VISION_THINKING=0', async () => {
    process.env.UAP_VISION_THINKING = '0';
    let sentBody: unknown;
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: { body: string; headers?: Record<string, string> }) => {
      sentBody = JSON.parse(init.body);
      sentHeaders = init.headers ?? {};
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score":7,"findings":[]}' } }] }) };
    }) as never;
    await judgeScreenshots([shot], 'spec', '', fetchImpl);
    const parsed = sentBody as { max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } };
    expect(parsed.chat_template_kwargs?.enable_thinking).toBe(false);
    expect(parsed.max_tokens).toBe(800);
    expect(sentHeaders['x-uap-reasoning']).toBeUndefined();
  });

  it('parses the verdict from content (normal case)', async () => {
    const v = await judgeScreenshots([shot], 'spec', '', mkFetch({ content: '```json\n{"score": 8, "findings": ["clean"]}\n```' }));
    expect(v?.score).toBe(8);
    expect(v?.findings).toContain('clean');
  });

  it('falls back to reasoning_content when content is empty (reasoning model)', async () => {
    const v = await judgeScreenshots([shot], 'spec', '', mkFetch({ content: '', reasoning_content: 'I judge this: {"score": 4, "findings": ["cramped"]}' }));
    expect(v?.score).toBe(4);
    expect(v?.findings).toContain('cramped');
  });

  it('returns null when neither field has a verdict', async () => {
    const v = await judgeScreenshots([shot], 'spec', '', mkFetch({ content: '', reasoning_content: 'no json here' }));
    expect(v).toBeNull();
  });
});
