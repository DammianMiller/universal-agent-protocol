/**
 * Visual Gate — verify that a delivered web artifact actually LOOKS like a
 * working application and BEHAVES over time, not merely that it loads.
 *
 * The execution gate proves crash-free load; the acceptance judge reads code
 * evidence. Both were fooled by real deliveries (a game whose enemy waves
 * were never started; scenes whose "physics" could have been a static frame).
 * This gate closes that class:
 *
 *  1. Loads every root-level entry .html in a headless browser.
 *  2. Samples the canvas/DOM pixels IN-PAGE on a grid at several instants:
 *     - blank detection (dominant-color ratio, distinct-color count)
 *     - animation detection (grid cells changing between samples — required
 *       whenever the page source uses requestAnimationFrame)
 *     - uncaught runtime errors across the whole observation window
 *  3. Saves timestamped screenshots to `.uap/visual/` so a vision-capable
 *     reviewer (human, Claude session, or a configured vision model) can apply
 *     design and aesthetic judgment to the real rendered output.
 *
 * The verdict is objective and machine-checked; the screenshots are the
 * hand-off point for aesthetic review (see the visual-verification policy).
 * Fail-open ONLY when no browser is available (vm-DOM cannot render pixels);
 * everything observed is reported either way.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { startStaticServer } from './execution-gate.js';

/** Browser surface the gate needs (satisfied by src/browser WebBrowser). */
export interface VisualBrowserDriver {
  launch(opts?: Record<string, unknown>): Promise<unknown>;
  goto(url: string): Promise<string>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  screenshot(path: string): Promise<void>;
  getErrors(): Array<{ kind: string; message: string }>;
  close(): Promise<void>;
}

export interface VisualGateOptions {
  /** Entry html files relative to projectRoot (default: root-level *.html, index first, max 6). */
  files?: string[];
  /** Pixel samples per page (default 3). */
  samples?: number;
  /** Interval between samples in ms (default 900). */
  intervalMs?: number;
  /** Per-page hard budget in ms (default 30000). */
  timeoutMs?: number;
  /** Injected browser (tests). Default: the real WebBrowser (cloakbrowser). */
  browserFactory?: () => VisualBrowserDriver;
}

export interface PageVisualReport {
  file: string;
  loaded: boolean;
  hasCanvas: boolean;
  /** Grid stats from the last sample. */
  distinctColors: number;
  dominantRatio: number;
  /** Fraction of grid cells that changed between first and last sample. */
  motionRatio: number;
  /** Whether the page source demands animation (requestAnimationFrame). */
  expectsAnimation: boolean;
  runtimeErrors: string[];
  screenshots: string[];
  /** Failures for THIS page (empty = visually sound). */
  problems: string[];
}

export interface VisualVerdict {
  /** False when any page has objective visual/behavioral problems. */
  passed: boolean;
  /** True when the gate could not run (no browser) — advisory pass. */
  skipped: boolean;
  feedback: string;
  pages: PageVisualReport[];
  screenshotDir: string | null;
}

/**
 * Project-declared visual targets (P8): `.uap/visual-targets.json` raises the
 * gate's thresholds so aesthetic requirements become in-loop convergence
 * pressure instead of a post-hoc opinion. All fields optional; per-page
 * overrides win over file-level values, which win over the built-in floors.
 * Shape: { minDistinctColors, maxDominantRatio, minMotionRatio,
 *          pages: { "<file>.html": { ...same fields } } }
 */
export interface VisualTargets {
  minDistinctColors?: number;
  maxDominantRatio?: number;
  minMotionRatio?: number;
  pages?: Record<string, { minDistinctColors?: number; maxDominantRatio?: number; minMotionRatio?: number }>;
}

export function readVisualTargets(projectRoot: string): VisualTargets {
  try {
    const path = join(projectRoot, '.uap', 'visual-targets.json');
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as VisualTargets;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const GRID = 24;
const DEFAULT_SAMPLES = 3;
const DEFAULT_INTERVAL_MS = 900;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 6;
/** A canvas showing fewer distinct colors than this is a blank/failed render. */
const MIN_DISTINCT_COLORS = 3;
/** One color covering more of the grid than this is a blank-ish frame. */
const MAX_DOMINANT_RATIO = 0.98;
/** rAF pages must move at least this fraction of grid cells across samples. */
const MIN_MOTION_RATIO = 0.02;

/** In-page probe: sample the largest canvas on a GRID×GRID grid. Returns JSON.
 * NOTE: a function EXPRESSION (not self-invoked) — WebBrowser.evaluate wraps
 * string scripts as `return (<script>)()`, supplying the invocation itself. */
const PIXEL_PROBE = `(function () {
  var canvases = Array.prototype.slice.call(document.querySelectorAll('canvas'));
  if (canvases.length === 0) return JSON.stringify({ canvas: false });
  canvases.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
  var c = canvases[0];
  var ctx = c.getContext('2d');
  if (!ctx || !c.width || !c.height) return JSON.stringify({ canvas: true, readable: false });
  var img;
  try { img = ctx.getImageData(0, 0, c.width, c.height).data; }
  catch (e) { return JSON.stringify({ canvas: true, readable: false }); }
  var N = ${GRID}, colors = {}, cells = [];
  for (var gy = 0; gy < N; gy++) {
    for (var gx = 0; gx < N; gx++) {
      var x = Math.floor((gx + 0.5) * c.width / N);
      var y = Math.floor((gy + 0.5) * c.height / N);
      var i = (y * c.width + x) * 4;
      var key = (img[i] >> 4) + ',' + (img[i + 1] >> 4) + ',' + (img[i + 2] >> 4);
      colors[key] = (colors[key] || 0) + 1;
      cells.push(key);
    }
  }
  var dominant = 0;
  for (var k in colors) if (colors[k] > dominant) dominant = colors[k];
  return JSON.stringify({
    canvas: true, readable: true, cells: cells,
    distinctColors: Object.keys(colors).length,
    dominantRatio: dominant / cells.length,
  });
})`;

interface ProbeResult {
  canvas: boolean;
  readable?: boolean;
  cells?: string[];
  distinctColors?: number;
  dominantRatio?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Common build-output dirs a framework project renders into (served from root). */
const BUILD_OUTPUT_DIRS = ['dist', 'build', 'out'];

/**
 * Entry pages to render. Root-level `.html` first (index first); if the project
 * has none — the shape of a React/Vue/Svelte app that only produces HTML after a
 * build — fall back to the built `index.html` under dist/build/out so framework
 * UIs are covered, not silently skipped. The static server serves projectRoot,
 * so a nested entry like `dist/index.html` navigates fine.
 */
// Directories that never hold a project's own entry page — skip when recursing.
const ENTRY_SCAN_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'agents', 'vendor',
  'target', '__pycache__', '.next', '.nuxt', '.svelte-kit', '.cache', 'tmp',
]);

export function discoverEntryPages(projectRoot: string): string[] {
  try {
    const root = readdirSync(projectRoot).filter((f) => f.toLowerCase().endsWith('.html'));
    if (root.length > 0) {
      root.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
      return root.slice(0, MAX_PAGES);
    }
    // Framework fallback: a freshly built entry under a common output dir.
    for (const d of BUILD_OUTPUT_DIRS) {
      const entry = join(d, 'index.html');
      if (existsSync(join(projectRoot, entry))) return [entry];
    }
    // Subproject fallback: the app often lives in a subdirectory (e.g.
    // `rubiks-cube/index.html`) with no root package.json — so a root-level
    // verify would find NO entry page and skip visual/behavioral validation
    // entirely, letting a broken app pass as "done". Recurse (bounded depth) to
    // find nested entry pages; the static server serves projectRoot so a
    // relative `rubiks-cube/index.html` navigates correctly. Prefer index.html,
    // at most one page per subtree, capped at MAX_PAGES.
    const found: string[] = [];
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 3 || found.length >= MAX_PAGES) return;
      // Prefer this directory's own index.html, then any .html, before descending.
      if (rel && existsSync(join(dir, 'index.html'))) {
        found.push(`${rel}/index.html`);
        return; // one entry per subtree
      }
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      if (rel) {
        const anyHtml = names.find((n) => n.toLowerCase().endsWith('.html'));
        if (anyHtml) { found.push(`${rel}/${anyHtml}`); return; }
      }
      for (const name of names) {
        if (found.length >= MAX_PAGES) break;
        if (name.startsWith('.') || ENTRY_SCAN_SKIP.has(name)) continue;
        const abs = join(dir, name);
        try {
          if (statSync(abs).isDirectory()) walk(abs, rel ? `${rel}/${name}` : name, depth + 1);
        } catch { /* transient */ }
      }
    };
    walk(projectRoot, '', 0);
    return found.slice(0, MAX_PAGES);
  } catch {
    return [];
  }
}

async function loadRealBrowser(): Promise<VisualBrowserDriver> {
  const mod = await import('../browser/web-browser.js');
  return new mod.WebBrowser() as unknown as VisualBrowserDriver;
}

/** Fraction of grid cells that differ between two samples. */
export function motionBetween(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return changed / a.length;
}

/** Pure verdict for one page from its observations — unit-testable. Optional
 * thresholds (project visual targets) tighten the built-in floors. */
export function judgePage(
  report: Omit<PageVisualReport, 'problems'>,
  targets: { minDistinctColors?: number; maxDominantRatio?: number; minMotionRatio?: number } = {}
): string[] {
  const minColors = Math.max(MIN_DISTINCT_COLORS, targets.minDistinctColors ?? 0);
  const maxDominant = Math.min(MAX_DOMINANT_RATIO, targets.maxDominantRatio ?? 1);
  const minMotion = Math.max(MIN_MOTION_RATIO, targets.minMotionRatio ?? 0);
  const problems: string[] = [];
  if (!report.loaded) {
    problems.push('page did not load');
    return problems;
  }
  if (report.runtimeErrors.length > 0) {
    problems.push(`uncaught runtime error(s) during observation: ${report.runtimeErrors[0].slice(0, 200)}`);
  }
  if (report.hasCanvas) {
    if (report.distinctColors < minColors || report.dominantRatio > maxDominant) {
      problems.push(
        `canvas renders below the visual floor (${report.distinctColors} distinct colors < ${minColors} required, dominant color covers ${Math.round(report.dominantRatio * 100)}%)`
      );
    }
    if (report.expectsAnimation && report.motionRatio < minMotion) {
      problems.push(
        `page uses requestAnimationFrame but motion is ${(report.motionRatio * 100).toFixed(1)}% (< ${(minMotion * 100).toFixed(1)}% required) — the scene is not animating enough`
      );
    }
  } else if (report.expectsAnimation) {
    problems.push('page source expects a canvas animation but no canvas was found in the DOM');
  }
  return problems;
}

/**
 * Run the visual gate over the project's entry pages. Fail-open (skipped=true)
 * only when no browser can launch.
 */
export async function runVisualGate(
  projectRoot: string,
  options: VisualGateOptions = {}
): Promise<VisualVerdict> {
  const files = options.files ?? discoverEntryPages(projectRoot);
  if (files.length === 0) {
    return { passed: true, skipped: true, feedback: 'visual gate: no entry .html pages found', pages: [], screenshotDir: null };
  }
  const samples = Math.max(2, options.samples ?? DEFAULT_SAMPLES);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const visualTargets = readVisualTargets(projectRoot);
  const screenshotDir = join(projectRoot, '.uap', 'visual');
  try {
    mkdirSync(screenshotDir, { recursive: true });
  } catch {
    // screenshots become best-effort
  }

  let server: { url: string; close: () => void } | null = null;
  const pages: PageVisualReport[] = [];
  try {
    server = await startStaticServer(projectRoot);

    for (const file of files) {
      let browser: VisualBrowserDriver | null = null;
      try {
        browser = options.browserFactory ? options.browserFactory() : await loadRealBrowser();
        await browser.launch({ headless: true });
      } catch (e) {
        try {
          await browser?.close();
        } catch {
          /* ignore */
        }
        return {
          passed: true,
          skipped: true,
          feedback: `visual gate skipped: browser unavailable (${String(e).slice(0, 120)})`,
          pages,
          screenshotDir: null,
        };
      }

      const start = Date.now();
      const src = safeRead(join(projectRoot, file));
      const expectsAnimation = /requestAnimationFrame/.test(src);
      const shots: string[] = [];
      let loaded = false;
      let probes: ProbeResult[] = [];
      try {
        // startStaticServer's url includes its own entry path (/index.html);
        // navigate per page from the ORIGIN.
        const origin = new URL(server.url).origin;
        const status = await Promise.race([
          browser.goto(`${origin}/${file}`),
          delay(timeoutMs).then(() => 'timeout'),
        ]);
        loaded = /^2\d\d$/.test(String(status)) || String(status) === '304';
        await Promise.race([browser.waitForLoadState('load'), delay(5000)]).catch(() => undefined);

        if (loaded) {
          for (let i = 0; i < samples && Date.now() - start < timeoutMs; i++) {
            if (i > 0) await delay(intervalMs);
            try {
              const raw = await browser.evaluate<string>(PIXEL_PROBE);
              probes.push(JSON.parse(raw) as ProbeResult);
            } catch {
              probes.push({ canvas: false });
            }
            // Flatten nested entry paths (dist/index.html) into a single
            // screenshot-safe basename so no missing subdir defeats the write.
            const shotBase = file.replace(/\.html$/i, '').replace(/[/\\]+/g, '_');
            const shot = join(screenshotDir, `${shotBase}-t${i}.png`);
            try {
              await browser.screenshot(shot);
              shots.push(shot);
            } catch {
              // screenshots are best-effort evidence
            }
          }
        }
      } catch (e) {
        probes = [];
        loaded = false;
      }
      const errors = browser
        .getErrors()
        .filter((e) => e.kind === 'pageerror')
        .map((e) => e.message);
      await browser.close().catch(() => undefined);

      const last = probes[probes.length - 1] ?? { canvas: false };
      const first = probes.find((p) => p.readable);
      const base: Omit<PageVisualReport, 'problems'> = {
        file,
        loaded,
        hasCanvas: Boolean(last.canvas),
        distinctColors: last.distinctColors ?? 0,
        dominantRatio: last.dominantRatio ?? 1,
        motionRatio: motionBetween(first?.cells, last.cells),
        expectsAnimation,
        runtimeErrors: errors,
        screenshots: shots,
      };
      const pageTargets = { ...visualTargets, ...(visualTargets.pages?.[file] ?? {}) };
      pages.push({ ...base, problems: judgePage(base, pageTargets) });
    }
  } catch (e) {
    return {
      passed: true,
      skipped: true,
      feedback: `visual gate skipped: ${String(e).slice(0, 160)}`,
      pages,
      screenshotDir: null,
    };
  } finally {
    server?.close();
  }

  const failing = pages.filter((p) => p.problems.length > 0);
  const passed = failing.length === 0;
  const lines: string[] = [];
  for (const p of pages) {
    const stat = p.problems.length === 0
      ? `OK (motion ${(p.motionRatio * 100).toFixed(1)}%, ${p.distinctColors} colors)`
      : p.problems.join('; ');
    lines.push(`- ${p.file}: ${stat}`);
  }
  if (!passed) {
    lines.unshift('VISUAL/BEHAVIORAL PROBLEMS — the rendered output is wrong even though the code loads:');
  } else {
    lines.unshift(`visual gate: ${pages.length} page(s) render, animate, and run clean`);
  }
  lines.push(`screenshots: ${screenshotDir} (review for design/aesthetic quality)`);
  return { passed, skipped: false, feedback: lines.join('\n'), pages, screenshotDir };
}

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** One-line summary for acceptance-judge evidence (runtimeNote). */
export function visualRuntimeNote(verdict: VisualVerdict): string {
  if (verdict.skipped) return '';
  const parts = verdict.pages.map(
    (p) =>
      `${p.file}: ${p.problems.length === 0 ? 'renders+animates OK' : p.problems.join('; ')} (motion ${(p.motionRatio * 100).toFixed(1)}%)`
  );
  return `Visual observation of the RUNNING artifact: ${parts.join(' | ')}`;
}
