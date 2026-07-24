/**
 * `uap proxy` — reference-counted, session-scoped lifecycle for the UAP
 * Anthropic proxy.
 *
 *   uap proxy ensure  [--client <id>] [--client-pid <n>] [--port <n>] [--quiet]
 *       Start the proxy if none is running, or ADOPT an already-running one.
 *       Registers this session as a client. Wired into the SessionStart hook.
 *   uap proxy release [--client <id>] [--quiet]
 *       Deregister this session; stop the proxy ONLY if WE spawned it (as a
 *       plain process) AND no other client remains. systemd/adopted proxies are
 *       never stopped. Wired into the Stop / SessionEnd hook.
 *   uap proxy status [--port <n>] [--json]
 *   uap proxy start | stop | restart          manual controls
 *   uap proxy enable | disable                toggle .uap.json proxy.autostart
 *   uap proxy dashboard [on|off]              toggle/inspect the ride-along dashboard
 *
 * The operational dashboard rides along with the proxy: `ensure`/`start` also
 * start-or-adopt `uap dashboard serve`, and `release`/`stop` tear it down under
 * the same ownership + refcount rules. Operators get monitoring without running
 * a second command. Opt out per project with `uap proxy dashboard off`.
 *
 * Everything is fail-open: hook-driven calls never throw and never block the
 * session — a proxy that won't start just means the agent runs without it.
 *
 * Env overrides (test/advanced):
 *   PROXY_PORT                  default port (4000)
 *   UAP_PROXY_RUNTIME_DIR       registry root (default $XDG_RUNTIME_DIR/uap-proxy)
 *   UAP_PROXY_RUN_SCRIPT        proxy launch script (default: bundled continuity script)
 *   UAP_PROXY_NO_SYSTEMD=1      force the detached-process path (skip systemd)
 *   UAP_PROXY_HEALTH_WAIT_MS    how long to wait for /health after launch (15000)
 *   UAP_PROXY_DASHBOARD=0|1     force the ride-along dashboard off/on (wins over config)
 *   UAP_DASH_PORT               dashboard port (3847)
 *   UAP_DASH_HOST               dashboard bind host (localhost)
 *   UAP_DASH_HEALTH_WAIT_MS     how long to wait for the dashboard to serve (10000)
 */

import chalk from 'chalk';
import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import os from 'os';
import { loadUapConfigRaw, modifyUapConfig } from '../utils/config-loader.js';
import { proxyEnvPath } from './systemd-services.js';
import {
  DEFAULT_PROXY_PORT,
  runtimeDir,
  ensureProxy,
  releaseProxy,
  readOwner,
  clearOwner,
  listClients,
  resolveClientId,
  pidFromClientId,
  isPidAlive,
  type LifecycleDeps,
  type StartResult,
  type OwnerRecord,
  type ClientRecord,
} from './proxy-lifecycle.js';

const PROXY_UNIT = 'uap-anthropic-proxy.service';
/** Matches `uap dashboard serve`'s default port. */
const DEFAULT_DASH_PORT = 3847;

/** Detect the harness driving this session, for diagnostics only. */
function detectHarness(): string {
  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_SESSION_ID) return 'claude';
  if (process.env.FACTORY_PROJECT_DIR) return 'factory';
  if (process.env.CURSOR_PROJECT_DIR) return 'cursor';
  return 'unknown';
}

/** HTTP health probe against the proxy's /health endpoint (fast, fail-closed). */
async function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** The address to TALK to a service bound on `host` (0.0.0.0 isn't dialable). */
function dialHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/**
 * Dashboard liveness probe. Demands positive identification, not merely a live
 * socket: adopting whatever happens to hold :3847 would hand the operator a URL
 * to someone else's server.
 *
 * Accepted signals, cheapest first:
 *   1. `/health` returning our service marker AND serving THIS project. The
 *      dashboard reads every panel from its own cwd, so another project's
 *      dashboard is not ours to adopt or to advertise — the client registry is
 *      per-user, but a dashboard is per-project.
 *   2. the served page titled "UAP Dashboard" — a dashboard started by an OLDER
 *      uap has no `/health`, and misreporting a dashboard the operator is
 *      staring at as "down" is worse than one extra request on the miss path.
 *      Such a dashboard cannot state its project, so it is adopted as-is.
 */
export async function probeDashHealth(
  port: number,
  timeoutMs = 1500,
  opts: { host?: string; root?: string } = {}
): Promise<boolean> {
  const target = dialHost(opts.host ?? 'localhost');
  const fetchText = async (path: string): Promise<string | null> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${target}:${port}${path}`, { signal: controller.signal });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  const health = await fetchText('/health');
  if (health) {
    try {
      const body = JSON.parse(health) as { service?: string; root?: string };
      if (body?.service === 'uap-dashboard') {
        // A dashboard that reports a DIFFERENT project root is somebody else's.
        if (opts.root && body.root && body.root !== opts.root) return false;
        return true;
      }
    } catch {
      /* not our JSON — fall through to the legacy check */
    }
  }
  const rootPage = await fetchText('/');
  return rootPage !== null && /<title>\s*UAP Dashboard\s*<\/title>/i.test(rootPage);
}

/** Is anything listening on `port`? Used to avoid a doomed spawn (and the
 *  health-wait stall that follows it) when a foreign process holds the port. */
function portOccupied(port: number, host = 'localhost', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: net.Socket;
    try {
      sock = net.connect({ host: dialHost(host), port });
    } catch {
      return resolve(false); // e.g. ERR_SOCKET_BAD_PORT — throws synchronously
    }
    const done = (occupied: boolean) => {
      sock.destroy();
      resolve(occupied);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Poll a health probe until up or timeout — used after launching a service. */
async function waitHealthy(
  port: number,
  timeoutMs: number,
  probe: (port: number, timeoutMs?: number) => Promise<boolean> = probeHealth
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, 1200)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

function systemctlAvailable(): boolean {
  try {
    const r = spawnSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    return r.error === undefined || (r.error as NodeJS.ErrnoException).code !== 'ENOENT';
  } catch {
    return false;
  }
}

function unitInstalled(): boolean {
  return existsSync(join(os.homedir(), '.config', 'systemd', 'user', PROXY_UNIT));
}

function unitActive(): boolean {
  try {
    const r = spawnSync('systemctl', ['--user', 'is-active', PROXY_UNIT], {
      encoding: 'utf8',
      timeout: 4000,
    });
    return (r.stdout || '').trim() === 'active';
  } catch {
    return false;
  }
}

/**
 * Opaque process-identity token: the Linux /proc start-time (jiffies since
 * boot, field 22 of /proc/<pid>/stat). Two processes with the same pid but
 * different start-times are different processes — this defends `stopProxy`
 * against PID reuse. Returns undefined off-Linux or if unreadable.
 */
function readStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(')'); // comm may contain spaces/parens
    if (rparen < 0) return undefined;
    const rest = stat.slice(rparen + 2).trim().split(/\s+/);
    return rest[19]; // field 22 (starttime): fields 3.. map to index 0..
  } catch {
    return undefined;
  }
}

/** Parse a systemd EnvironmentFile (KEY=VALUE lines) into an object. */
function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

function resolveRunScript(): string | null {
  const override = process.env.UAP_PROXY_RUN_SCRIPT;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'scripts', 'run-anthropic-proxy-continuity.sh'),
    join(here, '..', '..', '..', 'scripts', 'run-anthropic-proxy-continuity.sh'),
    join(process.cwd(), 'scripts', 'run-anthropic-proxy-continuity.sh'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const HEALTH_WAIT_MS = Number(process.env.UAP_PROXY_HEALTH_WAIT_MS ?? 15000);

/**
 * Launch adapter. Returns {healthy, owner}. `owner` is set ONLY for a plain
 * process WE spawned and confirmed serving — the only kind we ever auto-stop.
 * A systemd unit (persistent infra) is started-if-down but NEVER owned, so
 * `release` never tears down a boot-managed proxy.
 */
async function startProxy(port: number): Promise<StartResult> {
  const now = new Date().toISOString();
  const preferSystemd =
    unitInstalled() && systemctlAvailable() && process.env.UAP_PROXY_NO_SYSTEMD !== '1';

  if (preferSystemd) {
    const already = unitActive();
    if (!already) spawnSync('systemctl', ['--user', 'start', PROXY_UNIT], { timeout: 8000 });
    const healthy = already ? await probeHealth(port) : await waitHealthy(port, HEALTH_WAIT_MS);
    return { healthy, owner: null }; // never own systemd
  }

  const script = resolveRunScript();
  if (!script) return { healthy: false, owner: null };

  const logDir = join(runtimeDir(), 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = openSync(join(logDir, 'proxy.log'), 'a');
  // Parity with the systemd unit: seed the EnvironmentFile (routing sentinel,
  // guardrail thresholds, judge key) so a spawned proxy behaves identically.
  const env = { ...loadEnvFile(proxyEnvPath()), ...process.env, PROXY_PORT: String(port) };
  const child = spawn('bash', [script], { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  const pid = child.pid;
  const startToken = pid ? readStartToken(pid) : undefined;

  const healthy = await waitHealthy(port, HEALTH_WAIT_MS);
  if (!healthy) {
    // Don't accumulate orphaned launches — reap the child we just spawned.
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return { healthy: false, owner: null };
  }
  return { healthy: true, owner: { kind: 'process', pid, startToken, port, startedAt: now } };
}

/** Is the owner pid still the process WE launched (defends against PID reuse
 *  before we kill)? Falls back to "is it still serving" when no token exists. */
async function pidIsOurs(
  owner: OwnerRecord,
  probe: (port: number) => Promise<boolean>
): Promise<boolean> {
  const pid = owner.pid;
  if (!pid || !isPidAlive(pid)) return false;
  const current = readStartToken(pid);
  if (owner.startToken && current) return current === owner.startToken; // definitive
  // No reliable identity token — only signal if the service is still serving.
  return probe(owner.port);
}

/** Identity-checked SIGTERM -> SIGKILL of a process we own. */
async function terminateOwned(
  owner: OwnerRecord,
  probe: (port: number) => Promise<boolean>
): Promise<void> {
  const pid = owner.pid;
  if (!pid || pid <= 0) return;
  if (!(await pidIsOurs(owner, probe))) return; // PID reuse / already gone — do nothing
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // exited cleanly
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/** Stop adapter: systemctl stop, or identity-checked SIGTERM->SIGKILL. */
async function stopProxy(owner: OwnerRecord): Promise<void> {
  if (owner.kind === 'systemd') {
    // Pin the unit name — never let a tampered record stop an arbitrary unit.
    spawnSync('systemctl', ['--user', 'stop', PROXY_UNIT], { timeout: 8000 });
    return;
  }
  await terminateOwned(owner, (p) => probeHealth(p));
}

/** Stop adapter for the ride-along dashboard (always a plain process we spawned). */
async function stopDashboard(owner: OwnerRecord, host = 'localhost'): Promise<void> {
  await terminateOwned(owner, (p) => probeDashHealth(p, 1500, { host }));
}

// ---------------------------------------------------------------------------
// Ride-along dashboard
// ---------------------------------------------------------------------------

export interface DashboardSettings {
  enabled: boolean;
  port: number;
  host: string;
}

/** Ports must be dialable: `net.connect` THROWS synchronously outside 1..65535,
 *  which would escape `uap proxy start` as an unhandled rejection. */
function validPort(n: unknown): number | null {
  const p = Number(n);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

/**
 * Resolve the ride-along dashboard settings.
 * Precedence: env > `.uap.json` proxy.dashboard > defaults (ON, :3847, localhost).
 * `proxy.dashboard` accepts a bare boolean or `{enabled, port, host}`.
 * Default-ON is the point of the feature: monitoring should not require the
 * operator to know a second command exists.
 */
export function resolveDashboardSettings(cwd: string = process.cwd()): DashboardSettings {
  let enabled = true;
  let port = DEFAULT_DASH_PORT;
  let host = 'localhost';

  try {
    const cfg = (loadUapConfigRaw(cwd) as Record<string, unknown>) ?? {};
    const proxy = cfg.proxy as
      | { dashboard?: boolean | { enabled?: boolean; port?: number; host?: string } }
      | undefined;
    const d = proxy?.dashboard;
    if (typeof d === 'boolean') {
      enabled = d;
    } else if (d && typeof d === 'object') {
      if (typeof d.enabled === 'boolean') enabled = d.enabled;
      port = validPort(d.port) ?? port;
      if (typeof d.host === 'string' && d.host.trim()) host = d.host.trim();
    }
  } catch {
    /* defaults */
  }

  const toggle = process.env.UAP_PROXY_DASHBOARD?.trim();
  if (toggle) enabled = !/^(0|off|false|no)$/i.test(toggle);
  port = validPort(process.env.UAP_DASH_PORT) ?? port;
  const envHost = process.env.UAP_DASH_HOST?.trim();
  if (envHost) host = envHost;

  return { enabled, port, host };
}

/** Locate the installed CLI entrypoint so we can re-invoke `dashboard serve`. */
function resolveCliEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/cli
  const candidates = [
    join(here, '..', 'bin', 'cli.js'),
    join(here, '..', '..', 'dist', 'bin', 'cli.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const argv1 = process.argv[1];
  return argv1 && existsSync(argv1) ? argv1 : null;
}

const DASH_HEALTH_WAIT_MS = Number(process.env.UAP_DASH_HEALTH_WAIT_MS ?? 10000);

/**
 * Launch adapter for the dashboard: a detached `uap dashboard serve` we own and
 * therefore may stop. Declines to spawn when a FOREIGN process holds the port —
 * `ensureService` has already established that our own dashboard isn't there, so
 * an occupied port means a doomed bind, and spawning anyway would stall the
 * SessionStart hook for the whole health-wait before failing.
 */
async function startDashboard(port: number, host: string, root: string): Promise<StartResult> {
  const now = new Date().toISOString();
  const entry = resolveCliEntry();
  if (!entry) return { healthy: false, owner: null };
  if (await portOccupied(port, host)) return { healthy: false, owner: null };

  const logDir = join(runtimeDir(), 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  // 0o600: the dashboard's stdout can carry operational detail, and the parent
  // dir's 0700 is not re-applied by mkdirSync when it already exists.
  const out = openSync(join(logDir, 'dashboard.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [entry, 'dashboard', 'serve', '--port', String(port), '--host', host],
      {
        detached: true,
        stdio: ['ignore', out, out],
        // Pin the project explicitly: the dashboard reads every panel from its
        // cwd, and inheriting an ambient one silently serves the wrong project.
        cwd: root,
        // Tells the server not to echo the mutation token into this log file.
        env: { ...process.env, UAP_DASH_RIDE_ALONG: '1' },
      }
    );
  } finally {
    closeSync(out); // the child holds its own dup — don't leak an fd per call
  }
  child.unref();
  const pid = child.pid;
  const startToken = pid ? readStartToken(pid) : undefined;

  const healthy = await waitHealthy(port, DASH_HEALTH_WAIT_MS, (p, t) =>
    probeDashHealth(p, t, { host, root })
  );
  if (!healthy) {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return { healthy: false, owner: null };
  }
  return { healthy: true, owner: { kind: 'process', pid, startToken, port, startedAt: now } };
}

/** Human-facing dashboard URL (0.0.0.0 is not something you can click). */
function dashUrl(host: string, port: number): string {
  return `http://${dialHost(host)}:${port}`;
}

/** Non-loopback binds are reachable off-box — never report that as "localhost"
 *  without saying so (the server's own warning goes to the ride-along log). */
function lanWarning(host: string): string | null {
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return loopback ? null : `bound to ${host} — reachable beyond this machine`;
}

/**
 * Side-effect adapters. The dashboard ones are bound to ONE resolved settings
 * snapshot + project root so the probe, the spawn and the teardown can never
 * disagree about which host/port/project they mean.
 */
function deps(dash?: DashboardSettings, root: string = process.cwd()): LifecycleDeps {
  const d = dash ?? resolveDashboardSettings(root);
  return {
    probeHealth: (p) => probeHealth(p),
    startProxy,
    stopProxy,
    now: () => new Date().toISOString(),
    probeDashHealth: (p) => probeDashHealth(p, 1500, { host: d.host, root }),
    startDashboard: (p) => startDashboard(p, d.host, root),
    stopDashboard: (owner) => stopDashboard(owner, d.host),
  };
}

/** Client record for THIS session. Liveness pid = the long-lived AGENT process
 *  (passed via --client-pid by the hook), NOT the ephemeral CLI/hook process. */
function thisClient(clientId: string, clientPid?: number): ClientRecord {
  let pid = clientPid && clientPid > 0 ? clientPid : 0;
  if (!pid) pid = pidFromClientId(clientId) ?? process.ppid;
  return { clientId, pid, harness: detectHarness(), registeredAt: new Date().toISOString() };
}

/** True when the project opted into hook-driven proxy autostart. */
function isAutostartEnabled(cwd: string = process.cwd()): boolean {
  try {
    const cfg = (loadUapConfigRaw(cwd) as Record<string, unknown>) ?? {};
    const proxy = cfg.proxy as { autostart?: boolean } | undefined;
    return proxy?.autostart === true;
  } catch {
    return false;
  }
}

export interface ProxyOptions {
  client?: string;
  clientPid?: string | number;
  ifEnabled?: boolean;
  port?: string | number;
  quiet?: boolean;
  json?: boolean;
  /** Second positional arg (e.g. `uap proxy dashboard on`). */
  value?: string;
  /** Skip the ride-along dashboard for this invocation (`--no-dashboard`). */
  dashboard?: boolean;
}

export async function proxyCommand(
  sub: string | undefined,
  options: ProxyOptions = {}
): Promise<void> {
  const norm = (sub ?? 'status').toLowerCase();
  const port = Number(options.port ?? DEFAULT_PROXY_PORT) || DEFAULT_PROXY_PORT;
  const rt = runtimeDir();
  const quiet = options.quiet === true;
  const say = (msg: string) => {
    if (!quiet) console.log(msg);
  };

  // Hook-safe gate: when --if-enabled is passed (hooks always pass it), only act
  // if the project opted into proxy autostart (.uap.json proxy.autostart=true).
  if (options.ifEnabled && (norm === 'ensure' || norm === 'release')) {
    if (!isAutostartEnabled()) {
      process.exitCode = 0;
      return;
    }
  }

  const clientPid = options.clientPid !== undefined ? Number(options.clientPid) : undefined;

  // The ride-along dashboard. `--no-dashboard` suppresses STARTING it for this
  // call (commander sets `dashboard:false`); config/env decide otherwise. It
  // never suppresses teardown — we always reap a dashboard we own.
  const root = process.cwd();
  const dash = resolveDashboardSettings(root);
  const wantDashboard = options.dashboard === false ? false : dash.enabled;
  const ensureOpts = { dashboard: { enabled: wantDashboard, port: dash.port } };
  const lifecycle = deps(dash, root);

  /** Report what happened to the ride-along dashboard on ensure/start. */
  const sayDashboard = (r: { action: string; port: number } | undefined): void => {
    if (!r) return;
    const url = dashUrl(dash.host, r.port);
    const lan = lanWarning(dash.host);
    if (r.action === 'reused') say(chalk.dim(`✓ dashboard already running — ${url}`));
    else if (r.action === 'started') {
      say(chalk.green(`✓ dashboard started — ${url}`));
      if (lan) say(chalk.yellow(`  ⚠ ${lan}`));
    } else
      say(
        chalk.yellow(
          `⚠ dashboard could not be started on :${r.port} (port busy, or held by another project's dashboard); run \`uap dash serve\` manually`
        )
      );
  };

  switch (norm) {
    case 'ensure': {
      const clientId = resolveClientId(options.client);
      try {
        const r = await ensureProxy(rt, thisClient(clientId, clientPid), port, lifecycle, ensureOpts);
        if (r.action === 'reused') say(chalk.dim(`✓ proxy already running on :${port} (reused, ${r.clients} client${r.clients === 1 ? '' : 's'})`));
        else if (r.action === 'started') say(chalk.green(`✓ proxy started on :${port}${r.owner ? ` (${r.owner.kind})` : ' (systemd)'}`));
        else say(chalk.yellow(`⚠ proxy could not be started on :${port}; continuing without it`));
        sayDashboard(r.dashboard);
      } catch (e) {
        say(chalk.yellow(`⚠ proxy ensure skipped: ${(e as Error).message}`));
      }
      process.exitCode = 0;
      return;
    }

    case 'release': {
      const clientId = resolveClientId(options.client);
      try {
        const r = await releaseProxy(rt, clientId, lifecycle);
        if (r.action === 'stopped') say(chalk.dim('✓ proxy stopped (last client left)'));
        else if (r.action === 'left-other-clients') say(chalk.dim(`✓ proxy left running (${r.remainingClients} other client${r.remainingClients === 1 ? '' : 's'} active)`));
        else if (r.action === 'left-adopted') say(chalk.dim('✓ proxy left running (not started by uap / systemd-managed)'));
        if (r.dashboard?.action === 'stopped') say(chalk.dim('✓ dashboard stopped (last client left)'));
      } catch (e) {
        say(chalk.yellow(`⚠ proxy release skipped: ${(e as Error).message}`));
      }
      process.exitCode = 0;
      return;
    }

    case 'status': {
      // Project-scoped: a dashboard serving a DIFFERENT root is not this
      // project's, so it is reported as down rather than advertised as yours.
      const [healthy, dashHealthy] = await Promise.all([
        probeHealth(port),
        probeDashHealth(dash.port, 1500, { host: dash.host, root }),
      ]);
      const owner = readOwner(rt);
      const dashOwner = readOwner(rt, 'dash');
      const clients = listClients(rt);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              port,
              healthy,
              systemdActive: unitInstalled() ? unitActive() : false,
              owner,
              adopted: healthy && !owner,
              clients: clients.length,
              clientIds: clients.map((c) => c.clientId),
              dashboard: {
                enabled: dash.enabled,
                port: dash.port,
                host: dash.host,
                url: dashUrl(dash.host, dash.port),
                healthy: dashHealthy,
                owner: dashOwner,
                adopted: dashHealthy && !dashOwner,
              },
            },
            null,
            2
          )
        );
        return;
      }
      console.log(`Proxy (:${port}): ${healthy ? chalk.green('running') : chalk.red('down')}`);
      if (owner) {
        console.log(
          `  owned by uap: ${chalk.cyan(owner.kind)}${owner.pid ? ` (pid ${owner.pid})` : ''} — will stop when the last client leaves`
        );
      } else if (healthy) {
        console.log(chalk.dim('  adopted / systemd-managed (not started by uap) — never auto-stopped'));
      }
      console.log(`  clients: ${chalk.bold(String(clients.length))}${clients.length ? ` (${clients.map((c) => c.clientId).join(', ')})` : ''}`);
      if (unitInstalled()) console.log(chalk.dim(`  systemd unit: ${PROXY_UNIT} ${unitActive() ? 'active' : 'inactive'}`));

      const dashState = dashHealthy
        ? chalk.green('running')
        : dash.enabled
          ? chalk.red('down')
          : chalk.dim('disabled');
      console.log(`Dashboard (:${dash.port}): ${dashState}`);
      if (dashHealthy) {
        console.log(`  ${chalk.cyan(dashUrl(dash.host, dash.port))}`);
        const lan = lanWarning(dash.host);
        if (lan) console.log(chalk.yellow(`  ⚠ ${lan}`));
      }
      if (dashOwner) {
        console.log(
          dashHealthy
            ? `  owned by uap${dashOwner.pid ? ` (pid ${dashOwner.pid})` : ''} — will stop when the last client leaves`
            : // The owner marker is per-user but a dashboard serves one project:
              // this one is alive for somebody else, or gone.
              chalk.dim(
                `  a uap-owned dashboard${dashOwner.pid ? ` (pid ${dashOwner.pid})` : ''} holds :${dash.port} for another project (or has exited)`
              )
        );
      } else if (dashHealthy) {
        console.log(chalk.dim('  adopted (not started by uap) — never auto-stopped'));
      } else if (!dash.enabled) {
        console.log(chalk.dim('  ride-along disabled — enable with `uap proxy dashboard on`'));
      }
      return;
    }

    case 'start': {
      const clientId = resolveClientId(options.client);
      const r = await ensureProxy(rt, thisClient(clientId, clientPid), port, lifecycle, ensureOpts);
      say(
        r.action === 'reused'
          ? chalk.dim(`proxy already running on :${port}`)
          : r.action === 'started'
            ? chalk.green(`proxy started on :${port}`)
            : chalk.yellow(`proxy failed to start on :${port}`)
      );
      sayDashboard(r.dashboard);
      process.exitCode = r.action === 'start-failed' ? 1 : 0;
      return;
    }

    case 'stop': {
      // Tear the dashboard down with the proxy — a manual `stop` is an explicit
      // "shut it all down", so ownership (not the client refcount) is the rule.
      const dashOwner = readOwner(rt, 'dash');
      if (dashOwner) {
        await stopDashboard(dashOwner, dash.host);
        clearOwner(rt, 'dash');
        say(chalk.dim('dashboard stopped'));
      }
      const owner = readOwner(rt);
      if (owner) {
        await stopProxy(owner);
        clearOwner(rt);
        say(chalk.dim('proxy stopped'));
      } else if (unitInstalled() && unitActive()) {
        spawnSync('systemctl', ['--user', 'stop', PROXY_UNIT], { timeout: 8000 });
        say(chalk.dim('proxy (systemd) stopped'));
      } else {
        say(chalk.dim('no uap-managed proxy to stop'));
      }
      return;
    }

    case 'restart': {
      await proxyCommand('stop', { ...options, quiet: true });
      await new Promise((r) => setTimeout(r, 500));
      await proxyCommand('start', options);
      return;
    }

    case 'enable':
    case 'disable': {
      const on = norm === 'enable';
      modifyUapConfig(process.cwd(), (c) => {
        const proxy = { ...((c as Record<string, unknown>).proxy as Record<string, unknown> | undefined) };
        proxy.autostart = on;
        return { ...c, proxy };
      });
      say(
        on
          ? chalk.green('✓ proxy autostart ENABLED — the proxy will start with your session (reference-counted) and stop when the last client leaves.')
          : chalk.yellow('✓ proxy autostart DISABLED — hooks will no longer start/stop the proxy.')
      );
      return;
    }

    case 'dashboard':
    case 'dash': {
      const val = (options.value ?? '').trim().toLowerCase();
      if (!val) {
        const healthy = await probeDashHealth(dash.port, 1500, { host: dash.host, root });
        say(
          `Ride-along dashboard: ${dash.enabled ? chalk.green('enabled') : chalk.yellow('disabled')} — ${healthy ? chalk.green('running') : chalk.dim('not running')} at ${dashUrl(dash.host, dash.port)}`
        );
        say(chalk.dim('  toggle with: uap proxy dashboard on | off'));
        return;
      }
      if (val !== 'on' && val !== 'off') {
        console.error(chalk.red(`Unknown value '${val}'. Use: uap proxy dashboard [on|off]`));
        process.exitCode = 1;
        return;
      }
      const on = val === 'on';
      modifyUapConfig(process.cwd(), (c) => {
        const proxy = { ...((c as Record<string, unknown>).proxy as Record<string, unknown> | undefined) };
        proxy.dashboard = on;
        return { ...c, proxy };
      });
      say(
        on
          ? chalk.green(`✓ ride-along dashboard ENABLED — it will start with the proxy at ${dashUrl(dash.host, dash.port)} and stop when the last client leaves.`)
          : chalk.yellow('✓ ride-along dashboard DISABLED — start it manually with `uap dash serve`.')
      );
      return;
    }

    default:
      console.error(
        chalk.red(`Unknown proxy subcommand '${sub}'. Use: ensure | release | status | start | stop | restart | enable | disable | dashboard`)
      );
      process.exitCode = 1;
  }
}
