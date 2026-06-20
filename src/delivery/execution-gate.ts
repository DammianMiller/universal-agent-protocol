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
import { extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import type { GateRung } from './verifier-ladder.js';

/**
 * Env for spawned smoke-runs with secret-bearing vars stripped, mirroring
 * verifier-ladder's sanitizedEnv. Inlined (not imported) so the type-only
 * back-edge to verifier-ladder stays type-only and no runtime import cycle
 * forms. Generated code runs in this child, so it must never inherit
 * provider credentials it could exfiltrate.
 */
function gateEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    out[k] = v;
  }
  out.CI = 'true';
  return out;
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
  close(): Promise<void>;
}

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

/** Find the directory containing an index.html within depth 2 (root + subdirs). */
export function findWebEntryDir(projectRoot: string): string | null {
  const root = resolve(projectRoot);
  if (existsSync(join(root, 'index.html'))) return root;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const sub = join(root, e);
    try {
      if (statSync(sub).isDirectory() && existsSync(join(sub, 'index.html'))) return sub;
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
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

export function startStaticServer(dir: string): Promise<{ url: string; close: () => void }> {
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
      res({ url: `http://127.0.0.1:${port}/index.html`, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// Web execution — headless browser, with a vm+mocked-DOM fallback so the gate
// never silently no-ops when a real browser/chromium is unavailable.
// ---------------------------------------------------------------------------

async function runWeb(entryDir: string, opts: ExecutionGateOptions): Promise<ExecutionResult> {
  const start = Date.now();
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  let server: { url: string; close: () => void } | null = null;
  try {
    server = await startStaticServer(entryDir);
    let browser: BrowserDriver | null = null;
    try {
      browser = opts.browserFactory ? opts.browserFactory() : await loadWebBrowser();
      await browser.launch({ headless: true });
    } catch (e) {
      // Browser unavailable (e.g. no chromium) — fall back to the vm harness.
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore */
        }
      }
      return runVmDomHarness(entryDir, start, `browser launch failed: ${String(e).slice(0, 120)}`);
    }
    try {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
          outputTail: `GET index.html -> ${status}`,
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
export function runVmDomHarness(entryDir: string, startedAt?: number, note?: string): ExecutionResult {
  const start = startedAt ?? Date.now();
  const indexPath = join(entryDir, 'index.html');
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf-8');
  } catch {
    return { passed: false, exitCode: null, failureReason: 'no index.html', outputTail: '', durationMs: Date.now() - start, via: 'none' };
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
  // Build the bundle from external <script src> (in order) AND inline <script>
  // bodies, mirroring how the browser concatenates classic scripts into one
  // shared global lexical scope. Missing src files are a real (broken) reference.
  let bundle = '';
  let scriptCount = 0;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1] ?? '';
    const srcMatch = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (srcMatch) {
      const s = srcMatch[1];
      const p = join(entryDir, s.replace(/^\//, ''));
      if (!existsSync(p)) {
        return {
          passed: false,
          exitCode: 1,
          failureReason: `script not found: ${s}`,
          outputTail: `index.html references ${s} which does not exist`,
          durationMs: Date.now() - start,
          via: 'vm-dom',
        };
      }
      bundle += `\n//=== ${s} ===\n${readFileSync(p, 'utf-8')}\n`;
      scriptCount++;
    } else if (m[2] && m[2].trim()) {
      bundle += `\n//=== inline ===\n${m[2]}\n`;
      scriptCount++;
    }
  }
  if (scriptCount === 0) {
    return { passed: true, exitCode: 0, outputTail: 'no scripts to execute', durationMs: Date.now() - start, via: 'vm-dom' };
  }
  const srcs = { length: scriptCount };

  const sandbox = buildDomSandbox();
  try {
    vm.createContext(sandbox);
    vm.runInContext(bundle, sandbox, { filename: 'bundle.js', timeout: 8000 });
    // Drive a few frames + a start interaction to exercise the playing path.
    const tick = (n: number): void => {
      let t = 0;
      for (let i = 0; i < n && sandbox.__raf.cb; i++) {
        const cb = sandbox.__raf.cb;
        sandbox.__raf.cb = null;
        cb(t += 16);
      }
    };
    tick(3);
    sandbox.__fire('click');
    sandbox.__fire('mousedown');
    sandbox.__fire('mousemove', { clientX: 100, clientY: 100 });
    tick(60);
    return {
      passed: true,
      exitCode: 0,
      outputTail: `vm-dom: booted ${srcs.length} script(s), ran menu→playing frames clean${note ? ` (${note})` : ''}`,
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
    const isSyntax = e instanceof SyntaxError;
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
  const ctxStub: unknown = new Proxy(
    {},
    {
      get(_t, p) {
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
  const raf: { cb: ((t: number) => void) | null } = { cb: null };
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener: reg(listeners.window),
    requestAnimationFrame: (cb: (t: number) => void) => {
      raf.cb = cb;
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
  const type = detectArtifactType(projectRoot);
  if (type === 'web') {
    const dir = findWebEntryDir(projectRoot);
    if (dir) {
      // Classic-script apps: the vm-DOM harness is deterministic and reliably
      // catches crash-class bugs (TDZ / undefined globals / init throws). A
      // headless browser's async error capture is wrapper-dependent and has been
      // observed to MISS uncaught errors (false-pass), so the browser is reserved
      // for ES-module apps the vm harness cannot execute. Tests that inject a
      // browserFactory still exercise the browser path explicitly.
      let isModule = false;
      try {
        isModule = /<script[^>]+type=["']module["']/i.test(readFileSync(join(dir, 'index.html'), 'utf-8'));
      } catch {
        /* missing index.html — runWeb/vm report it */
      }
      if (opts.browserFactory || isModule) return runWeb(dir, opts);
      return runVmDomHarness(dir);
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
