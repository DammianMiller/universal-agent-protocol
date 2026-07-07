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
 */

import chalk from 'chalk';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

/** Poll health until up or timeout — used after launching the proxy. */
async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(port, 1200)) return true;
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

/** Is the owner pid still OUR proxy (defends against PID reuse before we kill)? */
async function pidIsOurProxy(owner: OwnerRecord): Promise<boolean> {
  const pid = owner.pid;
  if (!pid || !isPidAlive(pid)) return false;
  const current = readStartToken(pid);
  if (owner.startToken && current) return current === owner.startToken; // definitive
  // No reliable identity token — only signal if the proxy is still serving.
  return probeHealth(owner.port);
}

/** Stop adapter: systemctl stop, or identity-checked SIGTERM->SIGKILL. */
async function stopProxy(owner: OwnerRecord): Promise<void> {
  if (owner.kind === 'systemd') {
    // Pin the unit name — never let a tampered record stop an arbitrary unit.
    spawnSync('systemctl', ['--user', 'stop', PROXY_UNIT], { timeout: 8000 });
    return;
  }
  const pid = owner.pid;
  if (!pid || pid <= 0) return;
  if (!(await pidIsOurProxy(owner))) return; // PID reuse / already gone — do nothing
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

function deps(): LifecycleDeps {
  return { probeHealth: (p) => probeHealth(p), startProxy, stopProxy, now: () => new Date().toISOString() };
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

  switch (norm) {
    case 'ensure': {
      const clientId = resolveClientId(options.client);
      try {
        const r = await ensureProxy(rt, thisClient(clientId, clientPid), port, deps());
        if (r.action === 'reused') say(chalk.dim(`✓ proxy already running on :${port} (reused, ${r.clients} client${r.clients === 1 ? '' : 's'})`));
        else if (r.action === 'started') say(chalk.green(`✓ proxy started on :${port}${r.owner ? ` (${r.owner.kind})` : ' (systemd)'}`));
        else say(chalk.yellow(`⚠ proxy could not be started on :${port}; continuing without it`));
      } catch (e) {
        say(chalk.yellow(`⚠ proxy ensure skipped: ${(e as Error).message}`));
      }
      process.exitCode = 0;
      return;
    }

    case 'release': {
      const clientId = resolveClientId(options.client);
      try {
        const r = await releaseProxy(rt, clientId, deps());
        if (r.action === 'stopped') say(chalk.dim('✓ proxy stopped (last client left)'));
        else if (r.action === 'left-other-clients') say(chalk.dim(`✓ proxy left running (${r.remainingClients} other client${r.remainingClients === 1 ? '' : 's'} active)`));
        else if (r.action === 'left-adopted') say(chalk.dim('✓ proxy left running (not started by uap / systemd-managed)'));
      } catch (e) {
        say(chalk.yellow(`⚠ proxy release skipped: ${(e as Error).message}`));
      }
      process.exitCode = 0;
      return;
    }

    case 'status': {
      const healthy = await probeHealth(port);
      const owner = readOwner(rt);
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
      return;
    }

    case 'start': {
      const clientId = resolveClientId(options.client);
      const r = await ensureProxy(rt, thisClient(clientId, clientPid), port, deps());
      say(
        r.action === 'reused'
          ? chalk.dim(`proxy already running on :${port}`)
          : r.action === 'started'
            ? chalk.green(`proxy started on :${port}`)
            : chalk.yellow(`proxy failed to start on :${port}`)
      );
      process.exitCode = r.action === 'start-failed' ? 1 : 0;
      return;
    }

    case 'stop': {
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

    default:
      console.error(
        chalk.red(`Unknown proxy subcommand '${sub}'. Use: ensure | release | status | start | stop | restart | enable | disable`)
      );
      process.exitCode = 1;
  }
}
