/**
 * Configurable dashboard refresh interval (`uap dash serve --refresh` /
 * UAP_DASH_REFRESH_MS): server-side push cadence, clamping, and injection of
 * the cadence into the served page so the client fallback poll matches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startDashboardServer } from '../src/dashboard/server.js';

const HOST = '127.0.0.1';
const settle = () => new Promise((r) => setTimeout(r, 250));

let handle: { close: () => void } | null = null;

/**
 * Start the dashboard on an OS-assigned port and resolve once it is listening.
 *
 * The previous `let portSeq = 39610; portSeq++` was collision-free *within* a
 * file but not across it: vitest runs test files in separate worker processes,
 * each with its own module instance, so every worker started counting at the
 * same number and raced for the same ports. That surfaced as EADDRINUSE /
 * ECONNREFUSED — and because scripts/version-bump.sh runs the full suite, an
 * unlucky interleaving could fail a release for reasons unrelated to the code.
 *
 * Port 0 removes the guess entirely: the kernel hands out a free port, so no
 * two workers can be assigned the same one. `onListening` is the only reliable
 * way to read it back, since the bound port is not known until the listen
 * callback fires.
 */
function startOnEphemeralPort(
  opts: { updateIntervalMs?: number } = {}
): Promise<{ handle: { close: () => void; readonly port: number }; port: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const h = startDashboardServer({
      ...opts,
      port: 0,
      host: HOST,
      onListening: ({ port }) => {
        if (settled) return;
        settled = true;
        resolve({ handle: h, port });
      },
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { h.close(); } catch { /* ignore */ }
      reject(new Error('dashboard server did not report listening within 10s'));
    }, 10_000).unref?.();
  });
}

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
    const started = await startOnEphemeralPort({ updateIntervalMs: 300 });
    handle = started.handle;
    const port = started.port;
    await settle();
    // In a 4s window a 300ms cadence yields ~12 snapshots even if the first
    // getDashboardData call takes a couple of seconds (cold rtk-gain
    // subprocess); the 2s default would yield at most 2. Require ≥3.
    const count = await countSnapshots(port, 4000);
    expect(count).toBeGreaterThanOrEqual(3);
  }, 20000);

  it('injects the cadence into the served page so the client fallback poll matches', async () => {
    const started = await startOnEphemeralPort({ updateIntervalMs: 700 });
    handle = started.handle;
    const port = started.port;
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).not.toContain('__UAP_DASH_REFRESH_MS__');
    expect(html).toContain("Number('700')");
  }, 20000);

  it('honors UAP_DASH_REFRESH_MS when no explicit option is set', async () => {
    process.env.UAP_DASH_REFRESH_MS = '900';
    const started = await startOnEphemeralPort({});
    handle = started.handle;
    const port = started.port;
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('900')");
  }, 20000);

  it('clamps pathological intervals to the 250ms floor', async () => {
    const started = await startOnEphemeralPort({ updateIntervalMs: 10 });
    handle = started.handle;
    const port = started.port;
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('250')");
  }, 20000);

  it('caps oversized intervals at 1h so setInterval cannot overflow and spin at 1ms', async () => {
    const started = await startOnEphemeralPort({ updateIntervalMs: 9_999_999_999_999 });
    handle = started.handle;
    const port = started.port;
    await settle();
    const html = await fetchBody(port, '/');
    expect(html).toContain("Number('3600000')");
  }, 20000);
});
