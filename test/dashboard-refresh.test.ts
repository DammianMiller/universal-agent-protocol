/**
 * Configurable dashboard refresh interval (`uap dash serve --refresh` /
 * UAP_DASH_REFRESH_MS): server-side push cadence, clamping, and injection of
 * the cadence into the served page so the client fallback poll matches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startDashboardServer } from '../src/dashboard/server.js';

let portSeq = 39610;
const HOST = '127.0.0.1';
const settle = () => new Promise((r) => setTimeout(r, 250));

let handle: { close: () => void } | null = null;
afterEach(() => {
  try {
    handle?.close();
  } catch {
    /* ignore */
  }
  handle = null;
  delete process.env.UAP_DASH_REFRESH_MS;
});

function fetchBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c.toString()));
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('request timeout')), 4000);
  });
}

/** Count COMPLETE `snapshot` SSE frames received within `windowMs`. */
function countSnapshots(port: number, windowMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path: '/api/events' }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c.toString()));
      setTimeout(() => {
        req.destroy();
        // Drop the trailing partial frame — only blank-line-terminated frames
        // are complete (large snapshots span multiple TCP chunks).
        const frames = buf.split('\n\n');
        frames.pop();
        resolve(frames.filter((f) => f.includes('event: snapshot')).length);
      }, windowMs);
      res.on('error', () => {
        /* stream teardown */
      });
    });
    req.on('error', reject);
  });
}

describe('dashboard refresh interval', () => {
  it('pushes SSE snapshots at the configured cadence, not the 2s default', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 300 });
    await settle();
    // In a 4s window a 300ms cadence yields ~12 snapshots even if the first
    // getDashboardData call takes a couple of seconds (cold rtk-gain
    // subprocess); the 2s default would yield at most 2. Require ≥3.
    const count = await countSnapshots(port, 4000);
    expect(count).toBeGreaterThanOrEqual(3);
  }, 20000);

  it('injects the cadence into the served page so the client fallback poll matches', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 700 });
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).not.toContain('__UAP_DASH_REFRESH_MS__');
    expect(html).toContain("Number('700')");
  }, 20000);

  it('honors UAP_DASH_REFRESH_MS when no explicit option is set', async () => {
    process.env.UAP_DASH_REFRESH_MS = '900';
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST });
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('900')");
  }, 20000);

  it('clamps pathological intervals to the 250ms floor', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 10 });
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('250')");
  }, 20000);

  it('caps oversized intervals at 1h so setInterval cannot overflow and spin at 1ms', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 9_999_999_999_999 });
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('3600000')");
  }, 20000);
});
