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
  const saved = { e: process.env.UAP_VISION_ENDPOINT, m: process.env.UAP_VISION_MODEL };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-vjudge-'));
    shot = join(dir, 's.png');
    writeFileSync(shot, PNG);
    process.env.UAP_VISION_ENDPOINT = 'http://x/v1';
    process.env.UAP_VISION_MODEL = 'local';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.e === undefined) delete process.env.UAP_VISION_ENDPOINT; else process.env.UAP_VISION_ENDPOINT = saved.e;
    if (saved.m === undefined) delete process.env.UAP_VISION_MODEL; else process.env.UAP_VISION_MODEL = saved.m;
  });

  const mkFetch = (message: Record<string, unknown>) =>
    (async () => ({ ok: true, json: async () => ({ choices: [{ message }] }) })) as never;

  it('sends chat_template_kwargs.enable_thinking=false in the request', async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score":7,"findings":[]}' } }] }) };
    }) as never;
    await judgeScreenshots([shot], 'spec', '', fetchImpl);
    expect((sentBody as { chat_template_kwargs?: { enable_thinking?: boolean } }).chat_template_kwargs?.enable_thinking).toBe(false);
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
