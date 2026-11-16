/**
 * Tier extractor v1 tests — deterministic visual feature vectors.
 *
 * Fixtures are synthetic PNGs encoded in-test (pure Node: deflate + CRC32) so
 * every assertion is exact and no binary fixture ships with the repo. The
 * same encoder guarantees the decoder path under test is the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateSync } from 'zlib';
import {
  extractTierVector, listAnchors, storeAnchor, TIER_EXTRACTOR_VERSION,
} from '../../src/quality/tier.js';
import { qualityCommand } from '../../src/cli/quality.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode an 8-bit RGB PNG (colour-type 2, no filters) from a pixel function. */
function encodePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-tier-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const writePng = (name: string, w: number, h: number, px: (x: number, y: number) => [number, number, number]): string => {
  const path = join(tmp, name);
  writeFileSync(path, encodePng(w, h, px));
  return path;
};

describe('extractTierVector: scalar axes', () => {
  it('flat mid-gray: zero structure, one color, exact means', () => {
    const p = writePng('gray.png', 16, 16, () => [128, 128, 128]);
    const v = extractTierVector(p);
    expect(v).not.toBeNull();
    expect(v?.valMean).toBeCloseTo(128 / 255, 4);
    expect(v?.satMean).toBe(0);
    expect(v?.contrast).toBe(0);
    expect(v?.edgeFrac).toBe(0);
    expect(v?.glowFrac).toBe(0);
    expect(v?.darkFrac).toBe(0);
    expect(v?.colors12).toBe(1);
    expect(v?.hueHist[0]).toBe(1);
    expect(v?.dominant).toEqual([{ hex: 0x808080, frac: 1 }]);
  });

  it('pure red: fully saturated glow, hue in bin 0', () => {
    const v = extractTierVector(writePng('red.png', 16, 16, () => [255, 0, 0]));
    expect(v?.satMean).toBe(1);
    expect(v?.valMean).toBe(1);
    expect(v?.glowFrac).toBe(1);
    expect(v?.darkFrac).toBe(0);
    expect(v?.dominant).toEqual([{ hex: 0xff0000, frac: 1 }]);
  });

  it('pure black: dark fraction 1; pure white: no glow without saturation', () => {
    const black = extractTierVector(writePng('black.png', 16, 16, () => [0, 0, 0]));
    expect(black?.darkFrac).toBe(1);
    expect(black?.valMean).toBe(0);
    const white = extractTierVector(writePng('white.png', 16, 16, () => [255, 255, 255]));
    expect(white?.glowFrac).toBe(0);
    expect(white?.valMean).toBe(1);
  });

  it('hard split: exactly one canonical edge column', () => {
    const v = extractTierVector(writePng('split.png', 64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255])));
    expect(v?.edgeFrac).toBeCloseTo(1 / 1200, 5);
    expect(v?.contrast).toBeGreaterThan(0.4);
    expect(v?.colors12).toBe(2);
  });

  it('smooth gradient: colors without edges (steps stay under the threshold)', () => {
    const v = extractTierVector(writePng('grad.png', 256, 16, (x) => [x, x, x]));
    expect(v?.colors12).toBe(16);
    expect(v?.edgeFrac).toBe(0);
    expect(v?.contrast).toBeGreaterThan(0.2);
  });

  it('checkerboard: structure density in a bounded band', () => {
    const v = extractTierVector(writePng('check.png', 64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(v ? v.edgeFrac : 0).toBeGreaterThan(0.02);
    expect(v ? v.edgeFrac : 1).toBeLessThan(0.1);
  });
});

describe('extractTierVector: determinism and resilience', () => {
  it('identical input yields identical vectors (JSON-stable)', () => {
    const p = writePng('noise.png', 96, 96, (x, y) => [(x * 7 + y * 13) % 256, (x * 3) % 256, (x + y) % 256]);
    expect(JSON.stringify(extractTierVector(p))).toBe(JSON.stringify(extractTierVector(p)));
  });

  it('resize invariance: a flat color measures identically at any input size', () => {
    const small = extractTierVector(writePng('r16.png', 16, 16, () => [255, 0, 0]));
    const big = extractTierVector(writePng('r320.png', 320, 200, () => [255, 0, 0]));
    expect(big?.dominant).toEqual(small?.dominant);
    expect(big?.valMean).toBe(small?.valMean);
    expect(big?.colors12).toBe(small?.colors12);
  });

  it('binds evidence to the file: sha256 matches, version is current', () => {
    const p = writePng('bind.png', 8, 8, () => [10, 20, 30]);
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    const v = extractTierVector(p);
    expect(v?.sha256).toBe(sha);
    expect(v?.extractorVersion).toBe(TIER_EXTRACTOR_VERSION);
    expect(v?.canonicalWidth).toBe(1200);
    expect(v?.canonicalHeight).toBe(750);
  });

  it('returns null for non-PNG bytes and missing files (fail-soft, never a fake vector)', () => {
    const bad = join(tmp, 'fake.png');
    writeFileSync(bad, 'not a png at all');
    expect(extractTierVector(bad)).toBeNull();
    expect(extractTierVector(join(tmp, 'absent.png'))).toBeNull();
  });
});

describe('anchor store', () => {
  it('stores a profile and an image copy, then lists it at the current version', () => {
    const p = writePng('hero.png', 16, 16, () => [255, 0, 0]);
    const rec = storeAnchor(tmp, 'visual-scene', p);
    expect(rec).not.toBeNull();
    expect(rec?.name).toBe('hero');
    const stored = JSON.parse(readFileSync(rec!.profilePath, 'utf8'));
    expect(stored.vector.extractorVersion).toBe(TIER_EXTRACTOR_VERSION);
    expect(stored.vector.sha256).toBe(rec?.vector.sha256);
    const anchors = listAnchors(tmp, 'visual-scene');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].vector.dominant).toEqual([{ hex: 0xff0000, frac: 1 }]);
  });

  it('sanitizes the class directory name', () => {
    const p = writePng('a.png', 8, 8, () => [0, 255, 0]);
    const rec = storeAnchor(tmp, 'visual scene!', p);
    expect(rec?.profilePath).toContain(join('.uap', 'quality', 'anchors', 'visual_scene_'));
  });

  it('skips malformed and version-mismatched profiles when listing (stale evidence fails closed)', () => {
    const a = storeAnchor(tmp, 'cls', writePng('a.png', 8, 8, () => [255, 0, 0]));
    storeAnchor(tmp, 'cls', writePng('b.png', 8, 8, () => [0, 0, 255]));
    writeFileSync(join(tmp, '.uap', 'quality', 'anchors', 'cls', 'broken.profile.json'), '{not json');
    const stale = a!.profilePath.replace('a.profile.json', 'stale.profile.json');
    writeFileSync(stale, JSON.stringify({ vector: { ...a!.vector, extractorVersion: 99 } }));
    const anchors = listAnchors(tmp, 'cls');
    expect(anchors).toHaveLength(2);
    expect(anchors.map((x) => x.path)).toEqual(anchors.map((x) => x.path).sort());
  });

  it('returns an empty list for an unknown class', () => {
    expect(listAnchors(tmp, 'nope')).toEqual([]);
  });
});

describe('qualityCommand: anchor + profile', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  it('profile --json prints the vector as machine-readable JSON', async () => {
    const p = writePng('cap.png', 16, 16, () => [255, 0, 0]);
    await qualityCommand('profile', { file: p, json: true });
    const parsed = JSON.parse(logs.join('\n')) as { glowFrac: number; sha256: string };
    expect(parsed.glowFrac).toBe(1);
    expect(parsed.sha256).toHaveLength(64);
  });

  it('profile rejects a non-PNG with exit code 2', async () => {
    const bad = join(tmp, 'bad.png');
    writeFileSync(bad, 'nope');
    await qualityCommand('profile', { file: bad });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('not a decodable PNG');
  });

  it('anchor <class> --file stores the anchor and reports the summary line', async () => {
    const p = writePng('ref.png', 16, 16, () => [255, 0, 0]);
    await qualityCommand('anchor', { projectDir: tmp, target: 'visual-scene', file: p });
    expect(logs.join('\n')).toContain('anchor visual-scene/ref');
    expect(listAnchors(tmp, 'visual-scene')).toHaveLength(1);
  });

  it('anchor without a class prints usage and fails', async () => {
    const p = writePng('ref.png', 8, 8, () => [0, 0, 0]);
    await qualityCommand('anchor', { projectDir: tmp, file: p });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('Usage: uap quality anchor <class>');
  });

  it('anchor with an undecodable file reports it and fails the run', async () => {
    const bad = join(tmp, 'broken.png');
    writeFileSync(bad, 'garbage');
    await qualityCommand('anchor', { projectDir: tmp, target: 'visual-scene', file: bad });
    expect(process.exitCode).toBe(2);
    expect(listAnchors(tmp, 'visual-scene')).toHaveLength(0);
  });
});
