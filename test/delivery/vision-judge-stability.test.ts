/**
 * Vision-score stability: the aesthetic score gates a DONE claim, so run-to-run
 * variance (the same render scoring 3→8) can false-block a good deliverable.
 * Default call is deterministic (temperature 0); UAP_VISION_SAMPLES>1 takes the
 * median of N independent scores for robustness against a single bad judgment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeScreenshots } from '../../src/delivery/vision-judge.js';

describe('judgeScreenshots — score stability', () => {
  let dir: string, shot: string;
  const saved = { e: process.env.UAP_VISION_ENDPOINT, m: process.env.UAP_VISION_MODEL, s: process.env.UAP_VISION_SAMPLES };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-vision-'));
    shot = join(dir, 's.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    process.env.UAP_VISION_ENDPOINT = 'http://x/v1';
    process.env.UAP_VISION_MODEL = 'local';
    delete process.env.UAP_VISION_SAMPLES;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['UAP_VISION_ENDPOINT', saved.e], ['UAP_VISION_MODEL', saved.m], ['UAP_VISION_SAMPLES', saved.s]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const mkFetch = (scores: number[]) => {
    let i = 0;
    const bodies: any[] = [];
    const fn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const score = scores[Math.min(i++, scores.length - 1)];
      return { ok: true, json: async () => ({ choices: [{ message: { content: `{"score": ${score}, "findings": []}` } }] }) };
    }) as never;
    (fn as any).bodies = bodies;
    return fn;
  };

  it('defaults to the MEDIAN of three scores (robust to an outlier)', async () => {
    const f = mkFetch([4, 8, 6]); // sorted → 4,6,8 → median 6, ignoring the low outlier
    const v = await judgeScreenshots([shot], 'spec', '', f);
    expect(v?.score).toBe(6);
    expect((f as any).bodies.length).toBe(3);
    expect((f as any).bodies[0].temperature).toBeGreaterThan(0); // samples vary so median is meaningful
  });

  it('UAP_VISION_SAMPLES=1 opts into a single deterministic call (temperature 0)', async () => {
    process.env.UAP_VISION_SAMPLES = '1';
    const f = mkFetch([7]);
    const v = await judgeScreenshots([shot], 'spec', '', f);
    expect(v?.score).toBe(7);
    expect((f as any).bodies.length).toBe(1);
    expect((f as any).bodies[0].temperature).toBe(0);
  });
});
