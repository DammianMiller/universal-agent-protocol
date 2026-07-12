/**
 * Visual regression baselines — pin an accepted UI's rendered appearance and
 * fail later runs that drift from it.
 *
 * The visual gate saves per-page screenshots under `.uap/visual/`. Approving a
 * baseline copies each page's latest screenshot to `.uap/visual/baseline/`.
 * Subsequent runs decode both PNGs into a coarse average-colour grid
 * (dependency-free — Node `zlib` only) and report the fraction of grid cells
 * whose colour moved beyond a per-cell tolerance. Under max fidelity with
 * baselines enabled, drift past the threshold blocks like a broken gate.
 *
 * The decoder supports the format Playwright/Chromium emits: 8-bit,
 * non-interlaced, colour-type 2 (RGB) or 6 (RGBA). Anything else fingerprints
 * to null and is treated as "no comparable baseline" (fail-soft, never throws).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'fs';
import { basename, join } from 'path';
import { inflateSync } from 'zlib';

/** Coarse grid resolution for the fingerprint (N×N average-colour cells). */
const GRID = 32;
/** Per-cell colour distance (0–255 per channel, summed) above which a cell "changed". */
const CELL_TOLERANCE = 60;
/** Fraction of changed cells above which a page has drifted. */
export const DEFAULT_DRIFT_THRESHOLD = 0.12;

export interface PageDrift {
  /** Baseline PNG basename (page identity). */
  name: string;
  /** True when a baseline existed to compare against. */
  hasBaseline: boolean;
  /** Fraction of grid cells that changed (0–1); 0 when no baseline. */
  drift: number;
  /** True when drift exceeded the threshold. */
  drifted: boolean;
}

function baselineDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'visual', 'baseline');
}
function visualDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'visual');
}

/**
 * Decode a PNG into an N×N grid of average [r,g,b]. Returns null for any format
 * we do not handle (never throws). Pure Node (`zlib.inflateSync`).
 */
export function pngToGrid(path: string, n = GRID): number[][] | null {
  try {
    const buf = readFileSync(path);
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG magic
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat: Buffer[] = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') {
        break;
      }
      off = dataStart + len + 4; // skip data + CRC
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) return null;

    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;

    // Un-filter scanlines in place into an RGB(A) buffer.
    const px = Buffer.alloc(stride * height);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rp++];
      const rowStart = y * stride;
      for (let x = 0; x < stride; x++) {
        const rawByte = raw[rp++];
        const a = x >= channels ? px[rowStart + x - channels] : 0; // left
        const b = y > 0 ? px[rowStart - stride + x] : 0; // up
        const c = x >= channels && y > 0 ? px[rowStart - stride + x - channels] : 0; // up-left
        let val = rawByte;
        if (filter === 1) val = rawByte + a;
        else if (filter === 2) val = rawByte + b;
        else if (filter === 3) val = rawByte + ((a + b) >> 1);
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        px[rowStart + x] = val & 0xff;
      }
    }

    // Downsample to an N×N average-colour grid.
    const grid: number[][] = [];
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const x0 = Math.floor((gx * width) / n);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / n));
        const y0 = Math.floor((gy * height) / n);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / n));
        let r = 0;
        let g = 0;
        let bl = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = y * stride + x * channels;
            r += px[i];
            g += px[i + 1];
            bl += px[i + 2];
            count++;
          }
        }
        count = count || 1;
        grid.push([Math.round(r / count), Math.round(g / count), Math.round(bl / count)]);
      }
    }
    return grid;
  } catch {
    return null;
  }
}

/** Fraction of grid cells whose colour distance exceeds the tolerance (0–1). */
export function gridDrift(a: number[][], b: number[][]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i][0] - b[i][0]) + Math.abs(a[i][1] - b[i][1]) + Math.abs(a[i][2] - b[i][2]);
    if (d > CELL_TOLERANCE) changed++;
  }
  return changed / n;
}

/** The latest screenshot per page (max one per `<page>` prefix) in `.uap/visual/`. */
export function latestScreenshots(projectRoot: string): string[] {
  const dir = visualDir(projectRoot);
  if (!existsSync(dir)) return [];
  const shots = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  // Names look like `<page>-t<i>.png`; keep the highest t per page.
  const byPage = new Map<string, string>();
  for (const f of shots.sort()) {
    const page = f.replace(/-t\d+\.png$/i, '');
    byPage.set(page, f); // later (higher t) wins due to sort
  }
  return [...byPage.values()].map((f) => join(dir, f));
}

/** Copy each page's latest screenshot into the baseline dir (accept the look). */
export function approveVisualBaseline(projectRoot: string): string[] {
  const dir = baselineDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const approved: string[] = [];
  for (const shot of latestScreenshots(projectRoot)) {
    // Normalise `<page>-t<i>.png` → `<page>.png` so the baseline is stable across runs.
    const name = basename(shot).replace(/-t\d+\.png$/i, '.png');
    const dest = join(dir, name);
    try {
      copyFileSync(shot, dest);
      approved.push(dest);
    } catch {
      // best-effort per file
    }
  }
  return approved;
}

/**
 * Compare the current run's latest screenshots against approved baselines.
 * Returns one entry per current page. Fail-soft: undecodable pairs report
 * hasBaseline=false so they never spuriously block.
 */
export function compareVisualBaseline(
  projectRoot: string,
  threshold = DEFAULT_DRIFT_THRESHOLD
): PageDrift[] {
  const bDir = baselineDir(projectRoot);
  const out: PageDrift[] = [];
  for (const shot of latestScreenshots(projectRoot)) {
    const name = basename(shot).replace(/-t\d+\.png$/i, '.png');
    const basePath = join(bDir, name);
    if (!existsSync(basePath)) {
      out.push({ name, hasBaseline: false, drift: 0, drifted: false });
      continue;
    }
    const cur = pngToGrid(shot);
    const base = pngToGrid(basePath);
    if (!cur || !base) {
      out.push({ name, hasBaseline: false, drift: 0, drifted: false });
      continue;
    }
    const drift = gridDrift(cur, base);
    out.push({ name, hasBaseline: true, drift, drifted: drift > threshold });
  }
  return out;
}

/** Human-readable one-liner for a set of drifts (empty string when nothing to say). */
export function driftSummary(drifts: PageDrift[]): string {
  const compared = drifts.filter((d) => d.hasBaseline);
  if (compared.length === 0) return '';
  const drifted = compared.filter((d) => d.drifted);
  if (drifted.length === 0) {
    return `visual baseline: ${compared.length} page(s) within tolerance`;
  }
  return (
    `VISUAL REGRESSION — ${drifted.length}/${compared.length} page(s) drifted from baseline:\n` +
    drifted.map((d) => `  - ${d.name}: ${(d.drift * 100).toFixed(1)}% of cells changed`).join('\n') +
    '\n  (approve the new look with `uap verify --approve-visual` if intended)'
  );
}
