/**
 * Client registry (fleet "Clients" tab source of truth): discovery + merge +
 * dedupe + ignore filtering, fail-soft per-client summaries, dashboard health
 * probe root-matching, and the registry-only rule on spawn-on-demand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';

import {
  addManualClient,
  CLIENT_BASE_PORT,
  findFreePort,
  getClientSummaries,
  listClients,
  persistClientPort,
  probeDashboard,
  registryFilePath,
  removeManualClient,
  saveRegistryFile,
} from '../src/dashboard/client-registry.js';
import { saveRunState, type DeliverRunState } from '../src/delivery/run-state.js';
import { startDashboardServer } from '../src/dashboard/server.js';

let scanRoot = '';
let hostDir = '';
let alpha = '';
let beta = '';
let pinned = '';
let regFile = '';

function fixture(): void {
  scanRoot = mkdtempSync(join(tmpdir(), 'uap-fleet-scan-'));
  hostDir = join(scanRoot, 'host');
  alpha = join(scanRoot, 'alpha');
  beta = join(scanRoot, 'beta');
  // ignored-by-default names exercise the ignore list
  const bkp = join(scanRoot, 'alpha-bkp.1');
  const plain = join(scanRoot, 'gamma-plain');
  pinned = mkdtempSync(join(tmpdir(), 'uap-fleet-pin-'));
  for (const d of [hostDir, alpha, bkp]) mkdirSync(join(d, '.uap'), { recursive: true });
  mkdirSync(join(beta, '.git'), { recursive: true });
  mkdirSync(plain, { recursive: true }); // neither .uap nor .git → excluded
  mkdirSync(join(pinned, '.uap'), { recursive: true });
}

function seedRun(root: string, runId: string, status: DeliverRunState['status']): void {
  const st: DeliverRunState = {
    runId,
    instruction: 'x',
    presetId: 'p',
    projectRoot: root,
    status,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  };
  expect(saveRunState(st)).toBe(true);
}

beforeEach(() => {
  fixture();
  regFile = join(tmpdir(), `uap-clients-reg-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.UAP_CLIENTS_REGISTRY = regFile;
  process.env.UAP_CLIENTS_SCAN_ROOT = scanRoot;
});

afterEach(() => {
  delete process.env.UAP_CLIENTS_REGISTRY;
  delete process.env.UAP_CLIENTS_SCAN_ROOT;
  rmSync(scanRoot, { recursive: true, force: true });
  rmSync(pinned, { recursive: true, force: true });
  try {
    rmSync(regFile, { force: true });
  } catch {
    /* already gone */
  }
});

describe('listClients: discovery, ignore, merge, dedupe', () => {
  it('discovers managed + unmanaged, applies the default ignore list, excludes plain dirs, assigns ports', () => {
    const clients = listClients(hostDir);
    const names = clients.map((c) => c.name);
    expect(names).toEqual(['alpha', 'beta', 'host']); // sorted by name
    expect(clients[0].managed).toBe(true); // alpha (.uap)
    expect(clients[1].managed).toBe(false); // beta (bare git repo → unmanaged)
    expect(clients[2].host).toBe(true); // the host dashboard's own project
    expect(clients.some((c) => c.name === 'alpha-bkp.1')).toBe(false); // *.bkp.* ignored
    expect(clients.some((c) => c.name === 'gamma-plain')).toBe(false); // not a repo
    expect(clients.map((c) => c.port)).toEqual([
      CLIENT_BASE_PORT,
      CLIENT_BASE_PORT + 1,
      CLIENT_BASE_PORT + 2,
    ]);
  });

  it('manual entries merge in, dedupe against scan hits, and win name/port', () => {
    saveRegistryFile({
      clients: [
        { path: alpha, name: 'Alpha Co', port: 3901 }, // same folder as a scan hit
        { path: pinned, name: 'Pinned' }, // outside the scan root
      ],
    });
    const clients = listClients(hostDir);
    expect(clients.map((c) => c.name)).toEqual(['Alpha Co', 'beta', 'host', 'Pinned']);
    const alphaCard = clients[0];
    expect(alphaCard.manual).toBe(true);
    expect(alphaCard.port).toBe(3901);
    expect(alphaCard.name).toBe('Alpha Co'); // manual wins, single card — no dupes
    expect(clients.some((c) => c.path === alpha && c.name === 'alpha')).toBe(false);
    const pinnedCard = clients[3];
    expect(pinnedCard.port).toBe(CLIENT_BASE_PORT + 2); // computed: alpha's manual 3901 claimed no base slot
  });

  it('removeManualClient unpins; a scanned folder survives removal', () => {
    addManualClient(hostDir, pinned, { name: 'Pinned' });
    expect(listClients(hostDir).some((c) => c.name === 'Pinned')).toBe(true);

    expect(removeManualClient(pinned)).toBe(true);
    const after = listClients(hostDir);
    expect(after.some((c) => c.name === 'Pinned')).toBe(false); // outside scan root → gone
    expect(after.some((c) => c.name === 'alpha')).toBe(true); // scanned → still there

    expect(removeManualClient(pinned)).toBe(false); // nothing left to remove
  });

  it('writes the registry to the env-overridden path with manual entries intact', () => {
    addManualClient(hostDir, pinned, { name: 'Pinned', port: 3905 });
    const raw = JSON.parse(readFileSync(registryFilePath(), 'utf-8'));
    expect(raw.clients).toEqual([{ path: pinned, name: 'Pinned', port: 3905 }]);
  });
});

describe('getClientSummaries: fail-soft per-client reads', () => {
  it('aggregates deliver-run counts and queue depth; unreadable client degrades but never breaks the fleet', async () => {
    seedRun(alpha, 'run-live', 'running');
    seedRun(alpha, 'run-dead', 'failed');
    seedRun(alpha, 'run-done', 'delivered');
    // A folder with a stray FILE named `.uap` and no `.git` is not discovered
    // at all (the shared isManaged predicate requires a real directory).
    const stray = join(scanRoot, 'ystray');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, '.uap'), 'not a directory');

    const summaries = await getClientSummaries(hostDir, 1);
    expect(summaries.length).toBe(3); // alpha, beta, host — stray excluded
    expect(summaries.some((c) => c.path === stray)).toBe(false);

    const a = summaries.find((c) => c.path === alpha)!;
    expect(a.deliver).toEqual({ running: 1, interrupted: 0, failed: 1, total: 3 });
    expect(a.tasks).toEqual({ open: 0, inProgress: 0, blocked: 0, total: 0 }); // no task DB → zeros, no throw
    expect(a.degraded).toBe(false);

    const unmanaged = summaries.find((c) => c.path === beta)!;
    expect(unmanaged.managed).toBe(false);
    expect(unmanaged.deliver.total).toBe(0); // unmanaged: no reads attempted

    for (const s of summaries) expect(s.dashboardAlive).toBe(false); // ports free
  }, 15000);
});

describe('stray-file .uap vs the spawn gate', () => {
  it('a git repo whose .uap is a stray file is unmanaged — serve refuses it', async () => {
    const { ensureClientDashboard } = await import('../src/dashboard/client-registry.js');
    const repo = join(scanRoot, 'xstrayrepo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.uap'), 'not a directory');
    const clients = listClients(hostDir);
    const card = clients.find((c) => c.path === repo);
    expect(card?.managed).toBe(false); // discovered (git repo) but not managed
    await expect(ensureClientDashboard(hostDir, repo)).rejects.toThrow('not UAP-managed');
  });
});

describe('probeDashboard: root-matched liveness', () => {
  it('is alive only when the answering dashboard serves the expected root', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'uap-dashboard', root: alpha }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(probeDashboard(port, alpha)).resolves.toBe(true); // right root
      await expect(probeDashboard(port, beta)).resolves.toBe(false); // wrong root ≠ alive
      await expect(probeDashboard(port + 1, alpha)).resolves.toBe(false); // nothing listening
    } finally {
      srv.close();
    }
  });
});

describe('ensureClientDashboard: registry-only spawn rule', () => {
  it('refuses to spawn for a path that is not in the registry', async () => {
    const { ensureClientDashboard } = await import('../src/dashboard/client-registry.js');
    const rogue = mkdtempSync(join(tmpdir(), 'uap-rogue-'));
    try {
      await expect(ensureClientDashboard(hostDir, rogue)).rejects.toThrow('client not in registry');
    } finally {
      rmSync(rogue, { recursive: true, force: true });
    }
  });

  it('refuses unmanaged clients and the host itself', async () => {
    const { ensureClientDashboard } = await import('../src/dashboard/client-registry.js');
    await expect(ensureClientDashboard(hostDir, beta)).rejects.toThrow('not UAP-managed');
    await expect(ensureClientDashboard(hostDir, hostDir)).rejects.toThrow('served by this dashboard');
  });

  it('survives a missing uap binary: spawn error is swallowed, result is alive:false', async () => {
    const { ensureClientDashboard } = await import('../src/dashboard/client-registry.js');
    process.env.UAP_BIN = '/nonexistent/uap-fleet-spawn-test';
    try {
      const res = await ensureClientDashboard(hostDir, alpha);
      expect(res.spawned).toBe(true);
      expect(res.alive).toBe(false);
      // The sticky-port write must not have happened for a dead spawn attempt.
      expect(listClients(hostDir).find((c) => c.path === alpha)!.port).toBe(CLIENT_BASE_PORT);
    } finally {
      delete process.env.UAP_BIN;
    }
  }, 15000);
});

describe('port stickiness (registry ports map)', () => {
  it('honors sticky ports and computes around them (no collisions with claimed ports)', () => {
    saveRegistryFile({ ports: { [alpha]: 3870 } });
    const clients = listClients(hostDir);
    const a = clients.find((c) => c.path === alpha)!;
    expect(a.port).toBe(3870); // sticky beats computed
    const others = clients.filter((c) => c.path !== alpha).map((c) => c.port);
    expect(others).not.toContain(3870); // computed assignments skip claimed ports
    expect(clients.map((c) => c.port)).toEqual([...new Set(clients.map((c) => c.port))]); // unique
  });

  it('persistClientPort writes the sticky map and listClients reflects it', () => {
    persistClientPort(alpha, 3911);
    const raw = JSON.parse(readFileSync(registryFilePath(), 'utf-8')) as { ports: Record<string, number> };
    expect(raw.ports[alpha]).toBe(3911);
    expect(listClients(hostDir).find((c) => c.path === alpha)!.port).toBe(3911);
  });

  it('invalid manual ports fall back to computed assignment', () => {
    saveRegistryFile({
      clients: [
        { path: alpha, name: 'Alpha Co', port: 80 as unknown as number }, // out of range
        { path: beta, name: 'Beta Co', port: 'not-a-number' as unknown as number }, // garbage string
      ],
    });
    const clients = listClients(hostDir);
    for (const c of clients) {
      expect(Number.isInteger(c.port)).toBe(true);
      expect(c.port).toBeGreaterThanOrEqual(1024);
    }
    expect(new Set(clients.map((c) => c.port)).size).toBe(clients.length); // still unique
  });
});

describe('findFreePort', () => {
  it('skips an occupied port and returns a bindable one', async () => {
    const srv = createServer((_req, res) => { res.end('busy'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const busy = (srv.address() as { port: number }).port;
    try {
      const port = await findFreePort(busy);
      expect(port).toBeGreaterThan(busy); // moved past the occupied port
      expect(Number.isInteger(port)).toBe(true);
    } finally {
      srv.close();
    }
  });
});

describe('registry hardening', () => {
  it('addManualClient refuses files (a pinned file would render as a zombie card)', () => {
    const filePath = join(scanRoot, 'not-a-dir');
    writeFileSync(filePath, 'file content');
    expect(() => addManualClient(hostDir, filePath)).toThrow('not a directory');
  });

  it('registry ignorePatterns replace the defaults when present', () => {
    saveRegistryFile({ ignorePatterns: ['*'] });
    expect(listClients(hostDir)).toEqual([]); // everything scanned is ignored…
    saveRegistryFile({ ignorePatterns: ['*'], clients: [{ path: pinned, name: 'Pinned' }] });
    expect(listClients(hostDir).map((c) => c.name)).toEqual(['Pinned']); // …manual entries survive
  });
});

describe('fleet routes behind the dashboard server', () => {
  it('GET /api/clients is open; POST /api/clients* is token-gated; serve rejects unregistered paths', async () => {
    process.env.UAP_DASHBOARD_TOKEN = 'fleet-test-token';
    let server: { close: () => void } | undefined;
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server = startDashboardServer({
          port: 0,
          host: '127.0.0.1',
          onListening: ({ port: p }) => resolve(p),
        });
        setTimeout(() => reject(new Error('server never listened')), 10000);
      });

      const read = await fetch(`http://127.0.0.1:${port}/api/clients`);
      expect(read.status).toBe(200);
      const body = (await read.json()) as { clients: unknown[] };
      expect(Array.isArray(body.clients)).toBe(true);

      // No token → 401 (both the exact-URL POST and the serve route).
      const anonPost = await fetch(`http://127.0.0.1:${port}/api/clients`, { method: 'POST' });
      expect(anonPost.status).toBe(401);
      const anonServe = await fetch(`http://127.0.0.1:${port}/api/clients/serve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/etc' }),
      });
      expect(anonServe.status).toBe(401);

      // With the token, an unregistered path is rejected — never spawned.
      const authed = await fetch(`http://127.0.0.1:${port}/api/clients/serve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Uap-Dashboard-Token': 'fleet-test-token' },
        body: JSON.stringify({ path: '/etc' }),
      });
      expect(authed.status).toBe(400);
      expect(((await authed.json()) as { error: string }).error).toContain('client not in registry');
    } finally {
      delete process.env.UAP_DASHBOARD_TOKEN;
      server?.close();
    }
  }, 20000);
});
