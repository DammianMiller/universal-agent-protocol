/**
 * The visual gate must measure what was actually PAINTED — not what an in-page
 * canvas probe can reach.
 *
 * The probe calls `canvas.getContext('2d')`. A canvas can own only ONE context
 * type, so on a WebGL canvas (Three.js, Babylon, PixiJS-WebGL, raw WebGL) that
 * returns null and the probe reads nothing. Every such app therefore measured as
 * "0 distinct colors / 100% dominant / 0% motion" and FALSELY failed as a blank
 * render — while the very screenshots the gate saves showed the app rendering
 * perfectly (the vision reviewer, reading those same PNGs, scored one 6/10 and
 * described its lighting and stickers).
 *
 * The model was then told to fix a blank canvas that did not exist, and rebuilt a
 * working renderer over and over. Real numbers from the live Rubik's-cube run:
 *
 *              canvas probe      screenshot (truth)     threshold
 *   colors           0                  23                 >= 3
 *   dominant       1.000               0.851               <= 0.98
 *   motion         0.000               0.090               >= 0.02
 *
 * It was passing every threshold all along.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PNG } from 'pngjs';
import { sampleScreenshot, judgePage, motionBetween, type PageVisualReport } from '../../src/delivery/visual-gate.js';

/** Write a PNG whose pixels are produced by `color(x, y)` — a stand-in for whatever
 * the compositor painted (WebGL included; the encoder does not care). */
function writePng(path: string, w: number, h: number, color: (x: number, y: number) => [number, number, number]): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = color(x, y);
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe('sampleScreenshot — measures the painted output, whatever rendered it', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-vis-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sees a rich render that the WebGL-blind canvas probe reports as blank', () => {
    // A colourful scene — exactly what a Three.js canvas paints and the probe cannot read.
    const p = join(dir, 'scene.png');
    writePng(p, 240, 240, (x, y) => [(x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256]);
    const s = sampleScreenshot(p)!;
    expect(s.distinctColors).toBeGreaterThan(3);   // probe said 0
    expect(s.dominantRatio).toBeLessThan(0.98);    // probe said 1.0
  });

  it('still calls a genuinely blank page blank (no false PASS)', () => {
    const p = join(dir, 'blank.png');
    writePng(p, 240, 240, () => [0, 0, 0]);
    const s = sampleScreenshot(p)!;
    expect(s.distinctColors).toBe(1);
    expect(s.dominantRatio).toBe(1);
    // …and the verdict still fails it.
    const problems = judgePage({
      file: 'i.html', loaded: true, hasCanvas: true,
      distinctColors: s.distinctColors, dominantRatio: s.dominantRatio,
      motionRatio: 0, expectsAnimation: true, runtimeErrors: [], failedRequests: [], screenshots: [],
    } as Omit<PageVisualReport, 'problems'>);
    expect(problems.join(' ')).toMatch(/visual floor|distinct colors/i);
  });

  it('detects real motion between frames (an animating WebGL scene)', () => {
    const a = join(dir, 't0.png'); const b = join(dir, 't1.png');
    writePng(a, 240, 240, (x, y) => [(x * 7) % 256, (y * 5) % 256, 0]);
    writePng(b, 240, 240, (x, y) => [(x * 7 + 90) % 256, (y * 5 + 60) % 256, 0]); // the scene moved
    const m = motionBetween(sampleScreenshot(a)!.cells, sampleScreenshot(b)!.cells);
    expect(m).toBeGreaterThan(0.02); // the rAF floor the probe could never clear
  });

  it('reports NO motion for a truly static scene', () => {
    const a = join(dir, 's0.png'); const b = join(dir, 's1.png');
    const same = (x: number, y: number): [number, number, number] => [(x * 7) % 256, (y * 5) % 256, 0];
    writePng(a, 240, 240, same); writePng(b, 240, 240, same);
    expect(motionBetween(sampleScreenshot(a)!.cells, sampleScreenshot(b)!.cells)).toBe(0);
  });

  it('returns null on an undecodable file so the caller falls back to the probe', () => {
    const p = join(dir, 'not-a.png');
    writeFileSync(p, 'definitely not a png');
    expect(sampleScreenshot(p)).toBeNull();
  });
});
