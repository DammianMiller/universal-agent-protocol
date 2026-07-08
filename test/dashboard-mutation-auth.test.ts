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
  let server: { close: () => void } | undefined;
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

  const boot = async (): Promise<number> => {
    const port = 3800 + Math.floor((Date.now() % 90));
    server = startDashboardServer({ port, host: '127.0.0.1' });
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
        if (r.status !== 0) return port;
      } catch {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
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
});
