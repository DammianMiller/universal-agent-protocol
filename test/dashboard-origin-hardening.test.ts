/**
 * Origin hardening for the always-on dashboard.
 *
 * The dashboard now rides along with `uap proxy` and is up for the whole agent
 * session rather than only while an operator runs `uap dash serve` by hand, so
 * two long-standing cross-origin holes had to close first:
 *
 *   1. `Access-Control-Allow-Origin: *` was set on EVERY response before
 *      routing — including the page that carries the policy-mutation token
 *      inline. Any page the operator visited could read `/`, scrape the token,
 *      and then drive every mutation route (policy toggles, deliver launches).
 *      The token control's own comment claimed CORS prevented this; it did not.
 *   2. WebSocket upgrades are exempt from both SOP and CORS, so any page could
 *      open ws://localhost:3847 and receive the full dashboard snapshot every
 *      tick (tasks, agents, model usage and cost).
 *
 * API reads stay open on purpose — they are localhost, read-only, and carry no
 * credential.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startDashboardServer } from '../src/dashboard/server.js';

const HOST = '127.0.0.1';

let handle: { close: () => void; readonly port: number } | null = null;
afterEach(() => {
  try {
    handle?.close();
  } catch {
    /* ignore */
  }
  handle = null;
});

/** Start a server and resolve once it is really bound. */
function serve(): Promise<number> {
  return new Promise((resolve) => {
    handle = startDashboardServer({
      port: 0,
      host: HOST,
      updateIntervalMs: 3_600_000,
      onListening: ({ port }) => resolve(port),
    });
  });
}

describe('dashboard origin hardening', () => {
  it('does not expose the token-bearing page to cross-origin readers', async () => {
    const port = await serve();
    const res = await fetch(`http://${HOST}:${port}/`);
    expect(res.status).toBe(200);
    // No CORS grant on the page: a foreign origin's fetch is blocked by the
    // browser, so the inlined mutation token stays unreadable.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still allows cross-origin API reads (no credential in them)', async () => {
    const port = await serve();
    const res = await fetch(`http://${HOST}:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects a WebSocket upgrade from a foreign origin, accepts a same-origin one', async () => {
    const port = await serve();
    const url = `ws://${HOST}:${port}`;

    const connect = (origin?: string): Promise<'open' | 'rejected'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, origin ? { origin } : undefined);
        const done = (r: 'open' | 'rejected') => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(r);
        };
        ws.on('open', () => done('open'));
        ws.on('error', () => done('rejected'));
        setTimeout(() => done('rejected'), 4000);
      });

    expect(await connect('http://evil.example')).toBe('rejected');
    expect(await connect(`http://${HOST}:${port}`)).toBe('open');
    // Non-browser clients (CLI, curl, tests) send no Origin and keep working.
    expect(await connect()).toBe('open');
  });
});
