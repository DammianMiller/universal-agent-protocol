/**
 * Execution gate — proves generated code actually RUNS, not just that files
 * exist and parse.
 *
 * The build/type-check/test rungs in verifier-ladder catch syntax and (for TS)
 * type errors, but a vanilla-JS project has none of those gates, so crash-class
 * bugs — a temporal-dead-zone ReferenceError, an undefined cross-file global, a
 * forgotten draw call — ship green. This gate closes that hole by executing the
 * artifact in a type-appropriate runtime and failing on any uncaught error.
 *
 * It is exposed two ways:
 *  - `runExecutionGate(projectRoot)` — async, directly callable/testable.
 *  - `synthesizeExecutionRung(projectRoot)` — a GateRung that shells out to the
 *    sibling runner (execution-gate-runner) so the SYNC verifier ladder can run
 *    it via the normal spawn path (mirrors how deploy-dev is a special rung).
 */

import { spawnSync } from 'child_process';
import { createServer, type Server } from 'http';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import vm from 'vm';
import type { GateRung } from './verifier-ladder.js';
import { sanitizedEnv } from './sanitized-env.js';
import { loadPlaywrightDriver } from './playwright-driver.js';
import {
  invalidateCapabilityCurrent,
  sanitizeProfile,
  unmeasured,
  writeCapabilityCurrent,
  type CapabilityProfile,
} from './capability-profile.js';

/**
 * Env for spawned smoke-runs with secret-bearing vars stripped, mirroring
 * verifier-ladder's sanitizedEnv. Inlined (not imported) so the type-only
 * back-edge to verifier-ladder stays type-only and no runtime import cycle
 * forms. Generated code runs in this child, so it must never inherit
 * provider credentials it could exfiltrate.
 */
// Shared secret-strip (broadened past API_KEY/TOKEN/… after an audit).
function gateEnv(): NodeJS.ProcessEnv {
  return sanitizedEnv();
}

export type ArtifactType = 'web' | 'node' | 'cli' | 'lib';

export interface ExecutionResult {
  passed: boolean;
  /** 0 on pass, 1 on fail, null when the gate could not run at all. */
  exitCode: number | null;
  /** Short human reason when failed (or skipped). */
  failureReason?: string;
  /** Captured detail (stack/console/stdout tail) shown in loop feedback. */
  outputTail: string;
  durationMs: number;
  /** How the artifact was exercised, for diagnostics. */
  via?: 'browser' | 'vm-dom' | 'child-process' | 'none';
}

export interface ExecutionGateOptions {
  /** Per-gate wall-clock budget. Default 60s. */
  timeoutMs?: number;
  /** How long to let a web page run (RAF ticks) before reading errors. Default 1500ms. */
  settleMs?: number;
  /**
   * Inject a browser implementation for testing. Must expose the subset of
   * WebBrowser used here. Default: the real WebBrowser (cloakbrowser).
   */
  browserFactory?: () => BrowserDriver;
}

/** Minimal browser surface the gate depends on (satisfied by WebBrowser). */
export interface BrowserDriver {
  launch(opts?: Record<string, unknown>): Promise<unknown>;
  goto(url: string): Promise<string>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
  getErrors(): Array<{ kind: string; message: string }>;
  /** Optional: run a function in the page and return its result (WebBrowser has it). */
  evaluate?<T>(script: string | ((arg: unknown) => unknown)): Promise<T>;
  /** Optional: register a script to run before every page's own scripts (pre-load instrumentation). */
  addInitScript?(script: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Can this browser actually compile a WebGL2 shader?
 *
 * The playwright rung was reached only when the primary driver THREW. That
 * covers "no browser" and misses the case that actually bit: a browser that
 * launches fine but has no usable WebGL2 behind it. The page then runs, every
 * shader fails, and the gate reports a real-looking failure — which is
 * indistinguishable, from the model's side, from the stub reporting
 * `Shader compile error: undefined` fifty times.
 *
 * Probed rather than assumed, because "has a browser" and "has WebGL2" are
 * different questions and only the second one matters here. Any failure to
 * answer counts as "no": a driver that cannot run this snippet cannot be
 * trusted to judge a shader either.
 */
async function supportsWebGl2(browser: BrowserDriver): Promise<boolean> {
  if (typeof browser.evaluate !== 'function') return false;
  try {
    return await withTimeout(
      browser.evaluate<boolean>(`(() => {
        try {
          const gl = document.createElement('canvas').getContext('webgl2');
          if (!gl) return false;
          const s = gl.createShader(gl.VERTEX_SHADER);
          gl.shaderSource(s, '#version 300 es\\nvoid main(){ gl_Position = vec4(0.0); }');
          gl.compileShader(s);
          return !!gl.getShaderParameter(s, gl.COMPILE_STATUS);
        } catch { return false; }
      })()`),
      WEBGL_PROBE_TIMEOUT_MS,
      'webgl-probe'
    );
  } catch {
    return false;
  }
}

/** Budget for the WebGL2 capability probe — one tiny evaluate, not a page load. */
const WEBGL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Does the entry point reference WebGL?
 *
 * Cheap and deliberately shallow: the probe above costs a browser round-trip,
 * and there is no reason to pay it for a page that never asks for a GL context.
 * A false positive costs one probe; a false negative just leaves the primary
 * driver in place, which is the behaviour that shipped.
 */
function usesWebGl(entryDir: string, entry: string): boolean {
  try {
    const html = readFileSync(join(entryDir, entry), 'utf-8');
    if (/webgl2?/i.test(html)) return true;
    // Inline pages keep their GL in a sibling script (constants.js, main.js).
    for (const f of readdirSync(entryDir)) {
      if (!/\.(m?js)$/i.test(f)) continue;
      try {
        if (/getContext\(\s*['"`]webgl/i.test(readFileSync(join(entryDir, f), 'utf-8'))) return true;
      } catch {
        continue;
      }
    }
  } catch {
    /* unreadable entry — assume not */
  }
  return false;
}

/** Result of the in-page canvas-render probe. */
interface CanvasRenderProbe {
  hasCanvas: boolean;
  nonUniformPixels?: number;
  /** Shader-compile / program-link failures recorded by RAF_INSTRUMENT, with
   *  the driver's own info log. A WebGL canvas cannot be read with
   *  getImageData (one context per canvas), so this is the reading that exists
   *  for a page that draws nothing. */
  glErrors?: string[];
  /** rAF call count sampled across the load window (loop alive on load?). */
  rafLoad0?: number;
  rafLoad1?: number;
  /** rAF call count sampled across a window AFTER the primary interaction
   *  (start/click) — catches a loop that freezes when the app is actually used. */
  rafPostClick0?: number;
  rafPostClick1?: number;
  note?: string;
}

/**
 * Pre-load instrumentation (addInitScript): wrap requestAnimationFrame with a
 * counter BEFORE the page's own scripts run, so the gate can tell a LIVE render
 * loop (counter keeps climbing) from a DEAD/FROZEN one (climbed, then stopped)
 * from a legitimately STATIC page (never climbed). Fail-soft in the page.
 */
/**
 * A per-session random key for the read-back hooks.
 *
 * Not paranoia — measured. The hooks used to live on fixed, writable names, and
 * `addInitScript` guarantees they exist BEFORE the page's own scripts, which
 * guarantees the page's scripts run AFTER and can replace them. A four-line
 * empty page reported 1,000,000 frames / 99 programs / 99 listener types and the
 * gate read it as a capability INCREASE. For a rung whose entire purpose is
 * catching a model that bought a clean verdict, "the code under test can write
 * its own score" is disqualifying.
 *
 * The key is generated host-side (never project-controlled, so interpolating it
 * is safe) and the hooks are installed non-writable and non-configurable, so a
 * page can neither overwrite them nor delete and redefine them. It can still
 * refuse to render — that is a real regression and gets reported as one.
 */
export function capabilityKey(): string {
  return `__uapCap${randomBytes(9).toString('hex')}`;
}

const RAF_INSTRUMENT_FOR = (key: string): string => `(() => { try {
  var KEY = ${JSON.stringify(key)};
  var n = 0; var executed = 0; var lastT = -1; var orig = window.requestAnimationFrame;
  if (typeof orig === 'function') {
    // Two counters, deliberately different. \`n\` counts SCHEDULED callbacks and
    // feeds the existing liveness rung, which asks "is a loop still being
    // driven". \`executed\` counts callbacks that actually RAN and feeds the
    // capability profile, which asks "how much is actually happening" — a loop
    // that schedules a callback which then throws has scheduled a frame it never
    // drew, and the scheduled count would hide exactly that death.
    window.requestAnimationFrame = function(cb){
      n++;
      return orig.call(window, function(t){
        var r = cb(t);
        // Count DISTINCT timestamps, not callbacks. rAF happily runs any number
        // of callbacks against the same frame, so counting callbacks let a page
        // scheduling 8000 no-op callbacks per tick report 632,000 frames -- and
        // frame rate is the metric the liveness floor rests on. Distinct
        // timestamps is also simply the correct definition: it is what "a frame"
        // means, and it collapses that forgery to the ~120 real frames drawn.
        if (t !== lastT) { lastT = t; executed++; }
        return r;
      });
    };
    Object.defineProperty(window, '__uapRafCount', { configurable: true, get: function(){ return n; } });
  }
  // Ask the GL context whether the shaders it was given actually compiled.
  //
  // Reading pixels was the obvious way to catch a page that paints nothing, and
  // it does not work: a canvas has exactly ONE context, so getImageData on a
  // WebGL canvas returns null, and reading the default framebuffer in-frame was
  // measured wrong 10 times out of 12 on a page that demonstrably paints
  // (headless Chromium has not necessarily backed the buffer yet). A verdict
  // that false-fails working pages 80% of the time is worse than none.
  //
  // Compile and link status are exact, need no timing, and carry the compiler's
  // own text -- which is the sentence the model actually needs. A page whose
  // shaders do not compile draws nothing BY CONSTRUCTION.
  var glErrs = [];
  var note = function(m){ if (glErrs.length < 8 && glErrs.indexOf(m) === -1) glErrs.push(m); };
  var patch = function(P){
    if (!P || !P.prototype) return;
    var cs = P.prototype.compileShader;
    if (cs) P.prototype.compileShader = function(sh){
      var r = cs.call(this, sh);
      try {
        if (!this.getShaderParameter(sh, this.COMPILE_STATUS)) {
          note('shader compile FAILED: ' + String(this.getShaderInfoLog(sh) || '(empty info log)').trim());
        }
      } catch (e) {}
      return r;
    };
    var lp = P.prototype.linkProgram;
    if (lp) P.prototype.linkProgram = function(pr){
      var r = lp.call(this, pr);
      try {
        if (!this.getProgramParameter(pr, this.LINK_STATUS)) {
          note('program link FAILED: ' + String(this.getProgramInfoLog(pr) || '(empty info log)').trim());
        }
      } catch (e) {}
      return r;
    };
  };
  patch(window.WebGL2RenderingContext);
  patch(window.WebGLRenderingContext);
  Object.defineProperty(window, '__uapGlErrors', { configurable: true, get: function(){ return glErrs.slice(); } });

  // ---- capability counters -------------------------------------------------
  // Both graphics APIs are patched. Keying only on WebGL would leave the
  // capability profile inert for every 2D-canvas deliverable — the same defect
  // class as the WebGL probe that was never called.
  var glDraws = 0, ctxDraws = 0, listeners = 0, t0 = 0;
  var progs = [], types = [];
  var addUniq = function(arr, v){ if (arr.length < 512 && arr.indexOf(v) === -1) arr.push(v); };
  var countIn = function(proto, names, bump){
    if (!proto) return;
    for (var i = 0; i < names.length; i++) {
      (function(nm){
        var o = proto[nm];
        if (typeof o !== 'function') return;
        // One parameter declared, so only ONE consumer of \`arguments\` remains —
        // the forwarding \`apply\` that V8 elides. Passing \`arguments\` to the
        // bump as well defeated escape analysis and materialised a mapped
        // arguments object on every draw call.
        proto[nm] = function(p){ try { bump.call(this, p); } catch (e) {} return o.apply(this, arguments); };
      })(names[i]);
    }
  };
  var GLD = ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements'];
  // clearRect is deliberately ABSENT: it is the canonical ERASE at the top of
  // every 2D loop, not a paint, and counting it adds a constant +1/frame that a
  // gutted build coasts on.
  var CTXD = ['fillRect','strokeRect','drawImage','fillText','strokeText','fill','stroke','putImageData'];
  countIn(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, GLD, function(){ glDraws++; });
  countIn(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, GLD, function(){ glDraws++; });
  // Programs are counted over the PAGE LIFETIME, not the window: an app that
  // binds its program once at init and never again would otherwise read 0, and
  // hoisting a useProgram out of the render loop — a textbook optimisation —
  // would read as deleting a shader.
  countIn(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, ['useProgram'], function(p){ if (p) addUniq(progs, p); });
  countIn(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, ['useProgram'], function(p){ if (p) addUniq(progs, p); });
  countIn(window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype, CTXD, function(){ ctxDraws++; });
  // Guarded like every other global. Unguarded, a throw here reached the outer
  // catch BEFORE the hooks below were installed, so the whole profile reported
  // "instrumentation did not install" — inert, with a misleading reason.
  if (window.EventTarget && window.EventTarget.prototype) {
    var ael = window.EventTarget.prototype.addEventListener;
    if (typeof ael === 'function') {
      window.EventTarget.prototype.addEventListener = function(type){
        try { listeners++; addUniq(types, String(type)); } catch (e) {}
        return ael.apply(this, arguments);
      };
    }
  }
  var seal = function(name, fn){
    Object.defineProperty(window, name, { value: fn, writable: false, configurable: false, enumerable: false });
  };
  // PRISTINE CAPTURES. Taken now, at init time, before the page's own scripts
  // run — not looked up when Read() is called.
  //
  // Measured: overwriting Document.prototype.querySelector with a thrower is
  // ONE LINE that made Read() throw, which the host reads as "unmeasurable",
  // which fails open. A gate whose off-switch is a single line in the code under
  // test is not a gate. performance.now is the same shape: it feeds elapsedMs,
  // and elapsedMs is the denominator of the fps floor, so owning it means owning
  // the liveness verdict.
  var _now = (window.performance && typeof performance.now === 'function')
    ? performance.now.bind(performance) : function(){ return 0; };
  var _qs = (window.Document && Document.prototype && Document.prototype.querySelector)
    ? Document.prototype.querySelector : null;
  seal(KEY + 'Reset', function(){
    glDraws = 0; ctxDraws = 0; executed = 0;
    t0 = _now();
    return true;
  });
  seal(KEY + 'Read', function(){
    var hasCanvas = false;
    try { hasCanvas = _qs ? !!_qs.call(document, 'canvas') : false; } catch (e) {}
    return {
      measured: true,
      elapsedMs: Math.max(0, _now() - t0),
      frames: executed,
      glDrawCalls: glDraws,
      ctx2dDrawCalls: ctxDraws,
      programsUsed: progs.length,
      listeners: listeners,
      listenerTypes: types.length,
      canvas: hasCanvas
    };
  });
} catch (e) {} })()`;

/**
 * FUNCTIONAL check for a <canvas> app: it must actually RENDER and, if it drives
 * an animation loop, that loop must stay ALIVE. Two crash-classes the load-only
 * and DOM gates both miss (the page still loads, DOM chrome still works):
 *
 *  1. BLANK canvas — draws nothing (0 non-uniform pixels). Dead render loop that
 *     never produced a frame, or an undefined draw method.
 *  2. FROZEN canvas — the requestAnimationFrame loop ran a few frames then DIED
 *     (an uncaught error in the frame callback, an interface mismatch mid-update).
 *     The first frame is on screen, so it is NOT blank — but the game never
 *     plays: the ship never moves, waves never spawn. Observed live
 *     (octopus_invaders, 2026-07-24): execution smoke + user-path both green,
 *     vision even graded the frozen first frame, while the ship sat static and no
 *     enemy ever appeared. Load/DOM/pixel checks all pass on a frozen game.
 *
 * The rAF counter (installed by RAF_INSTRUMENT) distinguishes frozen (count was
 * > 0 then stopped) from a legitimately static page (count stayed 0) — so a
 * non-animated visualization is never false-failed.
 */
const CANVAS_RENDER_PROBE = `() => new Promise((resolve) => {
  var c = document.querySelector('canvas');
  var raf = function(){ return (typeof window.__uapRafCount === 'number') ? window.__uapRafCount : -1; };
  var nonUniform = function(){
    if (!c) return -1;
    try {
      var ctx = c.getContext && c.getContext('2d');
      if (!ctx || !c.width || !c.height) return -1;
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var r0 = d[0], g0 = d[1], b0 = d[2], nu = 0;
      for (var i = 0; i < d.length; i += 4) { if (d[i] !== r0 || d[i+1] !== g0 || d[i+2] !== b0) { nu++; if (nu > 64) break; } }
      return nu;
    } catch (e) { return -1; }
  };
  var rafLoad0 = raf();
  setTimeout(function () {
    var rafLoad1 = raf();
    var nu = nonUniform();
    // Exercise the PRIMARY interaction so a loop that freezes on start is caught:
    // click a start/play control if present, and (for canvas games) the canvas.
    try {
      var btn = document.querySelector('#start-btn,#start,#play,#begin,button[id*=start],button[id*=play],[class*=start] button');
      if (!btn) {
        var btns = Array.prototype.slice.call(document.querySelectorAll('button,[role=button]'));
        btn = btns.filter(function(b){ return /\\b(start|play|begin|new game|continue)\\b/i.test(b.textContent || ''); })[0] || null;
      }
      if (btn && btn.click) btn.click();
      if (c) {
        var cx = (c.width || 300) / 2, cy = (c.height || 300) / 2;
        c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
        c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx - 40, clientY: cy - 40 }));
      }
    } catch (e) {}
    var rafPostClick0 = raf();
    setTimeout(function () {
      var ge = Array.isArray(window.__uapGlErrors) ? window.__uapGlErrors : [];
    resolve({ hasCanvas: !!c, nonUniformPixels: nu, glErrors: ge, rafLoad0: rafLoad0, rafLoad1: rafLoad1, rafPostClick0: rafPostClick0, rafPostClick1: raf() });
    }, 700);
  }, 500);
})`;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 1_500;

/**
 * Browser globals the vm-DOM harness does not model. A `ReferenceError` naming
 * one of these is an environment limitation, NOT the app's bug, so the harness
 * fails OPEN (advisory) rather than hard-blocking working code. The most common
 * ones are stubbed in buildDomSandbox so apps that use them still execute; this
 * list catches the long tail.
 */
const BROWSER_GLOBALS = new Set([
  'Image', 'fetch', 'localStorage', 'sessionStorage', 'WebSocket', 'Worker',
  'SharedWorker', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'requestIdleCallback', 'matchMedia', 'location', 'screen', 'history',
  'alert', 'confirm', 'prompt', 'FileReader', 'Blob', 'File', 'indexedDB',
  'crypto', 'OffscreenCanvas', 'WebGLRenderingContext', 'WebGL2RenderingContext',
  'getComputedStyle', 'customElements', 'Notification', 'Audio', 'XMLHttpRequest',
  'navigator', 'caches', 'BroadcastChannel', 'speechSynthesis', 'gtag', 'dataLayer',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.uap', 'agents']);

/** Resolve the compiled sibling runner so a GateRung can `node` it. */
export function executionRunnerPath(): string {
  const p = fileURLToPath(new URL('./execution-gate-runner.js', import.meta.url));
  if (existsSync(p)) return p;
  // Running from TS source (vitest / tsx): the sibling .js lives in dist.
  const distP = p.replace(`${sep}src${sep}`, `${sep}dist${sep}`);
  return existsSync(distP) ? distP : p;
}

/** Pick the entry page of a directory: index.html wins, else any .html (stable order). */
function entryPageOf(dir: string): string | null {
  if (existsSync(join(dir, 'index.html'))) return 'index.html';
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html'));
  } catch {
    return null;
  }
  return names.sort()[0] ?? null;
}

/**
 * Find the web entry page within depth 2 (root + subdirs).
 *
 * ANY .html counts, not just index.html: the visual gate's discoverEntryPages
 * already accepts e.g. `rubiks-cube.html`, so keying execution off index.html
 * alone made the two halves disagree about what a deliverable IS. A web app
 * whose page was named anything else got NO execution rung — and with no
 * build/test rungs either, the ladder came back empty and `uap verify` skipped
 * every gate and exited 0.
 */
export function findWebEntry(projectRoot: string): { dir: string; entry: string } | null {
  const root = resolve(projectRoot);
  const rootEntry = entryPageOf(root);
  if (rootEntry) return { dir: root, entry: rootEntry };
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const e of entries.sort()) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const sub = join(root, e);
    try {
      if (!statSync(sub).isDirectory()) continue;
      const subEntry = entryPageOf(sub);
      if (subEntry) return { dir: sub, entry: subEntry };
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
}

/** Directory containing the web entry page, or null. */
export function findWebEntryDir(projectRoot: string): string | null {
  return findWebEntry(projectRoot)?.dir ?? null;
}

/** Best-effort classification of what kind of artifact lives in the project. */
export function detectArtifactType(projectRoot: string): ArtifactType | null {
  if (findWebEntryDir(projectRoot)) return 'web';
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        bin?: unknown;
        main?: string;
        module?: string;
        exports?: unknown;
      };
      if (pkg.bin) return 'cli';
      if (pkg.main || pkg.module || pkg.exports) return 'lib';
      // A scripts-only / bare package.json has no clear runnable entrypoint; such
      // projects already carry build/test gates, so don't synthesize a redundant
      // (and entryless) execution rung. Only declared entrypoints are gated.
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Static file server (web path) — no python dependency, binds to an ephemeral
// loopback port and serves a single directory.
// ---------------------------------------------------------------------------

/** Path segments the gate server never serves, whatever the artifact asks for. */
const DENIED_SEGMENTS = new Set(['node_modules', '.git', '.uap', '.worktrees']);

/**
 * True when a request path touches a dotfile or a dependency/VCS directory.
 *
 * Checked per SEGMENT so `/.uap/proxy.env`, `/x/../.env` and `/sub/.git/config`
 * are all refused, while ordinary assets are unaffected.
 */
export function isDeniedPath(rel: string): boolean {
  return rel
    // Split on BOTH separators: on Windows `sub\\.git\\config` is one segment
    // to a '/'-only split, matches neither rule, and then resolve() treats the
    // backslashes as separators anyway.
    .split(/[\\/]/)
    .filter(Boolean)
    // Lowercased: `node_modules` is the only entry not already covered by the
    // dotfile rule, so a case-insensitive filesystem (macOS, Windows) serving
    // `/NODE_MODULES/pkg/x` would be the entire gap.
    .some((seg) => seg.startsWith('.') || DENIED_SEGMENTS.has(seg.toLowerCase()));
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

export function startStaticServer(dir: string, entry = 'index.html'): Promise<{ url: string; close: () => void }> {
  // realpath the root so the symlink guard below compares like-for-like.
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(dir));
  } catch {
    rootReal = resolve(dir);
  }
  return new Promise((res, rej) => {
    let server: Server;
    try {
      server = createServer((req, response) => {
        try {
          let urlPath: string;
          try {
            urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
          } catch {
            response.statusCode = 400;
            response.end('bad request');
            return;
          }
          // Browsers auto-request /favicon.ico; answer it so the missing-favicon
          // 404 is not mistaken for a real broken asset and failing the gate.
          if (urlPath === '/favicon.ico') {
            response.statusCode = 204;
            response.end();
            return;
          }
          const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
          // Dotfile / dependency-tree denylist. The server roots at the PROJECT
          // directory, so without this `/.uap/proxy.env` (this project's own
          // convention for the proxy secret), `/.env` and `/.git/config` are all
          // 200s on the SAME ORIGIN as the artifact — and the page's JavaScript
          // is written by the model being graded, which can fetch and exfiltrate
          // them. Nothing an artifact legitimately needs lives behind a dot.
          if (isDeniedPath(rel)) {
            response.statusCode = 403;
            response.end('forbidden');
            return;
          }
          const target = resolve(rootReal, rel);
          // Lexical path-escape guard.
          if (target !== rootReal && !target.startsWith(rootReal + '/')) {
            response.statusCode = 403;
            response.end('forbidden');
            return;
          }
          if (!existsSync(target) || statSync(target).isDirectory()) {
            response.statusCode = 404;
            response.end('not found');
            return;
          }
          // Symlink guard: resolve the real path and confirm it stays in-tree, so
          // a model-planted symlink (link -> /etc) cannot read out-of-tree files.
          let realTarget: string;
          try {
            realTarget = realpathSync(target);
          } catch {
            response.statusCode = 404;
            response.end('not found');
            return;
          }
          if (realTarget !== rootReal && !realTarget.startsWith(rootReal + '/')) {
            response.statusCode = 403;
            response.end('forbidden');
            return;
          }
          // Re-apply the denylist to the RESOLVED path. Checking only the
          // request path leaves the whole control bypassable by one symlink:
          // `ln -s .uap/proxy.env notes.txt` inside the served root makes
          // `/notes.txt` pass the request check, resolve to an in-tree
          // protected file, and stream the secret to model-authored page JS.
          if (isDeniedPath(relative(rootReal, realTarget))) {
            response.statusCode = 403;
            response.end('forbidden');
            return;
          }
          response.setHeader('Content-Type', MIME[extname(realTarget).toLowerCase()] ?? 'application/octet-stream');
          createReadStream(realTarget).pipe(response);
        } catch {
          // Never let a handler exception hang the request (would stall the gate).
          try {
            response.statusCode = 500;
            response.end('error');
          } catch {
            /* response already sent */
          }
        }
      });
    } catch (e) {
      rej(e);
      return;
    }
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      res({ url: `http://127.0.0.1:${port}/${entry.replace(/^\/+/, '')}`, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// Web execution — headless browser, with a vm+mocked-DOM fallback so the gate
// never silently no-ops when a real browser/chromium is unavailable.
// ---------------------------------------------------------------------------

/**
 * Run the in-page canvas render-loop-liveness probe and return a FAILURE result
 * when the canvas is blank or its animation loop is dead/frozen (including a
 * freeze on the primary interaction), else null (healthy, or the driver lacks
 * evaluate). Best-effort — a probe error never flips a genuine pass to a fail.
 */
async function checkCanvasLiveness(browser: BrowserDriver, start: number): Promise<ExecutionResult | null> {
  if (typeof browser.evaluate !== 'function') return null;
  let probe: CanvasRenderProbe;
  try {
    probe = (await browser.evaluate<CanvasRenderProbe>(CANVAS_RENDER_PROBE)) ?? { hasCanvas: false };
  } catch {
    return null;
  }
  if (!probe.hasCanvas) return null;
  const l0 = probe.rafLoad0 ?? -1;
  const l1 = probe.rafLoad1 ?? -1;
  const p0 = probe.rafPostClick0 ?? -1;
  const p1 = probe.rafPostClick1 ?? -1;
  const loopAlive = l1 > l0; // rAF count climbed → an animation loop is running
  // Blank ONLY counts as a failure when a loop is actively running but paints
  // nothing (a live loop that draws nothing). A blank canvas with NO loop is a
  // legitimately static / draw-on-demand / minimal app and is left alone (avoids
  // false-failing trivial fixtures and static canvases).
  const blank = loopAlive && typeof probe.nonUniformPixels === 'number' && probe.nonUniformPixels === 0;
  // Shaders that do not compile draw nothing, whether or not a loop is running,
  // so this does not wait on liveness the way the pixel checks do.
  const glErrors = probe.glErrors ?? [];
  // Freezes on interaction: the loop WAS continuously animating (l1>l0), then
  // after the primary click it STOPPED — the game renders a menu but dies the
  // moment you start it (octopus_invaders, 2026-07-24: menu rAF 93->135, stuck at
  // 123 after Start; execution + user-path + vision all passed the frozen game).
  // Both signals require an ACTIVE loop, so a static / one-shot-draw / minimal
  // canvas is never false-failed (a one-shot rAF draw has l1===l0, not > ).
  const animatedThenFroze = loopAlive && p0 > 0 && p1 === p0;
  if (glErrors.length > 0) {
    return {
      passed: false,
      exitCode: 1,
      failureReason: `${glErrors.length} WebGL shader/program failure(s) — the canvas cannot be drawing correctly`,
      // Verbatim, with the line numbers: this is the whole point. A summary
      // would be another percentage, and a percentage is what stalled the run
      // this came from for nine turns.
      outputTail: `${glErrors.join('\n')}\n\nEvery shader must compile and every program must link before the page can render. Fix these first — they are reported by the GL driver itself, with line numbers into the shader source.`,
      durationMs: Date.now() - start,
      via: 'browser',
    };
  }
  if (!(blank || animatedThenFroze)) return null;
  const reason = animatedThenFroze
    ? 'the <canvas> render loop FREEZES on the primary interaction (the game does not play)'
    : 'the <canvas> render loop runs but paints NOTHING (blank)';
  const detail = animatedThenFroze
    ? 'The page loads and the scene animates, BUT the requestAnimationFrame loop DIES the moment the ' +
      `primary control (Start/Play) is used — 0 new frames after the click (count stuck at ${p0}). The app ` +
      'does not actually PLAY: the ship never moves, nothing spawns, no time-based logic advances. This is ' +
      'an uncaught error thrown in the frame callback once gameplay starts (almost always an interface ' +
      'mismatch calling an undefined method in the update/draw path that only runs in the "playing" state). ' +
      'Fix the loop so it keeps running through and after Start — a game that freezes on start is NOT a ' +
      'working deliverable. This must pass BEFORE any aesthetic/vision judgement.'
    : 'The requestAnimationFrame loop is running but the <canvas> painted NO content (0 non-uniform pixels) ' +
      '— the draw path produces nothing visible (an undefined draw method / a no-op renderer). The app runs ' +
      'but shows nothing; fix the render before any aesthetic judgement.';
  return { passed: false, exitCode: 1, failureReason: reason, outputTail: detail, durationMs: Date.now() - start, via: 'browser' };
}

/**
 * Canvas render-loop-liveness check in a REAL browser, for a classic-<script>
 * canvas app that ALREADY passed vm-dom crash detection. vm-dom cannot drive
 * requestAnimationFrame, so it passes a frozen game; this launches a headless
 * browser purely to run the liveness probe. Returns a FAILURE result when the
 * loop is dead/frozen/blank, else null (healthy OR no browser available →
 * fail-open, the caller keeps the vm-dom pass).
 */
/**
 * Turn a browser's console/page errors into a gate verdict the model can act on.
 *
 * The liveness probe answers one question — is the render loop alive — and
 * everything the browser printed on the way there was thrown away. For a WebGL
 * page that discarded exactly the information the model needs. Measured on a
 * stalled run: the page was blank and the browser had said why, precisely:
 *
 *     Shader compile error: ERROR: 0:215: 'gl_FragColor' : undeclared identifier
 *     Shader compile error: ERROR: 0:15: '=' : dimension mismatch
 *     PAGEERROR: Unexpected identifier 'init'
 *
 * `gl_FragColor` is WebGL1 syntax inside a `#version 300 es` shader — a
 * one-line fix, named with its line number. The model never saw any of it. It
 * was handed "33% of gates" for nine consecutive turns and rewrote working
 * code, because a percentage is not a diagnosis.
 *
 * Uncaught exceptions and shader failures are unambiguous, so they fail the
 * gate on their own. Ordinary console noise (a missing favicon, a warning) is
 * not promoted to a failure — it rides along as detail on a verdict the probe
 * reached independently.
 */
const HARD_ERROR_RE = /shader|pageerror|uncaught|is not (a function|defined)|cannot read propert|failed to (create|link|compile)/i;

function pageErrorFailure(browser: BrowserDriver): { hard: string[]; all: string[] } {
  let all: string[] = [];
  try {
    all = browser.getErrors().map((e) => `${e.kind}: ${e.message}`);
  } catch {
    return { hard: [], all: [] };
  }
  return { hard: all.filter((m) => HARD_ERROR_RE.test(m)), all };
}

/** Fold browser errors into a result so the reason reaches the model verbatim. */
function withBrowserErrors(result: ExecutionResult, errs: string[]): ExecutionResult {
  if (errs.length === 0) return result;
  // Verbatim, and capped: the compiler's own text is the actionable part, and
  // a summary of it would be another percentage.
  const detail = errs.slice(0, 8).join('\n');
  return {
    ...result,
    failureReason: result.failureReason
      ? `${result.failureReason}; browser reported ${errs.length} error(s)`
      : `browser reported ${errs.length} error(s)`,
    outputTail: [result.outputTail, detail].filter(Boolean).join('\n').slice(-4000),
  };
}

async function runCanvasLivenessCheck(
  entryDir: string,
  opts: ExecutionGateOptions,
  entry: string,
  /** vm-dom declined this page (WebGL), so this rung is the ONLY judgement that
   *  will be made. Console errors are then not "noise on someone else's
   *  verdict" -- they are the whole verdict, and dropping them leaves the model
   *  with a percentage. */
  soleJudge = false,
  /** PROJECT root for the capability profile — passed, never inferred. */
  capabilityRoot?: string
): Promise<ExecutionResult | null> {
  const start = Date.now();
  let server: { url: string; close: () => void } | null = null;
  let browser: BrowserDriver | null = null;
  try {
    server = await startStaticServer(entryDir, entry);
    try {
      // For a WebGL page this prefers the driver that actually reports errors.
      // Measured on the same broken page: the default driver's getErrors()
      // returned ONE entry (a 404) and silently dropped every console.error and
      // uncaught exception, including
      //
      //   Shader compile error: ERROR: 0:215: 'gl_FragColor' : undeclared identifier
      //
      // while playwright returned all five. Since this whole rung exists to
      // judge a page the stub cannot, a driver that cannot report why it failed
      // leaves the model with a percentage and no diagnosis — which is what
      // held one run at 33% for nine consecutive turns.
      if (!opts.browserFactory && usesWebGl(entryDir, entry)) {
        const pw = await loadPlaywrightDriver().catch(() => null);
        if (pw) {
          try {
            await pw.launch({ headless: true });
            browser = pw;
          } catch {
            browser = null;
          }
        }
      }
      if (!browser) {
        browser = opts.browserFactory ? opts.browserFactory() : await loadWebBrowser();
        await browser.launch({ headless: true });
      }
    } catch {
      return null; // no browser — fail-open (vm-dom verdict stands)
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const capKey = capabilityKey();
    if (typeof browser.addInitScript === 'function') {
      await browser.addInitScript(RAF_INSTRUMENT_FOR(capKey)).catch(() => undefined);
    }
    await withTimeout(browser.goto(server.url), timeoutMs, 'goto').catch(() => undefined);
    await Promise.race([browser.waitForLoadState('load'), delay(timeoutMs)]).catch(() => undefined);
    await delay(opts.settleMs ?? DEFAULT_SETTLE_MS);
    const liveness = await checkCanvasLiveness(browser, start);
    const { hard, all } = pageErrorFailure(browser);
    if (liveness) return withBrowserErrors(liveness, all);
    if (capabilityRoot) await persistCapability(browser, capKey, capabilityRoot, entry);
    // The loop looked alive, but the page threw. A WebGL app whose shaders did
    // not compile can still tick requestAnimationFrame while drawing nothing —
    // which is exactly how a blank page passed a liveness probe.
    // `hard` is the conservative set (shader/uncaught/pageerror). When this rung
    // is the only judge, an ordinary console.error is the only thing anyone will
    // ever say about the page, so it counts too: `FBO incomplete: 36054` matches
    // nothing in HARD_ERROR_RE and is exactly the sentence the model needed.
    const failing = soleJudge ? all : hard;
    if (failing.length > 0) {
      return withBrowserErrors(
        {
          passed: false,
          exitCode: null,
          failureReason: 'page errors in a real browser',
          outputTail: '',
          durationMs: Date.now() - start,
          via: 'browser',
        },
        all
      );
    }
    return null;
  } catch {
    return null; // any error → fail-open
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    server?.close();
  }
}


/**
 * Read the capability profile out of the page the liveness probe just drove, and
 * persist it.
 *
 * Runs AFTER checkCanvasLiveness deliberately: that probe has already clicked
 * the start/play control, so by the time this opens its window the app is in its
 * PLAYING state. That matters — the regression this profile exists to catch kept
 * a working menu and gutted the game, so a load-time reading would have read
 * both builds as equivalent. Reusing the probe's click also means the two rungs
 * cannot disagree about what "starting the app" means, which a second copy of
 * the selector list guaranteed they eventually would.
 *
 * Every await is bounded. An unbounded evaluate lets a page with `while(1){}` in
 * a start handler hold a Chromium process and a listening port for the rest of
 * the run — and the page is code a model just wrote.
 */

/** Identify the driver so two frame-rate regimes are never compared. */
function driverName(browser: BrowserDriver): string {
  const ctor = (browser as { constructor?: { name?: string } })?.constructor?.name;
  if (ctor && ctor !== 'Object') return ctor;
  // The playwright driver is a plain object literal, so it has no useful
  // constructor name; it is the only driver carrying BOTH optional methods.
  return typeof browser.addInitScript === 'function' && typeof browser.evaluate === 'function'
    ? 'playwright'
    : 'unknown';
}

/** Best-effort: a capability reading must never change an execution verdict. */
async function persistCapability(
  browser: BrowserDriver,
  key: string,
  root: string,
  entry: string
): Promise<void> {
  try {
    // The ACTUAL driver identity. The previous label was
    // `addInitScript ? 'instrumented' : 'plain'`, but a driver without
    // addInitScript never installs the instrument and therefore never yields a
    // measured profile — so every measured profile said 'instrumented' and the
    // mismatch guard in compareCapability could not fire. That guard exists
    // because the gate genuinely swaps drivers based on a REGEX over
    // model-written HTML (usesWebGl), which moves the measurement between two
    // frame-rate regimes mid-run.
    const driver = driverName(browser);
    const profile = await readCapability(browser, key, driver, entry, capabilityWindowMs());
    writeCapabilityCurrent(root, profile);
  } catch {
    /* never let the profile break the gate */
  }
}

async function readCapability(
  browser: BrowserDriver,
  key: string,
  driver: string,
  entry: string,
  windowMs: number
): Promise<CapabilityProfile> {
  if (typeof browser.evaluate !== 'function') return unmeasured('no-browser', driver);
  try {
    const armed = await withTimeout(
      browser.evaluate<boolean>(`(() => { try { return typeof window[${JSON.stringify(key)} + 'Reset'] === 'function' ? window[${JSON.stringify(key)} + 'Reset']() : false; } catch (e) { return false; } })`),
      CAPABILITY_EVAL_TIMEOUT_MS,
      'cap-reset'
    );
    if (armed !== true) return unmeasured('not-installed', driver);
    await delay(windowMs);
    const raw = await withTimeout(
      browser.evaluate<unknown>(`(() => { try { return window[${JSON.stringify(key)} + 'Read'](); } catch (e) { return null; } })`),
      CAPABILITY_EVAL_TIMEOUT_MS,
      'cap-read'
    );
    const profile = sanitizeProfile(raw);
    if (!profile) return unmeasured('no-reading', driver);
    return { ...profile, driver, entry };
  } catch {
    return unmeasured('error', driver);
  }
}

/** Steady-state window. 2s at 60fps is ~120 frames — far above any floor, and a
 *  17x separation from the measured gutted case (3.6fps) survives it intact.
 *  5s was the first guess and cost 2.5s per acceptance turn for no extra
 *  discriminating power. */
export const DEFAULT_CAPABILITY_WINDOW_MS = 2_000;
const CAPABILITY_EVAL_TIMEOUT_MS = 15_000;

export function capabilityWindowMs(): number {
  const env = Number(process.env.UAP_CAPABILITY_WINDOW_MS);
  // Upper bound matters: this sleeps once per acceptance turn, and an unbounded
  // env value would sleep for days.
  return Number.isFinite(env) && env > 0 ? Math.min(env, 60_000) : DEFAULT_CAPABILITY_WINDOW_MS;
}

async function runWeb(
  entryDir: string,
  opts: ExecutionGateOptions,
  entry = 'index.html',
  // The PROJECT root, which is not necessarily the entry dir (findWebEntry
  // searches one level down). Passed, never inferred: a heuristic here wrote the
  // baseline to the parent directory, where nothing reads it, and the gate
  // reported success the whole time.
  capabilityRoot?: string
): Promise<ExecutionResult> {
  const start = Date.now();
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  let server: { url: string; close: () => void } | null = null;
  try {
    server = await startStaticServer(entryDir, entry);
    let browser: BrowserDriver | null = null;
    try {
      browser = opts.browserFactory ? opts.browserFactory() : await loadWebBrowser();
      await browser.launch({ headless: true });
    } catch (e) {
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore */
        }
        browser = null;
      }
      // Before the stub: try playwright-core. The vm-dom harness has no
      // graphics implementation, so for a WebGL page it does not report that
      // it cannot judge — it reports FAILURE, with an empty shader info log.
      // Measured: 50 identical `Shader compile error: undefined` lines in one
      // run, which the model cannot act on and cannot converge past. A real
      // browser is a better oracle than a stub in every case, so this rung
      // goes first and the stub stays only for a machine with no browser.
      try {
        // Only when the caller did NOT inject a driver. An injected
        // browserFactory means "use THIS browser" — quietly substituting a
        // different one would make the injection meaningless and would hide a
        // test's chosen failure behind a real browser that happens to work.
        const pw = opts.browserFactory ? null : await loadPlaywrightDriver();
        if (pw) {
          await pw.launch({ headless: true });
          browser = pw;
        }
      } catch {
        browser = null;
      }
      if (!browser) {
        return runVmDomHarness(entryDir, start, `browser launch failed: ${String(e).slice(0, 120)}`, entry);
      }
    }
    // The primary driver launched. That is not the same as it being able to
    // judge this page: if the entry uses WebGL and the browser cannot compile
    // a WebGL2 shader, every shader "fails" and the verdict is noise. Swap to
    // playwright when it can do better, and only then.
    if (!opts.browserFactory && usesWebGl(entryDir, entry) && !(await supportsWebGl2(browser))) {
      try {
        const pw = await loadPlaywrightDriver();
        if (pw) {
          await pw.launch({ headless: true });
          if (await supportsWebGl2(pw)) {
            try {
              await browser.close();
            } catch {
              /* ignore */
            }
            browser = pw;
          } else {
            await pw.close();
          }
        }
      } catch {
        /* keep the primary driver — a failed upgrade must not lose the rung */
      }
    }
    try {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const capKey = capabilityKey();
      // Instrument requestAnimationFrame BEFORE the page loads so a frozen render
      // loop is detectable after load. Best-effort — engines without addInitScript
      // simply skip the frozen-loop half of the canvas check.
      if (typeof browser.addInitScript === 'function') {
        await browser.addInitScript(RAF_INSTRUMENT_FOR(capKey)).catch(() => undefined);
      }
      // Wall-clock guard so a hung goto/load never wedges a direct caller (the
      // spawned-runner path also has the rung-level spawn timeout as a backstop).
      const status = await withTimeout(browser.goto(server.url), timeoutMs, 'goto');
      await Promise.race([browser.waitForLoadState('load'), delay(timeoutMs)]).catch(() => undefined);
      await delay(settleMs);
      const errors = browser.getErrors();
      const durationMs = Date.now() - start;
      // Accept any 2xx (and 304 cached) — exact '200' false-fails on benign codes.
      const loaded = /^2\d\d$/.test(status) || status === '304';
      if (!loaded) {
        return {
          passed: false,
          exitCode: 1,
          failureReason: `entry did not load (HTTP ${status})`,
          outputTail: `GET ${entry} -> ${status}`,
          durationMs,
          via: 'browser',
        };
      }
      // Fail ONLY on uncaught exceptions (pageerror) — the crash-class signal
      // this gate exists for. console.error and failed sub-resource requests are
      // common in working apps (handled errors, missing decorative assets), so
      // they are advisory: surfaced in the output but never fail the gate.
      const fatal = errors.filter((e) => e.kind === 'pageerror');
      const advisory = errors.filter((e) => e.kind !== 'pageerror');
      if (fatal.length > 0) {
        return {
          passed: false,
          exitCode: 1,
          failureReason: `${fatal.length} uncaught error(s) in the page`,
          outputTail: [...fatal, ...advisory].map((e) => `[${e.kind}] ${e.message}`).join('\n').slice(0, 4000),
          durationMs,
          via: 'browser',
        };
      }
      // Canvas-render functional check: a canvas that draws NOTHING is a dead
      // render loop (crash-class), even with no uncaught pageerror surfaced in
      // the settle window. Only runs when the driver supports evaluate and the
      // page has a canvas; a completely uniform canvas fails. Fail-soft: any
      // probe error leaves the load/error verdict untouched.
      const livenessFail = await checkCanvasLiveness(browser, start);
      if (livenessFail) return livenessFail;
      // The page loaded, ran and its loop is alive — so a capability reading is
      // meaningful and the ordering rule ("never grade the capability of a build
      // that does not run") is satisfied structurally rather than by convention.
      if (capabilityRoot) await persistCapability(browser, capKey, capabilityRoot, entry);
      return {
        passed: true,
        exitCode: 0,
        outputTail:
          advisory.length > 0
            ? `page loaded and ran (no uncaught errors). advisory: ${advisory.map((e) => e.kind).join(', ')}`
            : 'page loaded and ran with no console/page errors',
        durationMs,
        via: 'browser',
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (e) {
    return {
      passed: false,
      exitCode: 1,
      failureReason: 'web execution gate error',
      outputTail: String(e).slice(0, 2000),
      durationMs: Date.now() - start,
      via: 'browser',
    };
  } finally {
    server?.close();
  }
}

/** Lazy-load the real WebBrowser (cloakbrowser) only when actually needed. */
async function loadWebBrowser(): Promise<BrowserDriver> {
  const mod = await import('../browser/web-browser.js');
  return new mod.WebBrowser() as unknown as BrowserDriver;
}

/**
 * No-browser fallback: load the page's classic scripts in order inside a vm with
 * a mocked DOM/canvas/AudioContext/requestAnimationFrame, boot, dispatch a click
 * + mousemove, and tick a few animation frames. Catches the exact class of bug
 * the octopus build had (TDZ/undefined-global/init throw). Only handles classic
 * (non-module) <script src> tags — ES modules return a clean skip.
 */
export function runVmDomHarness(entryDir: string, startedAt?: number, note?: string, entry = 'index.html'): ExecutionResult {
  const start = startedAt ?? Date.now();
  const indexPath = join(entryDir, entry);
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf-8');
  } catch {
    return { passed: false, exitCode: null, failureReason: `no ${entry}`, outputTail: '', durationMs: Date.now() - start, via: 'none' };
  }
  // ES-module pages need real module semantics — the vm harness can't run them.
  // Tolerate unquoted attrs (type=module) too.
  if (/<script[^>]+type=["']?module/i.test(html)) {
    return {
      passed: true,
      exitCode: 0,
      failureReason: 'skipped (ES modules need a real browser)',
      outputTail: 'vm-dom harness only runs classic scripts; install a headless browser for module apps',
      durationMs: Date.now() - start,
      via: 'none',
    };
  }
  // A WebGL page cannot be judged here, and saying so is the whole point.
  //
  // The canvas stub returns one 2D-shaped Proxy for EVERY context type, so
  // `getContext('webgl2')` yields an object whose every method returns
  // undefined: createShader() is undefined, getShaderParameter() is falsy —
  // "compilation failed" — and getShaderInfoLog() is undefined. A correct page
  // then logs exactly what was measured 50 times in one run and 20 in another:
  //
  //     Shader compile error: undefined
  //
  // byte-identical, unactionable, and impossible for the model to fix because
  // nothing was broken. It re-wrote working shaders until the wall clock ended
  // the run. A gate that cannot judge something must not report it as failure;
  // ES-module pages above already take exactly this exit for the same reason.
  //
  // Passing hands the verdict to the browser rung (see the canvas-liveness
  // check at the call site), which does have real WebGL2 — verified on both
  // drivers here: { ctx: true, compiled: true, logType: 'string' }.
  if (usesWebGl(entryDir, entry)) {
    return {
      passed: true,
      exitCode: 0,
      failureReason: 'skipped (needs a real WebGL context)',
      outputTail:
        'vm-dom has no WebGL implementation — its canvas stub answers every context type with a 2D shim, ' +
        'so shader calls return undefined and a working shader looks broken. Judged by the browser rung instead.',
      durationMs: Date.now() - start,
      via: 'none',
    };
  }

  // Build the bundle from external <script src> (in order) AND inline <script>
  // bodies, mirroring how the browser concatenates classic scripts into one
  // shared global lexical scope. Missing src files are a real (broken) reference.
  const units: { name: string; code: string }[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1] ?? '';
    const srcMatch = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (srcMatch) {
      const s = srcMatch[1];
      // A REMOTE script (CDN) is not a file on disk, and the vm harness cannot
      // fetch it — treating it as a missing file false-fails every page that
      // loads three.js/React from a CDN, and executing the rest without it would
      // throw bogus ReferenceErrors for the globals it defines. Hand off to the
      // real browser + visual gate, which can actually load it.
      if (/^(?:https?:)?\/\//i.test(s)) {
        return {
          passed: true,
          exitCode: 0,
          failureReason: 'skipped (page loads remote scripts; needs a real browser)',
          outputTail: `${entry} loads ${s} from the network — the vm-dom harness cannot fetch it; the visual gate renders this page for real`,
          durationMs: Date.now() - start,
          via: 'vm-dom',
        };
      }
      const p = join(entryDir, s.replace(/^\//, ''));
      if (!existsSync(p)) {
        // Parity with the visual + user-path gates (run W, octopus variant,
        // 2026-07-18): when the plan scaffolds index.html EARLY, its script
        // tags reference files that LATER epics deliver — hard-failing the
        // smoke on the missing file makes every early epic unsatisfiable and
        // burns its whole attempt budget (3 attempts x 5 turns on epic 1).
        // On a non-final epic the missing reference is "not-ready", not a
        // defect; the FINAL epic runs with the flag unset and enforces it.
        if (process.env.UAP_EPIC_NONFINAL === '1') {
          return {
            passed: true,
            exitCode: 0,
            failureReason: `deferred: script not found: ${s} (non-final epic)`,
            outputTail: `NA: non-final epic — ${entry} references ${s} which does not exist YET; a later epic must create it (the final epic enforces this for real)`,
            durationMs: Date.now() - start,
            via: 'vm-dom',
          };
        }
        return {
          passed: false,
          exitCode: 1,
          failureReason: `script not found: ${s}`,
          outputTail: `${entry} references ${s} which does not exist`,
          durationMs: Date.now() - start,
          via: 'vm-dom',
        };
      }
      units.push({ name: s, code: readFileSync(p, 'utf-8') });
    } else if (m[2] && m[2].trim()) {
      units.push({ name: `inline#${units.length}`, code: m[2] });
    }
  }
  if (units.length === 0) {
    return { passed: true, exitCode: 0, outputTail: 'no scripts to execute', durationMs: Date.now() - start, via: 'vm-dom' };
  }
  const srcs = { length: units.length };

  // Duplicate top-level lexical declarations across DIFFERENT scripts are a
  // guaranteed browser SyntaxError (classic scripts share one global lexical
  // environment): run X (octopus variant, 2026-07-18) shipped BOTH module
  // generations (enemy.js + enemies.js declaring class Enemy) and the page
  // black-screened while the concatenated-bundle harness called it
  // "inconclusive". Deterministic pre-pass so the failure names both files.
  // var/function redeclaration is LEGAL in browsers — only class/const/let.
  // Column-0 only: indented declarations are (almost always) block-scoped and
  // legal to repeat across files — matching them false-positives on every
  // `  const result = ...` helper (live false hit: utils.js vs entity-registry.js).
  const declRe = /^(?:class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  const declaredIn = new Map<string, string[]>();
  for (const u of units) {
    const seenHere = new Set<string>();
    for (const dm of u.code.matchAll(declRe)) {
      const name = dm[1];
      if (seenHere.has(name)) continue;
      seenHere.add(name);
      const files = declaredIn.get(name) ?? [];
      files.push(u.name);
      declaredIn.set(name, files);
    }
  }
  const collisions = [...declaredIn.entries()].filter(([, files]) => files.length > 1);
  if (collisions.length > 0) {
    const detail = collisions
      .slice(0, 6)
      .map(([name, files]) => `'${name}' declared in ${files.join(' AND ')}`)
      .join('; ');
    return {
      passed: false,
      exitCode: 1,
      failureReason: `duplicate top-level declaration: ${collisions[0][0]}`,
      outputTail: `${entry} loads scripts that redeclare the same identifier — a guaranteed SyntaxError in the browser (page will not boot): ${detail}. Remove or unwire the superseded script(s).`,
      durationMs: Date.now() - start,
      via: 'vm-dom',
    };
  }

  const sandbox = buildDomSandbox();
  try {
    vm.createContext(sandbox);
    // Execute each script as its own unit (browser semantics: separate
    // compilation units sharing one global scope). A unit-level syntax error
    // is realm-crossed (vm-context errors fail `instanceof SyntaxError` in the
    // host realm — the hole that let run X's duplicate-class page through as
    // "inconclusive"), so classify by constructor name and hard-fail naming
    // the file. Non-syntax unit errors fall through to the shared classifier.
    for (const u of units) {
      try {
        vm.runInContext(u.code, sandbox, { filename: u.name, timeout: 8000 });
      } catch (ue) {
        const ctor = (ue as Error | undefined)?.constructor?.name;
        if (ue instanceof SyntaxError || ctor === 'SyntaxError') {
          const umsg = ue instanceof Error ? ue.message : String(ue);
          // ESM syntax in a file the entry loads as a CLASSIC script is a
          // module-system mismatch, NOT a defect in the file — the file is valid
          // ES module source. Naming the file sends the model to "fix" correct
          // code. Observed live: a 4-turn / 2h20m stall where every turn re-read
          // contracts.js, found valid ESM, changed nothing, and burned its round
          // budget, because the gate kept saying "syntax error in contracts.js"
          // while the real defect was the missing type="module" in index.html.
          const esmInClassic =
            /Unexpected token 'export'|Cannot use import statement outside a module/.test(umsg);
          if (esmInClassic) {
            return {
              passed: false,
              exitCode: 1,
              failureReason: `module-system mismatch: ${u.name} is an ES module but ${entry} loads it as a classic script`,
              outputTail:
                `${u.name}: SyntaxError: ${umsg.slice(0, 200)}\n` +
                `${u.name} uses ES module syntax (import/export), but ${entry} loads it with a plain ` +
                `<script src="..."> tag, which the browser parses as a classic script — the page will not boot.\n` +
                `THE DEFECT IS IN THE WIRING, NOT IN ${u.name} — do not rewrite ${u.name} to chase this error. ` +
                `Pick ONE of these and apply it consistently to EVERY script ${entry} loads:\n` +
                `  1. Classic scripts — remove the top-level import/export statements and let the files share globals.\n` +
                `  2. ES modules — add type="module" to the <script> tags in ${entry} ` +
                `(note: this needs a real headless browser; the vm-dom harness only runs classic scripts).`,
              durationMs: Date.now() - start,
              via: 'vm-dom',
            };
          }
          return {
            passed: false,
            exitCode: 1,
            failureReason: `syntax error in ${u.name}`,
            outputTail: `${u.name}: SyntaxError: ${umsg.slice(0, 300)} — the browser hits this same error and the page will not boot.`,
            durationMs: Date.now() - start,
            via: 'vm-dom',
          };
        }
        throw ue;
      }
    }
    // Drive a few frames + a start interaction to exercise the playing path.
    const tick = (n: number): void => {
      let t = 0;
      for (let i = 0; i < n && sandbox.__raf.cb; i++) {
        const cb = sandbox.__raf.cb;
        sandbox.__raf.cb = null;
        cb(t += 16);
      }
    };
    // Start the page the way a browser does. Without this the harness executed
    // only top-level definitions, so an app whose entry point is
    // `window.addEventListener('load', () => Game.init())` never ran a line of
    // its own logic — and an artifact that had LOST that listener was
    // byte-indistinguishable from a working one. Observed live (Octopus
    // Invaders, 2026-08-01): a rewrite deleted the bootstrap, this gate still
    // reported "booted N script(s) ... clean", and the only failing signal was
    // a user-path assertion three journeys downstream saying "#hud NOT visible".
    sandbox.__fire('DOMContentLoaded');
    sandbox.__fire('load');
    tick(3);
    sandbox.__fire('click');
    sandbox.__fire('mousedown');
    sandbox.__fire('mousemove', { clientX: 100, clientY: 100 });
    tick(60);
    // "Nothing started" signal — ADVISORY, not blocking.
    //
    // After load and a click, an app that started has usually scheduled a
    // frame, registered a listener, or drawn. One that only DEFINES things does
    // none of those — the run-C signature, where a rewrite deleted
    // `window.addEventListener('load', () => Game.init())` and the artifact
    // parsed, threw nothing, and did nothing.
    //
    // It is NOT a failure, because the same signature is produced by code that
    // legitimately ran and did little: a page whose top-level script only
    // constructs objects, or a static page. Blocking on it failed three real
    // fixtures in this suite. So report it where the model will read it and let
    // the user-path rung decide — a wrong hint costs a turn, a wrong refusal
    // costs a working artifact.
    const startedNote = sandbox.__started()
      ? ''
      : ' — WARNING: nothing started. After DOMContentLoaded, load and a click, the page scheduled no' +
        ' animation frame, registered no listeners and drew nothing. If this app is meant to do something' +
        ' on load, check that a top-level call actually STARTS it (e.g. App.init()); a module that only' +
        ' defines an init and never invokes it parses cleanly and does nothing.';
    return {
      passed: true,
      exitCode: 0,
      outputTail: `vm-dom: booted ${srcs.length} script(s), ran menu→playing frames clean${note ? ` (${note})` : ''}${startedNote}`,
      durationMs: Date.now() - start,
      via: 'vm-dom',
    };
  } catch (e) {
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const msg = e instanceof Error ? e.message : String(e);
    const tail = stack.split('\n').slice(0, 6).join('\n').slice(0, 4000);
    // The vm sandbox is a partial browser. To never hard-block WORKING code, only
    // fail on high-confidence real-bug signatures; treat env limitations as a
    // fail-open advisory (the gate exists to catch crashes, not to punish apps
    // for using a browser API the mock lacks).
    const undefName = /(\w+) is not defined/.exec(msg)?.[1];
    // A missing global is the harness's limit (fail-open), not the app's bug, when
    // it's a known browser global OR a PascalCase name — browser/library globals
    // are overwhelmingly constructors (Image, WebSocket, SpeechRecognition, THREE,
    // …). An app's own missing symbol in a real bug is almost always a
    // function/var (lowercase/camelCase), which we DO hard-fail on below.
    const isLikelyBrowserOrLib = undefName !== undefined && (BROWSER_GLOBALS.has(undefName) || /^[A-Z]/.test(undefName));
    if (isLikelyBrowserOrLib) {
      return {
        passed: true,
        exitCode: 0,
        failureReason: `inconclusive: '${undefName}' is not available in the harness`,
        outputTail: `vm-dom can't model '${undefName}'. Install a headless browser for full coverage.`,
        durationMs: Date.now() - start,
        via: 'none',
      };
    }
    const isTDZ = /before initialization/.test(msg);
    const isSyntax = e instanceof SyntaxError || (e as Error | undefined)?.constructor?.name === 'SyntaxError';
    const isAppUndefined = undefName !== undefined; // a lowercase/camelCase own symbol
    if (isTDZ || isSyntax || isAppUndefined) {
      return {
        passed: false,
        exitCode: 1,
        failureReason: 'runtime error while executing the page',
        outputTail: tail,
        durationMs: Date.now() - start,
        via: 'vm-dom',
      };
    }
    // Ambiguous (e.g. a TypeError that could stem from the stub's fidelity rather
    // than a real bug) → fail open with the detail surfaced, so we never wedge a
    // session on a harness artifact. A real browser run would adjudicate these.
    return {
      passed: true,
      exitCode: 0,
      failureReason: `inconclusive (vm-dom): ${msg.slice(0, 120)}`,
      outputTail: tail,
      durationMs: Date.now() - start,
      via: 'none',
    };
  }
}

/** A mocked browser global scope sufficient to boot a canvas app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDomSandbox(): any {
  const listeners: Record<string, Record<string, Array<(e: unknown) => void>>> = {
    window: {},
    document: {},
    canvas: {},
  };
  const reg = (bag: Record<string, Array<(e: unknown) => void>>) => (type: string, fn: (e: unknown) => void) => {
    (bag[type] ||= []).push(fn);
  };
  const drew = { any: false };
  const ctxStub: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        // Reading ANY 2d-context member means app code is executing against the
        // canvas. Existing fixtures do exactly this at top level with no rAF and
        // no listeners — treating them as "never started" was a false positive
        // the suite caught.
        if (p !== 'canvas') drew.any = true;
        if (p === 'canvas') return canvas;
        if (p === 'measureText') return () => ({ width: 10 });
        if (p === 'createLinearGradient' || p === 'createRadialGradient')
          return () => ({ addColorStop() {} });
        if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (
          ['globalAlpha', 'lineWidth', 'font', 'fillStyle', 'strokeStyle', 'globalCompositeOperation', 'textAlign', 'textBaseline', 'shadowBlur', 'shadowColor', 'lineCap', 'lineJoin'].includes(String(p))
        )
          return 0;
        return () => {};
      },
      set() {
        return true;
      },
    }
  );
  const canvas = {
    width: 1280,
    height: 720,
    style: {},
    getContext: () => ctxStub,
    addEventListener: reg(listeners.canvas),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  };
  const audioStub: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === 'createOscillator')
          return () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, value: 0 }, type: '', detune: { setValueAtTime() {} } });
        if (p === 'createGain')
          return () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, value: 0 } });
        if (p === 'createBuffer') return () => ({ getChannelData: () => new Float32Array(64) });
        if (p === 'createBufferSource') return () => ({ connect() {}, start() {}, stop() {}, buffer: null });
        if (p === 'createBiquadFilter') return () => ({ connect() {}, frequency: { setValueAtTime() {}, value: 0 }, type: '', Q: { value: 0 } });
        if (p === 'destination') return {};
        if (p === 'currentTime') return 0;
        if (p === 'sampleRate') return 44100;
        return () => {};
      },
    }
  );
  // `everScheduled` is sticky: tick() consumes raf.cb each frame, so the live
  // field cannot answer "did this app ever schedule a frame?" after ticking.
  const raf: { cb: ((t: number) => void) | null; everScheduled: boolean } = {
    cb: null,
    everScheduled: false,
  };
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener: reg(listeners.window),
    requestAnimationFrame: (cb: (t: number) => void) => {
      raf.cb = cb;
      raf.everScheduled = true;
      return 1;
    },
    cancelAnimationFrame: () => {},
    AudioContext: function () {
      return audioStub;
    },
    webkitAudioContext: function () {
      return audioStub;
    },
    performance: { now: () => 0 },
  };
  const doc = {
    getElementById: () => canvas,
    querySelector: () => canvas,
    addEventListener: reg(listeners.document),
    createElement: () => canvas,
    body: { appendChild() {}, style: {} },
  };
  const fire = (type: string, ev: Record<string, unknown> = {}): void => {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {}, clientX: 640, clientY: 360, button: 0, key: '' }, ev);
    for (const bag of [listeners.canvas, listeners.document, listeners.window]) {
      (bag[type] || []).forEach((fn) => fn(e));
    }
  };

  // Stubs for the most common browser globals so apps that use them actually run
  // (rather than fail-open immediately). Long-tail globals are handled by the
  // BROWSER_GLOBALS fail-open path in runVmDomHarness.
  const makeStorage = (): unknown => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k) : null),
      setItem: (k: string, v: unknown) => void m.set(String(k), String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };
  function ImageStub(this: Record<string, unknown>) {
    this.src = '';
    this.onload = null;
    this.onerror = null;
    this.width = 0;
    this.height = 0;
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
  const common: Record<string, unknown> = {
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    Image: ImageStub,
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        blob: () => Promise.resolve({}),
      }),
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost', hostname: 'localhost', pathname: '/', search: '', hash: '', reload: () => {}, assign: () => {}, replace: () => {} },
    screen: { width: 1280, height: 720, availWidth: 1280, availHeight: 720 },
    matchMedia: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestIdleCallback: (cb: (d: unknown) => void) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: false }), 0),
    cancelIdleCallback: () => {},
    Audio: function () {
      return { play: () => Promise.resolve(), pause: () => {}, addEventListener: () => {}, load: () => {}, currentTime: 0, volume: 1, loop: false };
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  };
  Object.assign(win, common);
  return {
    window: win,
    document: doc,
    console,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    AudioContext: win.AudioContext,
    webkitAudioContext: win.webkitAudioContext,
    performance: win.performance,
    navigator: { userAgent: 'uap-execution-gate', language: 'en-US', platform: 'uap', maxTouchPoints: 0 },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    Math,
    Date,
    isNaN,
    parseInt,
    parseFloat,
    ...common,
    __raf: raf,
    __fire: fire,
    // Did the app do ANYTHING beyond defining things?
    //
    // A scheduled frame counts. A registered listener counts — EXCEPT for
    // load/DOMContentLoaded, which are a promise to start rather than proof of
    // having started. Counting those would make the dead artifact look alive:
    // its one surviving act is registering the very bootstrap that never fires.
    // Excluding them is also what makes this probe depend on the load dispatch
    // above — without it, a working app registers only its load listener and
    // would be reported dead.
    __started: (): boolean =>
      drew.any ||
      raf.everScheduled ||
      [listeners.canvas, listeners.document, listeners.window].some((bag) =>
        Object.entries(bag).some(
          ([type, fns]) => type !== 'load' && type !== 'DOMContentLoaded' && fns.length > 0
        )
      ),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject if `p` does not settle within `ms` (bounds a hung browser call). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Node / CLI / lib execution — run the entrypoint in a child process and fail
// on a non-zero exit or a thrown error at import/run time.
// ---------------------------------------------------------------------------

function runNodeLike(projectRoot: string, type: ArtifactType, opts: ExecutionGateOptions): ExecutionResult {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let entry: string | null = null;
  let mode: 'help' | 'import' = 'import';
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      bin?: string | Record<string, string>;
      main?: string;
      module?: string;
    };
    if (type === 'cli' && pkg.bin) {
      entry = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
      mode = 'help';
    } else {
      entry = pkg.main ?? pkg.module ?? 'index.js';
      mode = 'import';
    }
  } catch {
    entry = 'index.js';
  }
  if (!entry || !existsSync(join(projectRoot, entry))) {
    return {
      passed: true,
      exitCode: 0,
      failureReason: `skipped (no runnable entry '${entry ?? '?'}')`,
      outputTail: 'no entrypoint to smoke-run',
      durationMs: Date.now() - start,
      via: 'none',
    };
  }
  const args = mode === 'help' ? [entry, '--help'] : ['-e', `import(${JSON.stringify('./' + entry)}).then(()=>process.exit(0)).catch(e=>{console.error(e&&e.stack||e);process.exit(1)})`];
  const r = spawnSync('node', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: gateEnv(),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000);
  const passed = r.status === 0;
  return {
    passed,
    exitCode: r.status ?? 1,
    failureReason: passed ? undefined : `entrypoint ${mode === 'help' ? '--help' : 'import'} exited ${r.status ?? 'null'}`,
    outputTail: out || (passed ? 'ran clean' : 'no output'),
    durationMs: Date.now() - start,
    via: 'child-process',
  };
}

/**
 * Execute the project's artifact and report whether it runs without error.
 * Auto-detects the artifact type; returns a skip-pass when there is nothing
 * runnable (the ladder's fail-closed floor lives in detectRungs, not here).
 */
export async function runExecutionGate(
  projectRoot: string,
  opts: ExecutionGateOptions = {}
): Promise<ExecutionResult> {
  // Invalidate the capability reading FIRST, so `current.json` can only ever
  // describe this run. It is written back below by the browser paths that
  // actually measure.
  //
  // Without this it was a stale artifact that no path ever cleared: delete the
  // entry page and the gate reports "skipped (no detectable artifact)" while
  // last run's healthy profile stays on disk, so the comparison happily reports
  // "no regression" for a project with NO PAGE AT ALL. Same for a browser that
  // failed to launch, or a canvas that was removed. A reading with no way to
  // expire is not a measurement, it is a memory.
  invalidateCapabilityCurrent(projectRoot);
  const type = detectArtifactType(projectRoot);
  if (type === 'web') {
    const web = findWebEntry(projectRoot);
    if (web) {
      const { dir, entry } = web;
      // Classic-script apps: the vm-DOM harness is deterministic and reliably
      // catches crash-class bugs (TDZ / undefined globals / init throws). A
      // headless browser's async error capture is wrapper-dependent and has been
      // observed to MISS uncaught errors (false-pass), so the browser is reserved
      // for ES-module apps the vm harness cannot execute. Tests that inject a
      // browserFactory still exercise the browser path explicitly.
      let isModule = false;
      let hasCanvas = false;
      try {
        const html = readFileSync(join(dir, entry), 'utf-8');
        isModule = /<script[^>]+type=["']module["']/i.test(html);
        hasCanvas = /<canvas\b/i.test(html);
      } catch {
        /* missing entry page — runWeb/vm report it */
      }
      if (opts.browserFactory || isModule) return runWeb(dir, opts, entry, projectRoot);
      // Classic scripts → vm-dom for deterministic JS-crash detection (no browser
      // needed). BUT vm-dom cannot drive requestAnimationFrame, so it passes a
      // <canvas> game whose render loop never runs or FREEZES on Start (the
      // "renders a menu but never actually plays" class — octopus_invaders,
      // 2026-07-24). For a canvas app, after vm-dom's crash check passes, ALSO run
      // the render-loop-liveness probe in a REAL browser; fail-open (unchanged
      // vm-dom verdict) when no browser is available.
      const vm = await runVmDomHarness(dir, undefined, undefined, entry);
      if (!vm.passed || !hasCanvas) return vm;
      // vm-dom returns a skip-PASS for a WebGL page it cannot execute. That
      // pass is not a judgement, so if the browser rung then declines as well
      // the run ends up with no opinion at all reported as success -- which is
      // how a page that painted 0 pixels scored green while the model was told
      // only "33% of gates".
      const declined = vm.via === 'none';
      const liveness = await runCanvasLivenessCheck(dir, opts, entry, declined, projectRoot);
      return liveness ?? vm;
    }
  }
  if (type === 'node' || type === 'cli' || type === 'lib') {
    return runNodeLike(projectRoot, type, opts);
  }
  return {
    passed: true,
    exitCode: 0,
    failureReason: 'skipped (no detectable artifact)',
    outputTail: '',
    durationMs: 0,
    via: 'none',
  };
}

/**
 * Build a GateRung that runs the execution gate via the sibling runner so the
 * synchronous verifier ladder can spawn it like any other rung. Returns null
 * when there is no runnable artifact to gate (caller decides fail-closed).
 */
export function synthesizeExecutionRung(projectRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS): GateRung | null {
  const type = detectArtifactType(projectRoot);
  if (!type) return null;
  // A smoke-run is quick; cap the budget well under a Stop hook's outer timeout
  // so the rung's own timeout fires first (a clean 'timeout' failureReason →
  // fail-open) and the spawned runner can't outlive the caller and orphan.
  const budget = Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) + 15_000;
  return {
    id: 'execution',
    name: `Execution smoke (runs the ${type} artifact)`,
    command: 'node',
    args: [executionRunnerPath(), projectRoot],
    required: true,
    timeoutMs: budget,
    tier: 'runtime',
  };
}
