/**
 * Dashboard mutation auth (security audit D1): the policy-mutation POST routes
 * disable/persist security controls, so they must reject a request without the
 * per-session token — otherwise any LAN host or cross-site page could neutralize
 * delivery-enforcement / self-protect. Read routes stay open.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startDashboardServer } from '../src/dashboard/server.js';

const TOKEN = 'test-dashboard-token-fixed';

describe('dashboard policy-mutation auth', () => {
  let server: { close: () => void; readonly port: number } | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.UAP_DASHBOARD_TOKEN;
    process.env.UAP_DASHBOARD_TOKEN = TOKEN; // deterministic token for the test
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    if (prevToken === undefined) delete process.env.UAP_DASHBOARD_TOKEN;
    else process.env.UAP_DASHBOARD_TOKEN = prevToken;
  });

  // Bind an OS-assigned ephemeral port (port: 0) and learn the real port from
  // `onListening`. The old approach hard-coded `3800 + Date.now()%90`, which
  // collided ~1/90 with a locally running `uap dash serve` on :3847 → EADDRINUSE.
  const boot = async (): Promise<number> => {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dashboard server never listened')), 5000);
      server = startDashboardServer({
        port: 0,
        host: '127.0.0.1',
        onListening: ({ port }) => {
          clearTimeout(timer);
          resolve(port);
        },
      });
    });
    return port;
  };

  it('rejects a policy toggle with NO token (401), before touching the DB', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/policy/any-id/toggle`, { method: 'POST' });
    expect(r.status).toBe(401);
  }, 20000);

  it('rejects a policy toggle with the WRONG token (401)', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/policy/any-id/toggle`, {
      method: 'POST',
      headers: { 'X-Uap-Dashboard-Token': 'wrong' },
    });
    expect(r.status).toBe(401);
  }, 20000);

  it('also gates /stage and /level', async () => {
    const port = await boot();
    for (const route of ['stage', 'level']) {
      const r = await fetch(`http://127.0.0.1:${port}/api/policy/any-id/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [route]: 'x' }),
      });
      expect(r.status, `${route} without token`).toBe(401);
    }
  }, 20000);

  it('lets a correct token THROUGH the auth gate (past 401 — 404 for a missing policy)', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/policy/definitely-not-a-real-policy/toggle`, {
      method: 'POST',
      headers: { 'X-Uap-Dashboard-Token': TOKEN },
    });
    // Auth passed → handler ran → 404 (policy doesn't exist), NOT 401.
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(404);
  }, 20000);

  it('read routes stay open (no token needed for GET /api/dashboard)', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    expect(r.status).toBe(200);
  }, 20000);

  // Behaviour added to kill the flaky-port collision: port 0 → real ephemeral port.
  it('port 0 binds an OS-assigned ephemeral port (not the 3847 default)', async () => {
    const port = await boot();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(3847);
    expect(port).not.toBe(0);
  }, 20000);

  it('the returned handle exposes the actual bound port', async () => {
    const port = await boot();
    expect(server?.port).toBe(port);
    // And that port is really serving.
    const r = await fetch(`http://127.0.0.1:${server?.port}/api/dashboard`);
    expect(r.status).toBe(200);
  }, 20000);
});
