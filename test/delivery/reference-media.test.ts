import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReferenceImages, imageDataUrl } from '../../src/delivery/reference-media.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('reference media extraction (U-B)', () => {
  it('collects sorted images from a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ref-'));
    writeFileSync(join(dir, 'b.png'), PNG);
    writeFileSync(join(dir, 'a.png'), PNG);
    writeFileSync(join(dir, 'notes.txt'), 'not an image');
    try {
      const r = await extractReferenceImages(dir, join(dir, 'frames'));
      expect(r.images.map((p) => p.split('/').pop())).toEqual(['a.png', 'b.png']);
      expect(r.note).toContain('2 reference image(s)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a single image file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ref-1-'));
    const img = join(dir, 'target.jpg');
    writeFileSync(img, PNG);
    try {
      const r = await extractReferenceImages(img, join(dir, 'frames'));
      expect(r.images).toEqual([img]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-softs on a missing path and an unsupported type', async () => {
    const r1 = await extractReferenceImages('/nonexistent/path', '/tmp/nowhere');
    expect(r1.images).toEqual([]);
    expect(r1.note).toContain('reference path not found');

    const dir = mkdtempSync(join(tmpdir(), 'uap-ref-2-'));
    const doc = join(dir, 'spec.docx');
    writeFileSync(doc, 'bytes');
    try {
      const r2 = await extractReferenceImages(doc, join(dir, 'frames'));
      expect(r2.images).toEqual([]);
      expect(r2.note).toContain('unsupported reference input');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('samples frames evenly from a reference video', async () => {
    if (!ffmpegAvailable()) {
      console.warn('ffmpeg unavailable — skipping video sampling test');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'uap-ref-vid-'));
    const video = join(dir, 'ref.mp4');
    // 2 seconds of test pattern — a real file, so duration + extraction are
    // exercised end to end (this is exactly what an operator-supplied
    // reference video goes through).
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5',
      '-pix_fmt', 'yuv420p', video,
    ]);
    try {
      const r = await extractReferenceImages(video, join(dir, 'frames'));
      expect(r.images.length).toBeGreaterThanOrEqual(2);
      expect(r.note).toContain('sampled evenly across');
      for (const img of r.images) expect(existsSync(img)).toBe(true);
      expect(readdirSync(join(dir, 'frames')).length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds mime-correct data URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ref-mime-'));
    const png = join(dir, 'x.png');
    const jpg = join(dir, 'y.jpg');
    writeFileSync(png, PNG);
    writeFileSync(jpg, PNG);
    try {
      expect(imageDataUrl(png).startsWith('data:image/png;base64,')).toBe(true);
      expect(imageDataUrl(jpg).startsWith('data:image/jpeg;base64,')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
