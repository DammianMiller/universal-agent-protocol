/**
 * The goto() status contract between the browser drivers and the execution
 * gate.
 *
 * runWeb regex-matches a driver's goto() return against ^2\d\d$ to decide
 * "entry did not load". WebBrowser (cloakbrowser) answers with the HTTP
 * status. The playwright driver answered with the URL — so whenever the gate
 * upgraded to it (cloakbrowser without WebGL2, exactly the case the upgrade
 * exists for), the rung failed as `entry did not load (HTTP <url>)` on a page
 * that HAD rendered.
 *
 * Measured 2026-11-28 on voxel-pagoda-basalt-inkling-1: the WebGL swap to
 * playwright fired correctly, the page rendered headlessly (SwiftShader
 * WebGL2, zero console/page errors, animated canvas), and `uap verify` still
 * failed the Execution smoke rung — which then skipped the visual gate, so
 * the client concluded "headless Chrome isn't producing a screenshot (likely
 * no GPU/WebGL in this environment)" and fell back to syntax validation. The
 * environment could render all along; the verdict was a contract violation.
 *
 * These tests pin both halves of the fix: the driver speaks status, and the
 * gate no longer trusts a mute driver over its own static server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { loadPlaywrightDriver } from '../../src/delivery/playwright-driver.js';
import {
  runExecutionGate,
  httpStatusCode,
  type BrowserDriver,
} from '../../src/delivery/execution-gate.js';

/** Browser round-trips: generous for dev, roomier for CI (mirrors the
 * webgl-execution-gate budget note about 4-core runners). */
const TEST_TIMEOUT_MS = process.env.CI ? 300_000 : 120_000;

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}/`);
    });
  });
}

const PAGE = '<html><body><script type="module">window.__loaded = 1;</script></body></html>';

/** Whether a real playwright browser exists on this machine. playwright-core
 * ships without browser binaries, so the package resolving is not evidence a
 * browser exists — a launch failure is a skip, not a test failure. */
let browserOk: boolean | null = null;
async function haveBrowser(): Promise<boolean> {
  if (browserOk !== null) return browserOk;
  const d = await loadPlaywrightDriver().catch(() => null);
  if (!d) return (browserOk = false);
  try {
    await d.launch({ headless: true });
    await d.close();
    return (browserOk = true);
  } catch {
    return (browserOk = false);
  }
}

describe('playwright driver goto() speaks HTTP status', () => {
  it("returns '200' for a served page, not the URL", async () => {
    if (!(await haveBrowser())) return; // no chromium here — nothing to assert
    const url = await listen((_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/html' });
      r.end(PAGE);
    });
    const d = await loadPlaywrightDriver();
    await d!.launch({ headless: true });
    try {
      const status = await d!.goto(url);
      // The URL return was the measured failure: it made runWeb's
      // /^2\d\d$/ test reject a page that had loaded and rendered.
      expect(status).toBe('200');
    } finally {
      await d!.close();
    }
  }, TEST_TIMEOUT_MS);

  it("returns '404' for a missing page — the status is real, not hardcoded", async () => {
    if (!(await haveBrowser())) return;
    const url = await listen((_q, r) => {
      r.writeHead(404, { 'Content-Type': 'text/plain' });
      r.end('nope');
    });
    const d = await loadPlaywrightDriver();
    await d!.launch({ headless: true });
    try {
      expect(await d!.goto(url)).toBe('404');
    } finally {
      await d!.close();
    }
  }, TEST_TIMEOUT_MS);
});

/**
 * A driver whose goto cannot speak status — the exact regression shape: it
 * resolves with the URL. It deliberately has NO evaluate(): canvas liveness
 * only runs when the driver can evaluate, and this contract is about the LOAD
 * verdict alone.
 */
function muteDriver(gotoResult: string): BrowserDriver {
  return {
    launch: async () => undefined,
    goto: async () => gotoResult,
    waitForLoadState: async () => undefined,
    getErrors: () => [],
    close: async () => undefined,
  };
}

describe('the gate does not trust a mute driver over its own server', () => {
  it('passes a served page even when goto resolves with the URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotoct-'));
    try {
      writeFileSync(join(dir, 'index.html'), PAGE);
      const r = await runExecutionGate(dir, {
        entry: 'index.html',
        browserFactory: () => muteDriver('http://127.0.0.1:1/index.html'),
      });
      // The whole point: a driver that cannot report status must not turn a
      // served, error-free page into `entry did not load`.
      expect(r.passed).toBe(true);
      expect(`${r.failureReason ?? ''} ${r.outputTail ?? ''}`).not.toMatch(/did not load/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('httpStatusCode asks the server the driver could not', async () => {
    // Unreachable server → null → the driver's own verdict stands.
    expect(await httpStatusCode('http://127.0.0.1:1/')).toBeNull();
    const ok = await listen((_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/html' });
      r.end(PAGE);
    });
    expect(await httpStatusCode(ok)).toBe('200');
    const missing = await listen((_q, r) => {
      r.writeHead(404, { 'Content-Type': 'text/plain' });
      r.end('nope');
    });
    // A real non-2xx stays a failure — the fallback rescues mute drivers,
    // not broken servers.
    expect(await httpStatusCode(missing)).toBe('404');
  }, TEST_TIMEOUT_MS);
});
