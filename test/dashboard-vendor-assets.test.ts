/**
 * Dashboard offline-readiness: the web assets must ship in the npm package and
 * the server must serve vendored libraries (uPlot) locally so charts work with
 * ZERO external/CDN dependencies. Regression guard for the two bugs that left
 * `uap dash serve` broken on a global install:
 *   1. `web/` was missing from package.json `files` (dashboard.html never shipped)
 *   2. uPlot was loaded only from a CDN (charts blank offline)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboardServer } from '../src/dashboard/server.js';

const ROOT = join(__dirname, '..');

describe('dashboard packaging', () => {
  it('publishes the web/ directory (dashboard.html + vendored assets)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('web');
  });

  it('vendors uPlot locally so charts have no CDN dependency', () => {
    expect(existsSync(join(ROOT, 'web/vendor/uPlot.iife.min.js'))).toBe(true);
    expect(existsSync(join(ROOT, 'web/vendor/uPlot.min.css'))).toBe(true);
    const html = readFileSync(join(ROOT, 'web/dashboard.html'), 'utf-8');
    expect(html).not.toContain('jsdelivr'); // no CDN
    expect(html).toContain('/vendor/uPlot.iife.min.js'); // local reference
  });
});

describe('dashboard server /vendor route', () => {
  let server: { close: () => void } | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const boot = async (): Promise<number> => {
    const port = 3900 + Math.floor((Date.now() % 900));
    server = startDashboardServer({ port, host: '127.0.0.1' });
    // wait for listen
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/vendor/uPlot.min.css`);
        if (r.status !== 0) return port;
      } catch {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    return port;
  };

  it('serves the vendored uPlot JS with a javascript content-type', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/vendor/uPlot.iife.min.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    const body = await r.text();
    expect(body.length).toBeGreaterThan(1000);
  });

  it('blocks path traversal out of the vendor directory', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/vendor/..%2f..%2fpackage.json`);
    expect(r.status).toBe(404);
  });
});
