/**
 * Quality-tier extraction v1 — deterministic visual feature vectors.
 *
 * The tier layer (docs/plans/quality-tier-uplift-2026-11-16.md) digitizes the
 * bar: an anchor image and an output capture are measured into the SAME
 * feature vector, so tier distance is a number, not a vibe. Every axis is
 * defined once here and computed identically for both sides, and the vector
 * carries the extractor version so stale evidence fails closed when the
 * definition changes.
 *
 * Axes (canonical canvas 1200x750, area-averaged resize):
 *   satMean / valMean  mean HSV saturation / value over all pixels
 *   contrast          population std of luminance (0.299/0.587/0.114), 0..1
 *   edgeFrac          pixels whose max horizontal/vertical luminance step
 *                     exceeds 0.06 (structure density)
 *   glowFrac          pixels with V > 0.93 and S > 0.25 (emissive presence)
 *   darkFrac          pixels with V < 0.2 (crushed blacks)
 *   colors12          distinct colors after 4-bit-per-channel quantization
 *   hueHist           12 normalized bins over hue [0,360); achromatic pixels
 *                     count in bin 0 (parity with the 2026-11-16 analysis)
 *   dominant          k=8 deterministic k-means clusters, sorted by coverage
 *
 * Fail-soft: any read or decode failure returns null; callers report
 * "unmeasured" rather than passing by accident.
 */
import { createHash } from 'crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'fs';
import { basename, join } from 'path';
import { decodePng, DecodedImage } from '../delivery/visual-baseline.js';

export const TIER_EXTRACTOR_VERSION = 1;
export const CANONICAL_WIDTH = 1200;
export const CANONICAL_HEIGHT = 750;

const EDGE_STEP = 0.06;
const GLOW_VALUE = 0.93;
const GLOW_SAT = 0.25;
const DARK_VALUE = 0.2;
const KMEANS_K = 8;
const KMEANS_ITERS = 10;
const SAMPLE_TARGET = 20000;

export interface DominantColor {
  hex: number;
  frac: number;
}

export interface TierVector {
  extractorVersion: number;
  canonicalWidth: number;
  canonicalHeight: number;
  sha256: string;
  satMean: number;
  valMean: number;
  contrast: number;
  edgeFrac: number;
  glowFrac: number;
  darkFrac: number;
  colors12: number;
  hueHist: number[];
  dominant: DominantColor[];
}

export interface AnchorRecord {
  cls: string;
  name: string;
  profilePath: string;
  imagePath: string;
  vector: TierVector;
}

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Area-weighted average of the source rectangle covering one canonical pixel. */
function sampleRect(img: DecodedImage, x0: number, x1: number, y0: number, y1: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
    if (sy < 0 || sy >= img.height) continue;
    const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      if (sx < 0 || sx >= img.width) continue;
      const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
      const i = sy * img.stride + sx * img.channels;
      const wt = wx * wy;
      r += img.px[i] * wt;
      g += img.px[i + 1] * wt;
      b += img.px[i + 2] * wt;
      w += wt;
    }
  }
  if (w <= 0) return [0, 0, 0];
  return [r / w, g / w, b / w];
}

/** Resize (area average, deterministic) onto the canonical canvas, RGB uint8. */
function canonicalRgb(img: DecodedImage): Uint8Array {
  const out = new Uint8Array(CANONICAL_WIDTH * CANONICAL_HEIGHT * 3);
  const sx = img.width / CANONICAL_WIDTH;
  const sy = img.height / CANONICAL_HEIGHT;
  let p = 0;
  for (let y = 0; y < CANONICAL_HEIGHT; y++) {
    const y0 = y * sy;
    for (let x = 0; x < CANONICAL_WIDTH; x++) {
      const [r, g, b] = sampleRect(img, x * sx, (x + 1) * sx, y0, y0 + sy);
      out[p++] = Math.round(r);
      out[p++] = Math.round(g);
      out[p++] = Math.round(b);
    }
  }
  return out;
}

const lumaOf = (rgb: Uint8Array, i: number): number =>
  (0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]) / 255;

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function hsvOf(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * ((((g - b) / d) + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** Deterministic k-means: stride-sampled pixels, first-K-distinct seeds, no RNG. */
function dominantColors(rgb: Uint8Array, count: number): DominantColor[] {
  const stride = Math.max(1, Math.floor(count / SAMPLE_TARGET));
  const samples: number[][] = [];
  for (let i = 0; i < count; i += stride) samples.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  const cents: number[][] = [];
  const seen = new Set<number>();
  for (const [r, g, b] of samples) {
    if (cents.length >= KMEANS_K) break;
    const key = (r << 16) | (g << 8) | b;
    if (!seen.has(key)) {
      seen.add(key);
      cents.push([r, g, b]);
    }
  }
  if (cents.length === 0) return [];
  const k = cents.length;
  let assign = new Array<number>(samples.length).fill(0);
  for (let it = 0; it < KMEANS_ITERS; it++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    let moved = false;
    for (let si = 0; si < samples.length; si++) {
      const [r, g, b] = samples[si];
      let best = 0;
      let bestD = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const dr = r - cents[ci][0];
        const dg = g - cents[ci][1];
        const db = b - cents[ci][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = ci;
        }
      }
      if (assign[si] !== best) moved = true;
      assign[si] = best;
      sums[best][0] += r;
      sums[best][1] += g;
      sums[best][2] += b;
      sums[best][3] += 1;
    }
    for (let ci = 0; ci < k; ci++) {
      if (sums[ci][3] > 0) {
        cents[ci] = [sums[ci][0] / sums[ci][3], sums[ci][1] / sums[ci][3], sums[ci][2] / sums[ci][3]];
      }
    }
    if (!moved) break;
  }
  const counts = new Array<number>(k).fill(0);
  for (const a of assign) counts[a] += 1;
  const out: DominantColor[] = [];
  for (let ci = 0; ci < k; ci++) {
    if (counts[ci] === 0) continue;
    const r = Math.round(cents[ci][0]);
    const g = Math.round(cents[ci][1]);
    const b = Math.round(cents[ci][2]);
    out.push({ hex: (r << 16) | (g << 8) | b, frac: r5(counts[ci] / samples.length) });
  }
  out.sort((a, b) => (b.frac - a.frac) || (a.hex - b.hex));
  return out;
}

/** The six scalar axes + histograms over the canonical RGB canvas. */
function axes(rgb: Uint8Array): Pick<TierVector, 'satMean' | 'valMean' | 'contrast' | 'edgeFrac' | 'glowFrac' | 'darkFrac' | 'colors12' | 'hueHist' | 'dominant'> {
  const n = rgb.length / 3;
  const hues = new Array<number>(12).fill(0);
  const distinct = new Set<number>();
  let sat = 0;
  let val = 0;
  let glow = 0;
  let dark = 0;
  let lumSum = 0;
  let lumSqSum = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    distinct.add(((Math.round((r * 15) / 255) << 8) | (Math.round((g * 15) / 255) << 4)) | Math.round((b * 15) / 255));
    const { h, s, v } = hsvOf(r, g, b);
    hues[Math.min(11, Math.floor(h / 30))] += 1;
    sat += s;
    val += v;
    if (v > GLOW_VALUE && s > GLOW_SAT) glow += 1;
    if (v < DARK_VALUE) dark += 1;
    const l = lumaOf(rgb, i * 3);
    lumSum += l;
    lumSqSum += l * l;
  }
  const mean = lumSum / n;
  const variance = Math.max(0, lumSqSum / n - mean * mean);
  let edge = 0;
  for (let y = 0; y < CANONICAL_HEIGHT; y++) {
    for (let x = 0; x < CANONICAL_WIDTH; x++) {
      const i = (y * CANONICAL_WIDTH + x) * 3;
      const l = lumaOf(rgb, i);
      const dr = x + 1 < CANONICAL_WIDTH ? Math.abs(lumaOf(rgb, i + 3) - l) : 0;
      const dd = y + 1 < CANONICAL_HEIGHT ? Math.abs(lumaOf(rgb, i + CANONICAL_WIDTH * 3) - l) : 0;
      if (dr > EDGE_STEP || dd > EDGE_STEP) edge += 1;
    }
  }
  const hueTotal = hues.reduce((a, c) => a + c, 0) || 1;
  return {
    satMean: r5(sat / n),
    valMean: r5(val / n),
    contrast: r5(Math.sqrt(variance)),
    edgeFrac: r5(edge / n),
    glowFrac: r5(glow / n),
    darkFrac: r5(dark / n),
    colors12: distinct.size,
    hueHist: hues.map((c) => r5(c / hueTotal)),
    dominant: dominantColors(rgb, n),
  };
}

/** Measure one PNG into a tier vector. Null when the file is not a decodable PNG. */
export function extractTierVector(pngPath: string): TierVector | null {
  const img = decodePng(pngPath);
  if (!img) return null;
  const rgb = canonicalRgb(img);
  const sha256 = createHash('sha256').update(readFileSync(pngPath)).digest('hex');
  return {
    extractorVersion: TIER_EXTRACTOR_VERSION,
    canonicalWidth: CANONICAL_WIDTH,
    canonicalHeight: CANONICAL_HEIGHT,
    sha256,
    ...axes(rgb),
  };
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');

export function anchorDir(projectRoot: string, cls: string): string {
  return join(projectRoot, '.uap', 'quality', 'anchors', sanitize(cls));
}

/**
 * Measure a PNG and store it as a tier anchor: the profile JSON plus a copy of
 * the image under .uap/quality/anchors/<class>/ (project-local, gitignored —
 * references are for measuring only and never ship, per P39).
 */
export function storeAnchor(projectRoot: string, cls: string, pngPath: string): AnchorRecord | null {
  const vector = extractTierVector(pngPath);
  if (!vector) return null;
  const raw = basename(pngPath);
  const name = sanitize(raw.replace(/\.[A-Za-z0-9]+$/, '')) || 'anchor';
  const dir = anchorDir(projectRoot, cls);
  const imageDir = join(dir, 'images');
  mkdirSync(imageDir, { recursive: true });
  const imagePath = join(imageDir, raw);
  copyFileSync(pngPath, imagePath);
  const record: AnchorRecord = { cls, name, imagePath, vector, profilePath: join(dir, `${name}.profile.json`) };
  writeFileSync(record.profilePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export interface StoredAnchor {
  path: string;
  vector: TierVector;
}

/** Load the anchor profiles of a class at the CURRENT extractor version (older versions are skipped — stale evidence fails closed). */
export function listAnchors(projectRoot: string, cls: string): StoredAnchor[] {
  const dir = anchorDir(projectRoot, cls);
  if (!existsSync(dir)) return [];
  const out: StoredAnchor[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.profile.json')) continue;
    const path = join(dir, entry);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { vector?: TierVector };
      if (parsed.vector && parsed.vector.extractorVersion === TIER_EXTRACTOR_VERSION) {
        out.push({ path, vector: parsed.vector });
      }
    } catch {
      /* malformed profile — skip */
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
