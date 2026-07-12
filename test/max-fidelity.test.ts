/**
 * Maximum-fidelity mode + visual regression baselines.
 *  - resolveFidelity: env > config > default, with vision fallbacks.
 *  - visual-baseline: PNG decode → grid fingerprint → drift + approve/compare.
 *  - runVerify: acceptance judge BLOCKS under max (advisory under standard).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateSync } from 'zlib';
import { resolveFidelity } from '../src/delivery/fidelity.js';
import {
  pngToGrid,
  gridDrift,
  approveVisualBaseline,
  compareVisualBaseline,
} from '../src/delivery/visual-baseline.js';
import { runVerify } from '../src/cli/verify.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-fidelity-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Minimal solid-colour RGB PNG (colour-type 2, 8-bit) — what our decoder reads. */
function solidPng(path: string, w: number, h: number, rgb: [number, number, number]): void {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const chunk = (t: string, d: Buffer): Buffer =>
    Buffer.concat([u32(d.length), Buffer.from(t), d, Buffer.alloc(4)]); // CRC unchecked by decoder
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // colour-type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

describe('resolveFidelity', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.UAP_FIDELITY;
    delete process.env.UAP_VISION_ENDPOINT;
    delete process.env.UAP_VISION_MODEL;
    delete process.env.UAP_INFERENCE_ENDPOINT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to standard with no config or env', () => {
    const f = resolveFidelity(tmp());
    expect(f.mode).toBe('standard');
    expect(f.max).toBe(false);
    expect(f.source).toBe('default');
  });

  it('reads fidelity.mode = max from .uap.json', () => {
    const d = tmp();
    writeFileSync(join(d, '.uap.json'), JSON.stringify({ version: '1.0.0', project: { name: 't' }, fidelity: { mode: 'max' } }));
    const f = resolveFidelity(d);
    expect(f.max).toBe(true);
    expect(f.source).toBe('config');
  });

  it('UAP_FIDELITY env overrides config', () => {
    const d = tmp();
    writeFileSync(join(d, '.uap.json'), JSON.stringify({ version: '1.0.0', project: { name: 't' }, fidelity: { mode: 'max' } }));
    process.env.UAP_FIDELITY = 'standard';
    const f = resolveFidelity(d);
    expect(f.max).toBe(false);
    expect(f.source).toBe('env');
  });

  it('falls back to the inference endpoint for vision when unset', () => {
    process.env.UAP_INFERENCE_ENDPOINT = 'http://127.0.0.1:8080/v1';
    const f = resolveFidelity(tmp());
    expect(f.visionEndpoint).toBe('http://127.0.0.1:8080/v1');
    expect(f.visionModel).toBe('local');
  });
});

describe('visual-baseline', () => {
  it('decodes a solid PNG into a uniform grid', () => {
    const d = tmp();
    const p = join(d, 'red.png');
    solidPng(p, 48, 48, [200, 20, 20]);
    const grid = pngToGrid(p, 8);
    expect(grid).not.toBeNull();
    expect(grid!.length).toBe(64);
    expect(grid![0]).toEqual([200, 20, 20]);
  });

  it('gridDrift is ~0 for identical and ~1 for opposite colours', () => {
    const d = tmp();
    solidPng(join(d, 'a.png'), 32, 32, [200, 20, 20]);
    solidPng(join(d, 'b.png'), 32, 32, [202, 18, 22]);
    solidPng(join(d, 'c.png'), 32, 32, [20, 40, 200]);
    const a = pngToGrid(join(d, 'a.png'))!;
    const b = pngToGrid(join(d, 'b.png'))!;
    const c = pngToGrid(join(d, 'c.png'))!;
    expect(gridDrift(a, b)).toBeLessThan(0.05);
    expect(gridDrift(a, c)).toBeGreaterThan(0.9);
  });

  it('approve then compare reports no drift; a changed render drifts', () => {
    const d = tmp();
    const vdir = join(d, '.uap', 'visual');
    mkdirSync(vdir, { recursive: true });
    solidPng(join(vdir, 'index-t0.png'), 40, 40, [200, 20, 20]);
    solidPng(join(vdir, 'index-t1.png'), 40, 40, [200, 20, 20]); // latest wins

    const approved = approveVisualBaseline(d);
    expect(approved.length).toBe(1);

    // Same look → within tolerance.
    let drifts = compareVisualBaseline(d);
    expect(drifts.find((x) => x.name === 'index.png')?.hasBaseline).toBe(true);
    expect(drifts.some((x) => x.drifted)).toBe(false);

    // Repaint the latest screenshot a totally different colour → drift.
    solidPng(join(vdir, 'index-t1.png'), 40, 40, [20, 40, 200]);
    drifts = compareVisualBaseline(d);
    expect(drifts.some((x) => x.drifted)).toBe(true);
  });
});

describe('runVerify under max fidelity', () => {
  function fakeFidelity(max: boolean) {
    return {
      mode: max ? ('max' as const) : ('standard' as const),
      max,
      visionMinScore: 6,
      visualBaselines: true,
      source: 'config' as const,
    };
  }

  it('acceptance failure is advisory under standard, blocking under max', async () => {
    const d = tmp();
    // The judge needs source evidence before it calls the executor.
    writeFileSync(join(d, 'index.js'), 'export function run() { return 1; }\n');
    // Stub judge verdict: one criterion unmet → passed:false (metCount !== length).
    const executor = async () =>
      JSON.stringify({
        criteria: [
          { requirement: 'renders the board', met: true },
          { requirement: 'spawns enemies', met: false, reason: 'never called' },
        ],
      });

    const std = await runVerify({
      dir: d,
      visual: false,
      fidelity: fakeFidelity(false),
      acceptanceSpec: 'Build a thing',
      acceptanceExecutor: executor,
    });
    // Standard, no --strict: a failing acceptance judgment does not block.
    expect(std.acceptance?.passed).toBe(false);
    expect(std.passed).toBe(true);

    const max = await runVerify({
      dir: d,
      visual: false,
      fidelity: fakeFidelity(true),
      acceptanceSpec: 'Build a thing',
      acceptanceExecutor: executor,
    });
    // Max: the acceptance judge is required — a failing verdict blocks.
    expect(max.acceptance?.passed).toBe(false);
    expect(max.passed).toBe(false);
    expect(max.exitCode).toBe(1);
  });
});
