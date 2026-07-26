import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFidelity } from '../src/delivery/fidelity.js';
import { corroborateFindings } from '../src/delivery/vision-judge.js';

const project = (fidelity: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'uap-vision-'));
  // The loader validates the WHOLE config: a bare { fidelity } fails schema
  // validation and yields undefined, which would make every assertion here
  // pass against defaults rather than against the setting under test.
  writeFileSync(
    join(dir, '.uap.json'),
    JSON.stringify({ version: '1.0.0', project: { name: 'fixture' }, fidelity })
  );
  return dir;
};

describe('vision blocking policy', () => {
  it('is advisory by default, even at max fidelity', () => {
    // The judge was measured scoring a correct render 4/10 with three findings
    // that were all false against the frame it graded. It reviews; it does not
    // gate, unless a project opts back in.
    const f = resolveFidelity(project({ mode: 'max' }));
    expect(f.max).toBe(true);
    expect(f.visionBlocking).toBe('advisory');
  });

  it('can be opted back into blocking via config', () => {
    const f = resolveFidelity(project({ mode: 'max', visionBlocking: 'block' }));
    expect(f.visionBlocking).toBe('block');
  });

  it('honours the env override in both directions', () => {
    const dir = project({ mode: 'max', visionBlocking: 'block' });
    process.env.UAP_VISION_BLOCKING = 'advisory';
    try {
      expect(resolveFidelity(dir).visionBlocking).toBe('advisory');
      process.env.UAP_VISION_BLOCKING = 'block';
      expect(resolveFidelity(project({ mode: 'max' })).visionBlocking).toBe('block');
    } finally {
      delete process.env.UAP_VISION_BLOCKING;
    }
  });
});

describe('vision finding corroboration', () => {
  it('passes findings through untouched when no vision model is configured', async () => {
    const endpoint = process.env.UAP_VISION_ENDPOINT;
    const model = process.env.UAP_VISION_MODEL;
    delete process.env.UAP_VISION_ENDPOINT;
    delete process.env.UAP_VISION_MODEL;
    try {
      const r = await corroborateFindings(['some finding'], ['/nonexistent.png']);
      expect(r.kept).toEqual(['some finding']);
      expect(r.dropped).toEqual([]);
    } finally {
      if (endpoint) process.env.UAP_VISION_ENDPOINT = endpoint;
      if (model) process.env.UAP_VISION_MODEL = model;
    }
  });

  it('drops a finding the model cannot point to, and keeps one it can', async () => {
    process.env.UAP_VISION_ENDPOINT = 'http://vision.invalid/v1';
    process.env.UAP_VISION_MODEL = 'test';
    const shot = join(mkdtempSync(join(tmpdir(), 'uap-shot-')), 'a.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const replies = [
      '{"visible": false, "where": ""}',
      '{"visible": true, "where": "the bottom centre of the frame"}',
    ];
    let i = 0;
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: replies[i++] } }] }),
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      const r = await corroborateFindings(
        ['a background with no stars', 'a health bar at the bottom'],
        [shot],
        fakeFetch as never
      );
      expect(r.dropped).toEqual(['a background with no stars']);
      expect(r.kept).toHaveLength(1);
      expect(r.kept[0]).toContain('seen: the bottom centre of the frame');
    } finally {
      delete process.env.UAP_VISION_ENDPOINT;
      delete process.env.UAP_VISION_MODEL;
    }
  });

  it('withholds a finding when the check itself fails, rather than asserting it', async () => {
    process.env.UAP_VISION_ENDPOINT = 'http://vision.invalid/v1';
    process.env.UAP_VISION_MODEL = 'test';
    const shot = join(mkdtempSync(join(tmpdir(), 'uap-shot-')), 'a.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const failing = (async () => ({ ok: false }) as unknown as Response) as unknown as typeof fetch;
    try {
      const r = await corroborateFindings(['unverifiable claim'], [shot], failing as never);
      expect(r.kept).toEqual([]);
      expect(r.dropped).toEqual(['unverifiable claim']);
    } finally {
      delete process.env.UAP_VISION_ENDPOINT;
      delete process.env.UAP_VISION_MODEL;
    }
  });
});
