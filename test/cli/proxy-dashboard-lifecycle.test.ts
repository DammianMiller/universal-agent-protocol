/**
 * Ride-along dashboard: `uap proxy ensure/release` also starts/stops the
 * operational dashboard, so monitoring never needs a second command.
 * Verifies the contract:
 *   - the dashboard is start-or-adopted alongside the proxy, under its OWN
 *     owner marker (the proxy's historical `owner.json` is untouched)
 *   - an adopted dashboard (someone else's `uap dash serve`) is NEVER stopped
 *   - teardown obeys the same refcount rule as the proxy: last client out
 *   - it is skipped entirely when disabled, and when no adapters are supplied
 *     (backwards compatibility with callers that predate the feature)
 *   - settings precedence: env > .uap.json proxy.dashboard > defaults
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureProxy,
  releaseProxy,
  readOwner,
  acquireStartLock,
  releaseStartLock,
  type LifecycleDeps,
  type OwnerRecord,
  type StartResult,
  type ClientRecord,
} from '../../src/cli/proxy-lifecycle.js';
import { resolveDashboardSettings, probeDashHealth } from '../../src/cli/proxy.js';
import { createServer } from 'node:http';
import { startDashboardServer } from '../../src/dashboard/server.js';

const now = () => '2026-07-24T00:00:00Z';
const client = (id: string, pid = process.pid): ClientRecord => ({
  clientId: id,
  pid,
  harness: 'test',
  registeredAt: now(),
});

const DASH_PORT = 3847;
const withDash = { dashboard: { enabled: true, port: DASH_PORT } };

/** Fake side effects for BOTH services with independent up/counter state. */
function fakeDeps(opts: { dashOwnable?: boolean } = {}) {
  const proxy = { up: false, started: 0, stopped: 0 };
  const dash = { up: false, started: 0, stopped: 0 };
  const deps: LifecycleDeps = {
    probeHealth: async () => proxy.up,
    startProxy: async (port): Promise<StartResult> => {
      proxy.started++;
      proxy.up = true;
      return {
        healthy: true,
        owner: { kind: 'process', pid: 111111, startToken: 'p', port, startedAt: now() },
      };
    },
    stopProxy: async () => {
      proxy.stopped++;
      proxy.up = false;
    },
    now,
    probeDashHealth: async () => dash.up,
    startDashboard: async (port): Promise<StartResult> => {
      dash.started++;
      dash.up = true;
      const owner: OwnerRecord | null =
        opts.dashOwnable === false
          ? null
          : { kind: 'process', pid: 222222, startToken: 'd', port, startedAt: now() };
      return { healthy: true, owner };
    },
    stopDashboard: async () => {
      dash.stopped++;
      dash.up = false;
    },
  };
  return { proxy, dash, deps };
}

describe('proxy ride-along dashboard — start / adopt / refcount / release', () => {
  let rt: string;
  beforeEach(() => {
    rt = mkdtempSync(join(tmpdir(), 'uap-proxy-dash-rt-'));
  });
  afterEach(() => rmSync(rt, { recursive: true, force: true }));

  it('starts and owns the dashboard alongside the proxy, under its own marker', async () => {
    const { proxy, dash, deps } = fakeDeps();
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);

    expect(r.action).toBe('started');
    expect(proxy.started).toBe(1);
    expect(dash.started).toBe(1);
    expect(r.dashboard?.action).toBe('started');
    expect(r.dashboard?.port).toBe(DASH_PORT);
    // Separate markers: the proxy keeps the historical filename.
    expect(readOwner(rt)?.pid).toBe(111111);
    expect(readOwner(rt, 'dash')?.pid).toBe(222222);
    expect(existsSync(join(rt, 'owner.json'))).toBe(true);
    expect(existsSync(join(rt, 'owner-dash.json'))).toBe(true);
  });

  it('adopts an already-running dashboard without starting a second or owning it', async () => {
    const { dash, deps } = fakeDeps();
    dash.up = true; // an operator already ran `uap dash serve`
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);

    expect(r.dashboard?.action).toBe('reused');
    expect(dash.started).toBe(0);
    expect(readOwner(rt, 'dash')).toBeNull();
  });

  it('starts the dashboard even when the proxy fails — monitoring matters most when the proxy is down', async () => {
    const { dash, deps } = fakeDeps();
    deps.startProxy = async () => ({ healthy: false, owner: null });
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);

    expect(r.action).toBe('start-failed');
    expect(r.dashboard?.action).toBe('started');
    expect(dash.started).toBe(1);
  });

  it('skips the dashboard when disabled, and when the caller supplies no adapters', async () => {
    const { dash, deps } = fakeDeps();
    const off = await ensureProxy(rt, client('A'), 4000, deps, {
      dashboard: { enabled: false, port: DASH_PORT },
    });
    expect(off.dashboard).toBeUndefined();
    expect(dash.started).toBe(0);

    // A pre-feature caller: no dashboard adapters at all.
    const legacyDeps: LifecycleDeps = {
      probeHealth: deps.probeHealth,
      startProxy: deps.startProxy,
      stopProxy: deps.stopProxy,
      now,
    };
    const legacy = await ensureProxy(rt, client('B'), 4000, legacyDeps, withDash);
    expect(legacy.dashboard).toBeUndefined();
    expect(dash.started).toBe(0);
  });

  it('stops the dashboard with the proxy when the LAST client leaves', async () => {
    const { proxy, dash, deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps, withDash);

    const r = await releaseProxy(rt, 'A', deps);
    expect(r.action).toBe('stopped');
    expect(r.dashboard?.action).toBe('stopped');
    expect(proxy.stopped).toBe(1);
    expect(dash.stopped).toBe(1);
    expect(readOwner(rt, 'dash')).toBeNull();
    expect(readOwner(rt)).toBeNull();
  });

  it('keeps the dashboard running while another live session still holds the proxy', async () => {
    const { dash, deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps, withDash);
    await ensureProxy(rt, client('B'), 4000, deps, withDash); // adopts both

    const r = await releaseProxy(rt, 'A', deps);
    expect(r.action).toBe('left-other-clients');
    expect(r.dashboard?.action).toBe('left-other-clients');
    expect(dash.stopped).toBe(0);
    expect(readOwner(rt, 'dash')?.pid).toBe(222222);
  });

  it('never stops a dashboard we merely adopted, even as the proxy we own goes down', async () => {
    const { dash, proxy, deps } = fakeDeps();
    dash.up = true; // adopted — no owner marker written
    await ensureProxy(rt, client('A'), 4000, deps, withDash);

    const r = await releaseProxy(rt, 'A', deps);
    expect(r.action).toBe('stopped'); // we owned the proxy
    expect(r.dashboard?.action).toBe('left-adopted');
    expect(dash.stopped).toBe(0);
    expect(proxy.stopped).toBe(1);
  });

  it('reports start-failed and claims no ownership when the dashboard will not come up', async () => {
    const { dash, deps } = fakeDeps();
    deps.startDashboard = async () => ({ healthy: false, owner: null });
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);

    expect(r.action).toBe('started'); // the proxy is unaffected
    expect(r.dashboard?.action).toBe('start-failed');
    expect(readOwner(rt, 'dash')).toBeNull();
    expect(existsSync(join(rt, 'owner-dash.json'))).toBe(false);
    expect(dash.stopped).toBe(0);
  });

  it('never lets a throwing dashboard adapter break the proxy (ensure or release)', async () => {
    const { proxy, deps } = fakeDeps();
    deps.startDashboard = async () => {
      throw new Error('spawn exploded');
    };
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);
    expect(r.action).toBe('started');
    expect(r.dashboard?.action).toBe('start-failed');
    expect(readOwner(rt)?.pid).toBe(111111); // proxy still owned

    // Same on the way out: a stop that throws keeps its marker for a later
    // retry and must not prevent the proxy from being released.
    const { deps: deps2 } = fakeDeps();
    await ensureProxy(rt, client('B'), 4000, deps2, withDash);
    await releaseProxy(rt, 'A', deps2); // B is now the last client
    deps2.stopDashboard = async () => {
      throw new Error('kill exploded');
    };
    const rel = await releaseProxy(rt, 'B', deps2);
    expect(rel.dashboard?.action).toBe('stop-failed');
    expect(readOwner(rt, 'dash')).not.toBeNull(); // kept so a retry is possible
    expect(rel.action).toBe('stopped'); // proxy released regardless
    expect(readOwner(rt)).toBeNull();
  });

  it('keeps the two services on independent locks so neither blocks the other', async () => {
    // The whole point of the ServiceName split: a held proxy lock must not
    // serialize (or fail) the dashboard start, and vice versa.
    expect(await acquireStartLock(rt, 100, 'proxy')).toBe(true);
    expect(await acquireStartLock(rt, 100, 'dash')).toBe(true);
    expect(await acquireStartLock(rt, 100, 'proxy')).toBe(false); // still held
    releaseStartLock(rt, 'proxy');
    releaseStartLock(rt, 'dash');
    expect(await acquireStartLock(rt, 100, 'proxy')).toBe(true);
    releaseStartLock(rt, 'proxy');
  });

  it('still reads an owner marker written by an older uap (no service suffix)', async () => {
    // Upgrade path: 'proxy' must keep the historical owner.json filename.
    writeFileSync(
      join(rt, 'owner.json'),
      JSON.stringify({ kind: 'process', pid: 4242, port: 4000, startedAt: now() })
    );
    expect(readOwner(rt)?.pid).toBe(4242);
    expect(readOwner(rt, 'dash')).toBeNull();
  });

  it('does not claim ownership when the dashboard start reports none (systemd-style)', async () => {
    const { dash, deps } = fakeDeps({ dashOwnable: false });
    const r = await ensureProxy(rt, client('A'), 4000, deps, withDash);
    expect(r.dashboard?.action).toBe('started');
    expect(readOwner(rt, 'dash')).toBeNull();

    const rel = await releaseProxy(rt, 'A', deps);
    expect(rel.dashboard?.action).toBe('left-adopted');
    expect(dash.stopped).toBe(0);
  });
});

describe('dashboard adoption probe — /health identifies OUR dashboard', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    try {
      stop?.();
    } catch {
      /* ignore */
    }
    stop = null;
  });

  it('accepts a real dashboard server and reports the project it serves', async () => {
    // The server pins `process.cwd()` at construction and `process.chdir` is
    // unavailable in a vitest worker, so — like every other dashboard test here
    // — this runs against the repo cwd. That is also what makes the root
    // assertions below meaningful.
    let handle!: { close: () => void; readonly port: number };
    // Wait on onListening, not a sleep: `port` is only real once bound.
    const boundPort = await new Promise<number>((resolve) => {
      handle = startDashboardServer({
        port: 0,
        host: '127.0.0.1',
        updateIntervalMs: 3600000,
        onListening: ({ port }) => resolve(port),
      });
    });
    stop = () => handle.close();

    expect(await probeDashHealth(boundPort, 3000)).toBe(true);
    // Project identity: adopted for its own root, refused for another's — this
    // is what stops a session in project B adopting project A's dashboard.
    expect(await probeDashHealth(boundPort, 3000, { root: process.cwd() })).toBe(true);
    expect(await probeDashHealth(boundPort, 3000, { root: '/some/other/project' })).toBe(false);
  });

  it('refuses to adopt a FOREIGN server squatting the dashboard port', async () => {
    // A live socket is not enough: without the service marker we must not hand
    // the operator a URL pointing at someone else's server.
    const foreign = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', r));
    const port = (foreign.address() as { port: number }).port;
    stop = () => foreign.close();

    expect(await probeDashHealth(port, 3000)).toBe(false);
  });

  it('adopts a dashboard from an OLDER uap (no /health) via the served page title', async () => {
    const legacy = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>UAP Dashboard</title></head><body></body></html>');
    });
    await new Promise<void>((r) => legacy.listen(0, '127.0.0.1', r));
    const port = (legacy.address() as { port: number }).port;
    stop = () => legacy.close();

    expect(await probeDashHealth(port, 3000)).toBe(true);
  });

  it('reports down when nothing is listening', async () => {
    // Bind then immediately release a port so we know it is free.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    expect(await probeDashHealth(port, 1000)).toBe(false);
  });
});

describe('resolveDashboardSettings — env > .uap.json > defaults', () => {
  let cwd: string;
  const saved = {
    toggle: process.env.UAP_PROXY_DASHBOARD,
    port: process.env.UAP_DASH_PORT,
    host: process.env.UAP_DASH_HOST,
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-dash-cfg-'));
    delete process.env.UAP_PROXY_DASHBOARD;
    delete process.env.UAP_DASH_PORT;
    delete process.env.UAP_DASH_HOST;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const [k, v] of [
      ['UAP_PROXY_DASHBOARD', saved.toggle],
      ['UAP_DASH_PORT', saved.port],
      ['UAP_DASH_HOST', saved.host],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const writeCfg = (cfg: unknown) =>
    writeFileSync(join(cwd, '.uap.json'), JSON.stringify(cfg), 'utf8');

  it('defaults to ON at :3847 on localhost so monitoring needs no opt-in', () => {
    writeCfg({});
    expect(resolveDashboardSettings(cwd)).toEqual({
      enabled: true,
      port: 3847,
      host: 'localhost',
    });
  });

  it('honours a bare boolean and an object form in .uap.json proxy.dashboard', () => {
    writeCfg({ proxy: { dashboard: false } });
    expect(resolveDashboardSettings(cwd).enabled).toBe(false);

    writeCfg({ proxy: { dashboard: { enabled: true, port: 4111, host: '0.0.0.0' } } });
    expect(resolveDashboardSettings(cwd)).toEqual({
      enabled: true,
      port: 4111,
      host: '0.0.0.0',
    });
  });

  it('falls back to the default port for junk, zero, and out-of-range values', () => {
    // net.connect THROWS synchronously outside 1..65535, which would escape
    // `uap proxy start` as an unhandled rejection — so these must never survive.
    writeCfg({ proxy: { dashboard: { port: 0 } } });
    expect(resolveDashboardSettings(cwd).port).toBe(3847);
    writeCfg({ proxy: { dashboard: { port: 70000 } } });
    expect(resolveDashboardSettings(cwd).port).toBe(3847);

    writeCfg({});
    process.env.UAP_DASH_PORT = 'not-a-port';
    expect(resolveDashboardSettings(cwd).port).toBe(3847);
    process.env.UAP_DASH_PORT = '70000';
    expect(resolveDashboardSettings(cwd).port).toBe(3847);
    process.env.UAP_DASH_PORT = '65535';
    expect(resolveDashboardSettings(cwd).port).toBe(65535);
  });

  it('ignores a malformed proxy.dashboard rather than disabling monitoring', () => {
    writeCfg({ proxy: { dashboard: 'yes' } });
    expect(resolveDashboardSettings(cwd).enabled).toBe(true);
    writeCfg({ proxy: { dashboard: { enabled: 'true' } } });
    expect(resolveDashboardSettings(cwd).enabled).toBe(true);
  });

  it('honours UAP_DASH_HOST', () => {
    writeCfg({});
    process.env.UAP_DASH_HOST = '0.0.0.0';
    expect(resolveDashboardSettings(cwd).host).toBe('0.0.0.0');
  });

  it('lets env override config in both directions', () => {
    writeCfg({ proxy: { dashboard: { enabled: true, port: 4111 } } });
    process.env.UAP_PROXY_DASHBOARD = '0';
    expect(resolveDashboardSettings(cwd).enabled).toBe(false);

    writeCfg({ proxy: { dashboard: false } });
    process.env.UAP_PROXY_DASHBOARD = 'on';
    process.env.UAP_DASH_PORT = '3999';
    const s = resolveDashboardSettings(cwd);
    expect(s.enabled).toBe(true);
    expect(s.port).toBe(3999);
  });
});
