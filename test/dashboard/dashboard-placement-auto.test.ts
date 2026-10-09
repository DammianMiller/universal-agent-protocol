/**
 * POST /api/placement/auto — the dashboard's phase-4 auto-policy surface.
 *
 * Status (no fields) reads the policy; enable/disable toggle; the
 * displacement allowlist requires the same `yes: true` standing-consent gate
 * as `uap models auto --allow-displace --yes` (what is being recorded is
 * standing consent to evict unattended). All mutations ride the token gate.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDashboardServer } from '../../src/dashboard/server.js';

const TOKEN = 'test-token-placement-auto';
let server: { close: () => void } | undefined;
let dir: string;
let prevToken: string | undefined;
let prevPolicyPath: string | undefined;

function boot(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
}

/** token === null means NO token header (a default parameter would fire on
 *  undefined and silently re-attach it). */
async function post(port: number, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/placement/auto`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Uap-Dashboard-Token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/placement/auto (dashboard auto-policy surface)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-dash-auto-'));
    prevToken = process.env.UAP_DASHBOARD_TOKEN;
    process.env.UAP_DASHBOARD_TOKEN = TOKEN;
    // The route takes NO policy_path from the body (security review S1) — it
    // always writes autoPolicyPath(), which honors UAP_PLACEMENT_AUTO. Point
    // it at a temp file so tests never touch the operator's live policy.
    prevPolicyPath = process.env.UAP_PLACEMENT_AUTO;
    process.env.UAP_PLACEMENT_AUTO = join(dir, 'placement-auto.json');
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
    if (prevToken === undefined) delete process.env.UAP_DASHBOARD_TOKEN;
    else process.env.UAP_DASHBOARD_TOKEN = prevToken;
    if (prevPolicyPath === undefined) delete process.env.UAP_PLACEMENT_AUTO;
    else process.env.UAP_PLACEMENT_AUTO = prevPolicyPath;
  });

  it('status with no fields returns the policy shape without writing', async () => {
    const port = await boot();
    const r = await post(port, { });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { enabled: boolean; allow_displace: string[] };
    expect(body).toEqual({ enabled: false, allow_displace: [] });
  }, 20000);

  it('rejects allow_displace without yes: true — standing consent must be explicit', async () => {
    const port = await boot();
    const r = await post(port, { allow_displace: ['qwen35-a3b'] });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('yes: true');
  }, 20000);

  it('allow with yes persists, status reads it back, disallow removes it', async () => {
    const port = await boot();
    const add = await post(port, { allow_displace: ['qwen35-a3b'], yes: true });
    expect(add.status).toBe(200);
    expect((await add.json()) as unknown).toEqual({ enabled: false, allow_displace: ['qwen35-a3b'] });
    // Persisted on disk (the policy file is the single authority, spec §4.4.1)
    expect(JSON.parse(readFileSync(process.env.UAP_PLACEMENT_AUTO as string, 'utf-8'))).toEqual({
      enabled: false,
      allow_displace: ['qwen35-a3b'],
    });
    const status = await post(port, { });
    expect(await status.json()).toEqual({ enabled: false, allow_displace: ['qwen35-a3b'] });
    const rm = await post(port, { disallow_displace: ['qwen35-a3b'] });
    expect(await rm.json()).toEqual({ enabled: false, allow_displace: [] });
  }, 20000);

  it('enable/disable toggle persists; both together are rejected', async () => {
    const port = await boot();
    const both = await post(port, { enable: true, disable: true });
    expect(both.status).toBe(400);
    const on = await post(port, { enable: true });
    expect(await on.json()).toEqual({ enabled: true, allow_displace: [] });
    const off = await post(port, { disable: true });
    expect(await off.json()).toEqual({ enabled: false, allow_displace: [] });
  }, 20000);

  it('requires the mutation token (401 without it)', async () => {
    const port = await boot();
    const r = await post(port, { enable: true }, null);
    expect(r.status).toBe(401);
  }, 20000);
});
