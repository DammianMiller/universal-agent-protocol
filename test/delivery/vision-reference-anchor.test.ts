import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeScreenshots } from '../../src/delivery/vision-judge.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VERDICT = JSON.stringify({
  score: 8,
  axes: { completeness: 8, craftDensity: 8, cohesionPolish: 8, framingErgonomics: 8, runtimeIntegrity: 8 },
  tickets: [],
  findings: [],
});

interface CapturedBody {
  model: string;
  messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
}

function shot(name: string, buf: Buffer = PNG): string {
  const dir = mkdtempSync(join(tmpdir(), `uap-vref-${name}-`));
  const p = join(dir, `${name}.png`);
  writeFileSync(p, buf);
  return p;
}

async function capture(paths: { shots: string[]; refs?: string[] }): Promise<CapturedBody | null> {
  const holder: { init?: { body: string } } = {};
  const capturingFetch = (async (_url: unknown, init: { body: string }) => {
    holder.init = init;
    return { ok: true, json: async () => ({ choices: [{ message: { content: VERDICT } }] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const verdict = await judgeScreenshots(
    paths.shots,
    'the spec',
    '',
    capturingFetch as never,
    paths.refs
  );
  expect(verdict?.score).toBe(8);
  if (!holder.init) return null;
  return JSON.parse(holder.init.body) as CapturedBody;
}

describe('vision judge reference anchoring (U-B)', () => {
  it('labels reference frames as the bar and anchors the rubric to them', async () => {
    process.env.UAP_VISION_ENDPOINT = 'http://vision.invalid/v1';
    process.env.UAP_VISION_MODEL = 'test';
    process.env.UAP_VISION_SAMPLES = '1';
    try {
      const out = shot('out');
      const ref = shot('ref');
      const body = await capture({ shots: [out], refs: [ref] });
      expect(body).not.toBeNull();
      const texts = body!.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
      expect(texts.some((t) => t.includes('REFERENCE TARGET'))).toBe(true);
      expect(texts.some((t) => t.includes('OUTPUT UNDER REVIEW'))).toBe(true);
      expect(texts.some((t) => t.includes('REFERENCE ANCHORING'))).toBe(true);
      expect(texts.some((t) => t.includes('matches or EXCEEDS the reference'))).toBe(true);
      const images = body!.messages[0].content.filter((c) => c.type === 'image_url');
      expect(images).toHaveLength(2); // one reference + one output frame
    } finally {
      delete process.env.UAP_VISION_ENDPOINT;
      delete process.env.UAP_VISION_MODEL;
      delete process.env.UAP_VISION_SAMPLES;
    }
  });

  it('keeps the message shape unchanged without a reference', async () => {
    process.env.UAP_VISION_ENDPOINT = 'http://vision.invalid/v1';
    process.env.UAP_VISION_MODEL = 'test';
    process.env.UAP_VISION_SAMPLES = '1';
    try {
      const out = shot('solo');
      const body = await capture({ shots: [out] });
      expect(body).not.toBeNull();
      const texts = body!.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
      expect(texts.some((t) => t.includes('REFERENCE'))).toBe(false);
      expect(body!.messages[0].content.filter((c) => c.type === 'image_url')).toHaveLength(1);
    } finally {
      delete process.env.UAP_VISION_ENDPOINT;
      delete process.env.UAP_VISION_MODEL;
      delete process.env.UAP_VISION_SAMPLES;
    }
  });
});
