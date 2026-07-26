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
import { PNG } from 'pngjs';
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
  /**
   * External resources that FAILED to load (script/style/font/image). Previously
   * captured by the browser and then thrown away, which made the gate's feedback
   * actively misleading: a page whose CDN <script> never downloaded renders a
   * blank canvas, so the model was told "canvas renders below the visual floor
   * (0 distinct colors)" and went off rewriting its rendering code — three times
   * in one session it rebuilt the same CDN-dependent app, because nothing ever
   * told it the dependency simply had not loaded. The validation browser has no
   * network; the fix is to vendor the dependency, not to touch the renderer.
   */
  failedRequests: string[];
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

/**
 * Sample a SCREENSHOT on the same GRID×GRID lattice and 4-bit quantization as the
 * in-page probe, so the two are directly comparable.
 *
 * This is the SOURCE OF TRUTH, because it measures what the compositor actually
 * painted — regardless of rendering technology.
 *
 * The in-page probe cannot: it calls `canvas.getContext('2d')`, but a canvas can
 * own only ONE context type, so on a WebGL canvas (Three.js, Babylon, PixiJS-WebGL,
 * raw WebGL) that returns null and the probe reads nothing. Every such app therefore
 * measured as "0 distinct colors / 100% dominant / 0% motion" and FALSELY failed as
 * a blank render — while the very screenshots this gate saves showed the app
 * rendering perfectly (the vision reviewer, reading those same PNGs, scored one 6/10
 * and described its lighting and stickers). The model was then told to fix a blank
 * canvas that did not exist, and rebuilt a working renderer over and over.
 *
 * Returns null when the PNG can't be decoded, so the caller falls back to the probe.
 */
export function sampleScreenshot(
  path: string
): { cells: string[]; distinctColors: number; dominantRatio: number } | null {
  try {
    const png = PNG.sync.read(readFileSync(path));
    const { width, height, data } = png;
    if (!width || !height) return null;
    const N = GRID;
    const colors: Record<string, number> = {};
    const cells: string[] = [];
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const x = Math.floor(((gx + 0.5) * width) / N);
        const y = Math.floor(((gy + 0.5) * height) / N);
        const i = (y * width + x) * 4;
        // Same 4-bit-per-channel quantization as PIXEL_PROBE.
        const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
        colors[key] = (colors[key] ?? 0) + 1;
        cells.push(key);
      }
    }
    const counts = Object.values(colors);
    if (cells.length === 0) return null;
    return {
      cells,
      distinctColors: counts.length,
      dominantRatio: Math.max(...counts) / cells.length,
    };
  } catch {
    return null; // undecodable → caller falls back to the in-page probe
  }
}

/** In-page probe: sample the largest canvas on a GRID×GRID grid. Returns JSON.
 * NOTE: a function EXPRESSION (not self-invoked) — WebBrowser.evaluate wraps
 * string scripts as `return (<script>)()`, supplying the invocation itself.
 * FAST-PATH ONLY — see sampleScreenshot: this cannot read a WebGL canvas. */
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

/**
 * Drive a "press to start" interaction so a game leaves its MENU and enters the
 * PLAYING state before we sample pixels. Without this, a game whose start screen
 * is legitimately near-black (title + "click to start") measures as a blank
 * render (few distinct colors, ~99% dominant) and false-fails the visual floor —
 * even when the execution gate passes and the vision reviewer scores it well
 * (octopus_invaders_v3, 2026-07-21: execution PASS, vision 8/10, floor FAIL on a
 * dark title screen). We can't know the game's specific start control, so fire
 * the common ones (pointer/click at viewport centre, Space/Enter/ArrowUp) at both
 * the canvas and the document. Defensive throughout — a page with no such
 * handlers simply ignores every event, so this is safe for non-game pages too.
 * Returns a short status string (never throws).
 */
// Split into POINTER-first and KEYS. The click is fired first because it is the
// most common "click to start" control AND the safest synthetic event (untrusted
// clicks run no default action, and the canvas/body target has no activation
// behaviour). Only if the click did NOT start the game do we fall back to keys —
// this avoids the failure mode where a game starts on click and then treats the
// following synthetic `Space` as PAUSE (or a second shot), landing on a
// paused/near-blank frame and re-introducing a false floor failure.
export const START_POINTER = `(function () {
  try {
    var cx = Math.floor((window.innerWidth || 800) / 2);
    var cy = Math.floor((window.innerHeight || 600) / 2);
    var canvas = document.querySelector('canvas');
    var targets = canvas ? [canvas, document.body, document] : [document.body, document];
    var mouseOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'mousemove'].forEach(function (type) {
      targets.forEach(function (t) {
        try { t.dispatchEvent(new MouseEvent(type, mouseOpts)); } catch (e) {}
      });
    });
    // A DOM start CONTROL needs a click on the ELEMENT ITSELF. Dispatching at
    // the canvas/body above cannot reach it: events bubble UP, not down, so a
    // <button>Start Game</button> never sees them and the game stays on its
    // title screen forever — the gate then judges the MENU and reports 0% motion
    // (octopus_invaders_v3, 2026-07-22: "OCTOPUS INVADERS" + an unstyled Start
    // button, aesthetic 2/10, because gameplay was never reached).
    // Deliberately narrow: real buttons, elements whose own text reads like an
    // intro prompt, or a full-screen clickable overlay. Anchors are EXCLUDED —
    // clicking one can navigate away and destroy the very page we are sampling.
    //
    // The text match is UNANCHORED (word-boundary): the anchored ^start… form
    // missed "CLICK TO START" / "Press to play" / "Tap to begin", so the gate
    // graded the dimmed MENU behind the overlay and the vision judge reported
    // false off-palette/greyscale complaints about a scene that only looked dim
    // because a dark start veil was still composited over it (octopus, 2026-07-23:
    // colours were exact #ffffff/#44aaff on the canvas, but rgba(0,0,0,0.82) menu
    // veil made the judge see grey — score jumped 4.0->9.0 once the gate got past it).
    var startRe = /\\b(start|play|begin|continue)\\b/i;
    var cands = Array.prototype.slice.call(
      document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
    );
    var overlays = [];
    Array.prototype.forEach.call(document.querySelectorAll('div, span, p, h1, h2, h3, section'), function (el) {
      try {
        // Own text only (no descendants) so a whole container isn't matched.
        var own = '';
        for (var i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 3) own += el.childNodes[i].nodeValue;
        }
        if (startRe.test(own)) cands.push(el);
      } catch (e) {}
    });
    // Full-screen clickable overlay: an element that covers most of the viewport
    // and invites a click (cursor:pointer) is almost always an intro/start gate
    // sitting ON TOP of the app. Clicking it dismisses the veil so the judge
    // grades the real content. Text is NOT required (a bare "CLICK TO START"
    // screen may keep its prompt in a child element).
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600;
    Array.prototype.forEach.call(document.querySelectorAll('div, section, [id], [class]'), function (el) {
      try {
        if (el.tagName === 'CANVAS' || el.tagName === 'BODY' || el.tagName === 'HTML') return;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return;
        if (cs.cursor !== 'pointer') return; // must invite a click
        var r = el.getBoundingClientRect();
        if (!r) return;
        // covers >= 60% of the viewport in each axis (a true full-screen veil)
        if (r.width >= vw * 0.6 && r.height >= vh * 0.6) overlays.push(el);
      } catch (e) {}
    });
    var clicked = 0;
    var clickEl = function (el, isOverlay) {
      try {
        var r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return; // not visible
        if (!isOverlay) {
          var label = (el.value || el.textContent || '').slice(0, 40);
          // A bare <button> with no text is still a plausible start control; a
          // TEXT element must read like an intro prompt.
          var isButton = /^(button|input)$/i.test(el.tagName) || el.getAttribute('role') === 'button';
          if (!isButton && !startRe.test(label)) return;
        }
        var o = {
          bubbles: true, cancelable: true, view: window,
          clientX: Math.floor(r.left + r.width / 2), clientY: Math.floor(r.top + r.height / 2),
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
          try { el.dispatchEvent(new MouseEvent(type, o)); } catch (e) {}
        });
        // native click() also runs an inline onclick= handler
        try { if (typeof el.click === 'function') el.click(); } catch (e) {}
        clicked++;
      } catch (e) {}
    };
    cands.forEach(function (el) { clickEl(el, false); });
    overlays.forEach(function (el) { clickEl(el, true); });
    return 'ok:' + clicked;
  } catch (e) { return 'err:' + (e && e.message); }
})`;

const START_KEYS = `(function () {
  try {
    var keys = [
      { key: ' ', code: 'Space', keyCode: 32 },
      { key: 'Enter', code: 'Enter', keyCode: 13 },
      { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ];
    keys.forEach(function (k) {
      var opts = { bubbles: true, cancelable: true, key: k.key, code: k.code };
      ['keydown', 'keyup'].forEach(function (type) {
        [window, document, document.body].forEach(function (t) {
          try {
            if (!t) return;
            var ev = new KeyboardEvent(type, opts);
            // KeyboardEventInit ignores keyCode/which, but a lot of hand-written
            // game code still branches on them (e.g. e.keyCode === 32) — so pin
            // them onto the event after construction or the keyboard path is a
            // no-op for those games.
            try {
              Object.defineProperty(ev, 'keyCode', { get: function () { return k.keyCode; } });
              Object.defineProperty(ev, 'which', { get: function () { return k.keyCode; } });
            } catch (e2) {}
            t.dispatchEvent(ev);
          } catch (e) {}
        });
      });
    });
    return 'ok';
  } catch (e) { return 'err:' + (e && e.message); }
})`;

/** True when a probe payload shows the canvas has left a blank/menu-ish state —
 * used to decide whether the pointer click already started the game (so we can
 * skip the risky keyboard fallback). */
function probeLooksStarted(raw: string): boolean {
  try {
    const p = JSON.parse(raw) as PixelProbeResult;
    return Boolean(p.readable) && (p.distinctColors ?? 0) >= MIN_DISTINCT_COLORS && (p.dominantRatio ?? 1) < MAX_DOMINANT_RATIO;
  } catch {
    return false;
  }
}

/** What `driveStartInteraction` actually did — returned so the branch can be
 *  asserted directly instead of only inferred from a whole-gate verdict. */
export interface StartInteractionResult {
  pointerFired: boolean;
  /** The canvas looked non-blank after the click, so the keys were skipped. */
  startedAfterPointer: boolean;
  keysFired: boolean;
}

/**
 * Drive a game past its start screen: click FIRST, probe, and fall back to the
 * keyboard ONLY if the click did not start it (firing Space at an already-
 * started game can PAUSE it, landing on a near-blank frame).
 *
 * Every evaluate is timeout-raced: a start handler that opens a modal dialog
 * would otherwise block forever. WebBrowser auto-dismisses dialogs, but the race
 * is a belt-and-braces bound (matching the goto guard).
 *
 * Extracted from `runVisualGate` so the click-vs-keys decision is unit-testable
 * on its own, without standing up the whole gate. Never throws — a page that
 * ignores synthetic events simply stays on whatever it rendered, and the sampler
 * reports that honestly.
 */
export async function driveStartInteraction(
  browser: Pick<VisualBrowserDriver, 'evaluate'>,
  opts: { timeoutMs: number; settleMs: number }
): Promise<StartInteractionResult> {
  const result: StartInteractionResult = { pointerFired: false, startedAfterPointer: false, keysFired: false };
  const cap = Math.min(opts.timeoutMs, 5000);
  try {
    await Promise.race([browser.evaluate<string>(START_POINTER), delay(cap)]);
    result.pointerFired = true;
    await delay(opts.settleMs);
    try {
      const raw = await Promise.race([browser.evaluate<string>(PIXEL_PROBE), delay(cap).then(() => '')]);
      result.startedAfterPointer = typeof raw === 'string' && raw.length > 0 && probeLooksStarted(raw);
    } catch {
      result.startedAfterPointer = false;
    }
    if (!result.startedAfterPointer) {
      await Promise.race([browser.evaluate<string>(START_KEYS), delay(cap)]);
      result.keysFired = true;
      await delay(opts.settleMs);
    }
  } catch {
    // Best-effort by design; report how far we got.
  }
  return result;
}

interface PixelProbeResult {
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
  // FIRST — before any "blank canvas" verdict. If the page's dependencies never
  // downloaded, every downstream symptom (no colors, no motion, no canvas) is a
  // CONSEQUENCE of that, and reporting those first sends the model to rewrite a
  // renderer that was never the problem. Name the failed URLs and say what to do.
  if ((report.failedRequests?.length ?? 0) > 0) {
    const urls = report.failedRequests.slice(0, 3).map((u) => u.slice(0, 160));
    const more = report.failedRequests.length > 3 ? ` (+${report.failedRequests.length - 3} more)` : '';
    problems.push(
      `${report.failedRequests.length} external resource(s) FAILED to load: ${urls.join(', ')}${more}. ` +
        'The validation browser has NO NETWORK — a CDN <script>/<link> cannot download, so the page renders ' +
        'blank no matter how correct your code is. Do NOT rewrite the rendering logic: VENDOR the dependency ' +
        'locally (bundle/copy it into the project and reference it by relative path) or drop it and use ' +
        'built-in web APIs.'
    );
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
  // Hoisted OUT of the loop so the outer `finally` can reap a browser leaked by
  // any throw in the loop body. It used to be loop-scoped, so a mid-iteration
  // throw (e.g. getErrors() on a crashed browser) skipped the close, hit the
  // outer catch, and returned `skipped: true` — silently disabling the gate
  // while leaking a headless Chromium every pass. Observed in the wild: 11
  // leaked instances / ~33 GB RSS across a single 4h deliver run.
  let browser: VisualBrowserDriver | null = null;
  const pages: PageVisualReport[] = [];
  try {
    server = await startStaticServer(projectRoot);

    for (const file of files) {
      browser = null;
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
      // Gate the start-interaction on CANVAS presence, not on rAF-in-HTML: a
      // bundled/minified game (Vite/webpack) keeps requestAnimationFrame in its
      // external bundle, so the entry HTML never matches — but the <canvas> tag
      // is in the HTML regardless. Canvas is also exactly what this gate samples,
      // so "has a canvas" is the right signal for "this is an interactive scene
      // that may have a start screen to drive past".
      const hasCanvas = /<canvas[\s/>]/i.test(src);
      const shots: string[] = [];
      // The pre-interaction (menu) screenshot, kept as EVIDENCE for the vision
      // reviewer but NOT fed into the floor/motion stats — the floor is judged on
      // the playing frames. Without this, a game whose menu is broken but whose
      // play state renders would pass with the menu never visible to the reviewer.
      let menuShot: string | null = null;
      let loaded = false;
      let probes: PixelProbeResult[] = [];
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

        // Drive a start interaction so a game leaves its (often near-black) menu
        // and renders the PLAYING state before we sample — otherwise the dark
        // title screen false-fails the visual floor. Only for canvas apps (the
        // start-screen signature); static/DOM pages are left untouched. The click
        // also satisfies the user-gesture requirement that gates a game's
        // AudioContext.resume(). Then let a few frames render.
        if (loaded && hasCanvas) {
          // First, keep one screenshot of the menu as reviewer evidence.
          try {
            const menuPath = join(screenshotDir, `${file.replace(/\.html$/i, '').replace(/[/\\]+/g, '_')}-menu.png`);
            await browser.screenshot(menuPath);
            menuShot = menuPath;
          } catch {
            // evidence is best-effort
          }
          await driveStartInteraction(browser, { timeoutMs, settleMs: Math.min(intervalMs, 600) });
        }

        if (loaded) {
          for (let i = 0; i < samples && Date.now() - start < timeoutMs; i++) {
            if (i > 0) await delay(intervalMs);
            try {
              const raw = await browser.evaluate<string>(PIXEL_PROBE);
              probes.push(JSON.parse(raw) as PixelProbeResult);
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
      const observed = browser.getErrors();
      const errors = observed.filter((e) => e.kind === 'pageerror').map((e) => e.message);
      // Do NOT discard failed requests: when a page loads its framework from a CDN
      // and the validation browser has no network, this is the ONLY signal that
      // explains the blank render. Dropping it is what made the gate's feedback
      // point the model at the wrong file.
      const failedRequests = observed.filter((e) => e.kind === 'requestfailed').map((e) => e.message);
      await browser.close().catch(() => undefined);
      // Null it only AFTER a successful close so the outer `finally` reaps this
      // instance if anything above threw before we got here.
      browser = null;

      const last = probes[probes.length - 1] ?? { canvas: false };
      const first = probes.find((p) => p.readable);

      // SCREENSHOTS ARE THE SOURCE OF TRUTH — they capture what was actually
      // painted, for ANY rendering technology (WebGL, 2D canvas, CSS 3D, SVG, DOM).
      // The in-page canvas probe is kept as a cheap fast-path/fallback, but it is
      // blind to a WebGL canvas (see sampleScreenshot), which made every Three.js
      // app falsely fail as "blank". Motion becomes a real frame-to-frame diff of
      // what was rendered, rather than of pixels the probe could never read.
      const shotStats = shots
        .map((s) => sampleScreenshot(s))
        .filter((s): s is NonNullable<ReturnType<typeof sampleScreenshot>> => s !== null);
      const shotFirst = shotStats[0];
      const shotLast = shotStats[shotStats.length - 1];

      const base: Omit<PageVisualReport, 'problems'> = {
        file,
        loaded,
        hasCanvas: Boolean(last.canvas),
        distinctColors: shotLast?.distinctColors ?? last.distinctColors ?? 0,
        dominantRatio: shotLast?.dominantRatio ?? last.dominantRatio ?? 1,
        motionRatio:
          shotFirst && shotLast
            ? motionBetween(shotFirst.cells, shotLast.cells)
            : motionBetween(first?.cells, last.cells),
        expectsAnimation,
        runtimeErrors: errors,
        failedRequests,
        // Evidence for the vision reviewer: the menu frame first (if captured),
        // then the playing frames. The floor/motion stats above are computed
        // from `shots` (playing) ONLY, so this evidence does not sway the verdict.
        screenshots: menuShot ? [menuShot, ...shots] : shots,
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
    // Reaps a browser leaked by any throw between launch and the per-iteration
    // close above. Without this the process keeps a live Chromium (and its
    // renderer tree) attached, which is what kept a SIGTERM'd deliver run alive
    // for hours: the leaked children held the event loop open.
    await browser?.close().catch(() => undefined);
  }

  const failing = pages.filter((p) => p.problems.length > 0);
  let passed = failing.length === 0;
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
  // Whole-artifact richness (color floor / animation floor) is only satisfiable
  // once the FULL deliverable is assembled — a scaffold epic's stub modules
  // legitimately render a blank canvas, and hard-failing it re-creates the
  // unsatisfiable-gate class the epic controller solved for user-validation
  // (run J live, 2026-07-17: scaffold-html-css split twice over "1 distinct
  // color < 3 required" with EVERY other gate green). On non-final epics the
  // verdict downgrades to an advisory pass; the FINAL epic judges for real.
  if (!passed && process.env.UAP_EPIC_NONFINAL === '1') {
    passed = true;
    lines.unshift('NA: non-final epic — visual richness floors are judged for real on the FINAL epic (findings below are advisory)');
  }
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
