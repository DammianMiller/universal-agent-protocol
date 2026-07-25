/**
 * Web driver — drives a real headless browser with real pointer and key input.
 *
 * Deliberately uses coordinate-level mouse control rather than selector clicks:
 * inside a <canvas> there are no elements to target, so aiming and firing only
 * exist as pointer positions. A gate that can only click selectors cannot play a
 * game, and "cannot play it" is indistinguishable from "it works".
 */

import { join } from 'node:path';
import { startStaticServer } from '../execution-gate.js';
import { buildWatchdogInitScript, watchdogSampleScript } from './watchdog.js';
import { delay, type InteractionDriver, type ReadResult } from './driver.js';
import type { Step } from './types.js';

/** The subset of WebBrowser the driver needs — keeps tests free of a browser. */
export interface PointerBrowser {
  launch(opts?: Record<string, unknown>): Promise<unknown>;
  goto(url: string): Promise<string>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
  addInitScript(script: string): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  screenshot(path: string): Promise<void>;
  getErrors(): Array<{ kind: string; message: string }>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(): Promise<void>;
  mouseUp(): Promise<void>;
  mouseClick(x: number, y: number): Promise<void>;
  press(key: string): Promise<void>;
  viewportSize(): Promise<{ width: number; height: number }>;
  close(): Promise<void>;
}

export interface WebDriverOptions {
  projectRoot: string;
  /** Entry html path relative to the served root (default index.html). */
  entry?: string;
  /** Directory that becomes the server root (default: the project root). */
  webRoot?: string;
  browserFactory?: () => Promise<PointerBrowser>;
  serverFactory?: (dir: string, entry: string) => Promise<{ url: string; close: () => void }>;
}

async function loadRealBrowser(): Promise<PointerBrowser> {
  const mod = await import('../../browser/web-browser.js');
  return new mod.WebBrowser() as unknown as PointerBrowser;
}

export class WebInteractionDriver implements InteractionDriver {
  private browser: PointerBrowser | null = null;
  private server: { url: string; close: () => void } | null = null;
  private readonly opts: WebDriverOptions;
  /** Last pointer position, so `down`/`up` act where the pointer actually is. */
  private pointer = { x: 0, y: 0 };
  private launched = false;
  /** Per-run instrumentation global — see buildWatchdogInitScript. */
  private readonly watchGlobal = `__uapWatch_${Math.random().toString(36).slice(2, 10)}`;

  constructor(opts: WebDriverOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const entry = this.opts.entry ?? 'index.html';
    const root = this.opts.webRoot ?? this.opts.projectRoot;
    const startServer = this.opts.serverFactory ?? startStaticServer;
    this.server = await startServer(root, entry);
    this.browser = this.opts.browserFactory
      ? await this.opts.browserFactory()
      : await loadRealBrowser();
    await this.browser.launch({ headless: true });
    // MUST precede goto: the watchdog wraps requestAnimationFrame before the
    // page's own scripts capture a reference to it.
    await this.browser.addInitScript(buildWatchdogInitScript(this.watchGlobal));
    // Everything above is INFRASTRUCTURE — if it fails the gate has no opinion
    // about the artifact. Everything below is the ARTIFACT failing to load,
    // which is a real defect and must not be laundered into "no browser
    // available, skipping".
    this.launched = true;
    await this.browser.goto(this.server.url);
    await this.browser.waitForLoadState('load');
    const size = await this.browser.viewportSize();
    this.pointer = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
  }

  /** True once the browser is up — distinguishes infra failure from load failure. */
  didLaunch(): boolean {
    return this.launched;
  }

  /** A probe may only navigate within the artifact's own served origin. */
  private sameOrigin(url: string): boolean {
    if (!this.server) return false;
    try {
      return new URL(url, this.server.url).origin === new URL(this.server.url).origin;
    } catch {
      return false;
    }
  }

  async runStep(step: Step): Promise<void> {
    const b = this.browser;
    if (!b) throw new Error('web driver not started');
    switch (step.do) {
      case 'goto':
        if (step.url) {
          // SAME-ORIGIN ONLY. The manifest is model-authored, and an unrestricted
          // goto lets it navigate to `file:///…/.uap/proxy.env` or an attacker
          // host — after which every `read` expression executes in THAT origin
          // and its values flow out through the verdict feedback.
          if (!this.sameOrigin(step.url)) {
            throw new Error(
              `probe tried to navigate off-origin (${step.url}); interaction probes may only drive the artifact under test`
            );
          }
          await b.goto(step.url);
          await b.waitForLoadState('load');
        }
        return;
      case 'wait':
        await delay(step.ms);
        return;
      case 'move':
        this.pointer = { x: step.x, y: step.y };
        await b.mouseMove(step.x, step.y);
        return;
      case 'down':
        await b.mouseDown();
        return;
      case 'up':
        await b.mouseUp();
        return;
      case 'click':
        if (typeof step.x === 'number' && typeof step.y === 'number') {
          this.pointer = { x: step.x, y: step.y };
          await b.mouseClick(step.x, step.y);
        } else if (step.selector) {
          // Selector clicks stay available for DOM UIs (menus, forms).
          await b.evaluate(
            `(function(){var el=document.querySelector(${JSON.stringify(step.selector)});if(el)el.click();return true;})`
          );
        } else {
          await b.mouseClick(this.pointer.x, this.pointer.y);
        }
        return;
      case 'key':
        await b.press(step.key);
        return;
      case 'eval':
        await this.read(step.expr);
        return;
      case 'inject':
        await this.inject(step.expr);
        return;
      case 'repeat': {
        // The RUNNER expands repeat blocks so every adapter gets them; this is a
        // fallback for callers driving the driver directly (e.g. the operator).
        const times = Math.max(0, Math.min(step.times, 10_000));
        for (let i = 0; i < times; i++) {
          for (const inner of step.steps) await this.runStep(inner);
        }
        return;
      }
      default:
        // Unknown step kinds are ignored rather than thrown: a manifest mined by
        // a newer version must not hard-fail an older gate.
        return;
    }
  }

  /**
   * Evaluate an observation. Wrapped in a function so `const`/`let` declared at
   * the top level of a classic script — which live in the global LEXICAL scope
   * and are NOT properties of `window` — are still readable. Reading these
   * through `window.X` returns undefined, which silently turns every assertion
   * into "undefined", so the wrapper matters.
   */
  async read(expr: string): Promise<unknown> {
    return (await this.readDetailed(expr)).value;
  }

  /**
   * `ok: false` means the expression THREW or named something undefined — a
   * broken probe, reported as such rather than as a behavioural failure.
   * `undefined` reached by a resolving expression stays `ok: true`.
   */
  async readDetailed(expr: string): Promise<ReadResult> {
    const b = this.browser;
    if (!b) throw new Error('web driver not started');
    const script = `(function(){try{var v=(${expr});return JSON.stringify({ok:true,v:v===undefined?null:v,u:v===undefined});}catch(e){return JSON.stringify({ok:false,e:String(e)});}})`;
    const raw = await b.evaluate<string>(script);
    try {
      const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as {
        ok: boolean;
        v?: unknown;
        u?: boolean;
        e?: string;
      };
      if (!parsed.ok) return { ok: false, error: parsed.e ?? 'expression threw' };
      // An expression that resolves to `undefined` is almost always a probe
      // naming a member the artifact does not expose (`Particles.particles`
      // against a module that only exports functions), not a real observation.
      if (parsed.u) return { ok: false, error: `${expr} is undefined — the artifact does not expose it` };
      return { ok: true, value: parsed.v };
    } catch {
      return { ok: false, error: 'observation could not be serialised' };
    }
  }

  async inject(expr: string): Promise<void> {
    const b = this.browser;
    if (!b) throw new Error('web driver not started');
    await b.evaluate(`(function(){try{${expr};}catch(e){}return true;})`);
  }

  /**
   * GATING errors only: uncaught page exceptions.
   *
   * `console.error` output and failed sub-resource requests are common in
   * working apps — a missing decorative asset or a handled-and-logged warning
   * would otherwise hard-fail the behavioural gate. Both sibling gates already
   * refuse to gate on them (execution-gate treats them as advisory;
   * visual-gate filters to `pageerror`), and a gate that false-fails working
   * builds gets switched off.
   */
  errors(): string[] {
    try {
      return (this.browser?.getErrors() ?? [])
        .filter((e) => e.kind === 'pageerror')
        .map((e) => `${e.kind}: ${e.message}`);
    } catch {
      return [];
    }
  }

  /** Sample the watchdog under this run's private global name. */
  async watchdogSample(watchExprs: string[]): Promise<unknown> {
    return this.read(`(${watchdogSampleScript(watchExprs, this.watchGlobal)})()`);
  }

  /** Non-gating observations, surfaced in the report as context. */
  advisoryErrors(): string[] {
    try {
      return (this.browser?.getErrors() ?? [])
        .filter((e) => e.kind !== 'pageerror')
        .map((e) => `${e.kind}: ${e.message}`);
    } catch {
      return [];
    }
  }

  async capture(path: string): Promise<void> {
    try {
      await this.browser?.screenshot(path);
    } catch {
      /* evidence capture is best-effort */
    }
  }

  async stop(): Promise<void> {
    // Each teardown independently guarded: a browser left alive leaks a Chromium
    // process per gate pass, which has previously held SIGTERM'd deliver runs
    // open for hours.
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.server = null;
  }
}

/** Where probe evidence (screenshots) is written. */
export function evidenceDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'interaction', 'evidence');
}
