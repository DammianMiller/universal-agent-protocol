/**
 * Client registry — the fleet view's source of truth for which project
 * folders exist and what state they are in.
 *
 * Two sources, merged and deduped by resolved path:
 *   1. Manual entries in `~/.uap/clients.json` (always included, survive
 *      moves of the scan root, may pin a name and a dashboard port).
 *   2. Auto-scan of a root directory (default: the parent of the host
 *      dashboard's cwd). A scanned dir qualifies as a `managed` client when
 *      it contains a real `.uap/` directory; a plain git repo is listed as
 *      `unmanaged` (greyed in the UI, no actions).
 *
 * Dashboard ports are STICKY: a client spawned on port P records P in the
 * registry's `ports` map, so later fleet changes (a new folder sorting
 * earlier) never silently move a live dashboard to a different port —
 * the drift-orphan failure mode the architecture review flagged. Computed
 * ports for never-spawned clients skip ports already taken by explicit
 * assignments.
 *
 * Every read is fail-soft per client: one unreadable folder yields a
 * `degraded` card, never a broken endpoint (the whole point of a fleet
 * view is to keep working while one client is on fire).
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'fs';
import { get as httpGet } from 'http';
import { createServer as netCreateServer } from 'net';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { listRuns } from '../delivery/run-state.js';
import { getTaskData } from './data-service.js';
import { resolveUapBin } from '../utils/resolve-uap-bin.js';

export interface ManualClientEntry {
  path: string;
  name?: string;
  port?: number;
}

export interface ClientsRegistryFile {
  scanRoot?: string;
  ignorePatterns?: string[];
  clients?: ManualClientEntry[];
  /** Sticky dashboard ports, keyed by resolved client path. Written by
   * spawn-on-demand (persistClientPort) so live dashboards never drift. */
  ports?: Record<string, number>;
  /** Pids of dashboards spawned on demand, keyed by resolved client path.
   * Host-owned bookkeeping (the registry file lives in ~/.uap, never inside
   * the client project — the Option B invariant). `uap clients stop` and the
   * tab's Stop action verify ownership before signaling. */
  pids?: Record<string, number>;
  /** /proc/<pid>/stat starttime (field 22) recorded at spawn — the pid's
   * recycling-safe identity. A mismatch at stop time means pid reuse. */
  pidStarts?: Record<string, string>;
}

export interface ClientEntry {
  /** Absolute, resolved project root. */
  path: string;
  name: string;
  /** Has a real `.uap/` directory — a UAP-managed project the dashboard can serve. */
  managed: boolean;
  /** Came from the registry file rather than auto-scan. */
  manual: boolean;
  /** Dashboard port for spawn-on-demand (manual override, sticky map, or computed). */
  port: number;
  /** True when this entry IS the project the host dashboard serves. */
  host: boolean;
}

export interface ClientSummary extends ClientEntry {
  branch: string;
  dirty: number;
  deliver: { running: number; interrupted: number; failed: number; total: number };
  tasks: { open: number; inProgress: number; blocked: number; total: number };
  lastActivity: string | null;
  dashboardAlive: boolean;
  /** Any per-client read failed — card renders with a warning chip. */
  degraded: boolean;
  error?: string;
}

export interface ServeResult {
  port: number;
  pid?: number;
  spawned: boolean;
  alive: boolean;
}

/** First port handed to spawned per-client dashboards (host default is 3847). */
export const CLIENT_BASE_PORT = 3861;

const DEFAULT_IGNORE = [
  'worktrees', '.worktrees', 'node_modules', 'dist', 'build',
  '*bkp*', '*.offline', '*backup*', 'uam-*',
];

const GIT_TTL_MS = 30_000; // branch/dirty don't change faster than 30s (matches data-service)
const gitCache = new Map<string, { branch: string; dirty: number; expiresAt: number }>();

export function registryFilePath(): string {
  return process.env.UAP_CLIENTS_REGISTRY || join(homedir(), '.uap', 'clients.json');
}

function loadRegistryFile(): ClientsRegistryFile {
  try {
    const raw = readFileSync(registryFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as ClientsRegistryFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing/corrupt registry = pure auto-scan (fail-soft)
  }
}

/** Atomic write: random tmp name in the same directory, O_EXCL ('wx') so a
 * pre-planted symlink at the predictable tmp path can't be followed, then
 * rename. Concurrent writers use distinct tmp names (no torn JSON). */
export function saveRegistryFile(reg: ClientsRegistryFile): void {
  const file = registryFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.clients.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { flag: 'wx' });
  renameSync(tmp, file);
}

/** Ignore match: glob patterns ('*' wildcard) or plain substring, against the
 * lowercase basename. Patterns are bounded (length ≤ 64, ≤ 4 asterisks) so
 * a hand-edited pathological pattern can't build a backtracking regex that
 * stalls the unauthenticated fleet read. */
function isIgnored(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((raw) => {
    const pat = raw.toLowerCase();
    if (!pat || pat.length > 64) return false;
    if (pat.includes('*')) {
      if ((pat.match(/\*/g) || []).length > 4) return false;
      const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(lower);
    }
    return lower === pat || lower.includes(pat);
  });
}

function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;
}

/** Coerce a registry-supplied port; NaN/garbage → NaN so callers fall back. */
function coercePort(p: unknown): number {
  const n = typeof p === 'string' ? Number(p) : p;
  return isValidPort(n) ? (n as number) : NaN;
}

export function scanRootFor(hostCwd: string): string {
  const reg = loadRegistryFile();
  if (process.env.UAP_CLIENTS_SCAN_ROOT) return resolve(process.env.UAP_CLIENTS_SCAN_ROOT);
  if (reg.scanRoot) return resolve(reg.scanRoot);
  return dirname(resolve(hostCwd));
}

/** Single managed predicate for discovery, summaries, AND the spawn gate:
 * `.uap` must be a real directory (a stray file named `.uap` is not a client). */
function isManaged(root: string): boolean {
  try {
    return statSync(join(root, '.uap')).isDirectory();
  } catch {
    return false;
  }
}

function isRepo(root: string): boolean {
  return existsSync(join(root, '.git'));
}

/** Merge manual registry entries + auto-scan into one sorted, port-assigned list.
 * Port resolution: valid manual `port` → sticky `ports[path]` map → computed
 * (CLIENT_BASE_PORT+n, skipping ports the first two sources already claimed). */
export function listClients(hostCwd: string): ClientEntry[] {
  const reg = loadRegistryFile();
  const hostResolved = resolve(hostCwd);
  const ignore = reg.ignorePatterns && reg.ignorePatterns.length ? reg.ignorePatterns : DEFAULT_IGNORE;
  const byPath = new Map<string, ClientEntry>();

  const add = (absPath: string, opts: { manual: boolean; name?: string; port?: number }): void => {
    const key = resolve(absPath);
    if (byPath.has(key)) {
      // Manual entry wins over a scan hit for the same folder: keep manual
      // (it may pin name/port) but don't duplicate the card.
      if (opts.manual) {
        const prev = byPath.get(key)!;
        if (isManaged(key)) prev.managed = true;
        prev.manual = true;
        if (opts.name) prev.name = opts.name;
        if (opts.port) prev.port = opts.port;
      }
      return;
    }
    byPath.set(key, {
      path: key,
      name: opts.name || basename(key),
      managed: isManaged(key),
      manual: opts.manual,
      port: opts.port ?? 0, // assigned below
      host: key === hostResolved,
    });
  };

  for (const c of reg.clients ?? []) {
    if (typeof c?.path !== 'string' || !c.path.trim()) continue;
    add(c.path, { manual: true, name: typeof c.name === 'string' ? c.name : undefined, port: coercePort(c.port) });
  }

  const scanRoot = scanRootFor(hostCwd);
  try {
    for (const ent of readdirSync(scanRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (isIgnored(ent.name, ignore)) continue;
      const dir = join(scanRoot, ent.name);
      // Qualify: managed (.uap) always; plain repos listed as unmanaged.
      if (!isManaged(dir) && !isRepo(dir)) continue;
      add(dir, { manual: false });
    }
  } catch {
    /* unreadable scan root → manual entries only */
  }

  const list = [...byPath.values()].filter((c) => existsSync(c.path)).sort((a, b) => a.name.localeCompare(b.name));

  // Resolve ports: manual > sticky map > computed (skipping claimed ports).
  const taken = new Set<number>();
  for (const c of list) {
    if (isValidPort(c.port)) {
      taken.add(c.port);
    } else {
      c.port = 0;
      const sticky = reg.ports?.[c.path];
      if (isValidPort(sticky)) {
        c.port = sticky;
        taken.add(sticky);
      }
    }
  }
  let next = CLIENT_BASE_PORT;
  for (const c of list) {
    if (c.port) continue;
    while (taken.has(next)) next++;
    c.port = next;
    taken.add(next);
  }
  return list;
}

/** Record a sticky port assignment (spawn-on-demand persists the port it used). */
export function persistClientPort(clientPath: string, port: number): void {
  if (!isValidPort(port)) return;
  const reg = loadRegistryFile();
  const ports = { ...(reg.ports ?? {}) };
  ports[resolve(clientPath)] = port;
  saveRegistryFile({ ...reg, ports });
}

/** Record (or, with undefined, clear) the pid of a client's spawned dashboard.
 * `start` is the pid's /proc starttime — recorded when readable so a later
 * stop can refuse a recycled pid by identity, not just liveness.
 *
 * NOTE (security review P3): this is a load-modify-save over the whole
 * registry file with no lock — concurrent serve/stop calls can lose one
 * another's key writes (availability only: a lost pid record makes Stop
 * refuse fail-closed; it can never mis-kill). Single-operator tool. */
export function recordClientPid(clientPath: string, pid: number | undefined, start?: string | null): void {
  const reg = loadRegistryFile();
  const pids = { ...(reg.pids ?? {}) };
  const pidStarts = { ...(reg.pidStarts ?? {}) };
  const key = resolve(clientPath);
  if (pid === undefined) {
    delete pids[key];
    delete pidStarts[key];
  } else {
    pids[key] = pid;
    if (start) pidStarts[key] = start;
    else delete pidStarts[key];
  }
  saveRegistryFile({ ...reg, pids, pidStarts });
}

/** Linux /proc/<pid>/stat starttime (field 22) — a recycling-safe pid
 * identity. Null when /proc is unreadable (non-Linux, permissions, or the
 * process is already gone). */
function readPidStart(pid: number): string | null {
  try {
    // comm (field 2) may contain spaces and parens; everything after the
    // LAST ')' is fields 3.. — starttime is field 22 → index 22-3 = 19.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch {
    return null;
  }
}

/** Registry mutation helpers (CLI `uap clients add/remove`). */
export function addManualClient(hostCwd: string, path: string, opts: { name?: string; port?: number } = {}): ClientEntry {
  const abs = resolve(path);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    /* fall through to the clearer error below */
  }
  if (!isDir) throw new Error(`not a directory: ${abs}`);
  const reg = loadRegistryFile();
  const clients = (reg.clients ?? []).filter((c) => resolve(c.path) !== abs);
  clients.push({ path: abs, name: opts.name, port: opts.port });
  saveRegistryFile({ ...reg, clients });
  return listClients(hostCwd).find((c) => c.path === abs)!;
}

export function removeManualClient(path: string): boolean {
  const reg = loadRegistryFile();
  const abs = resolve(path);
  const before = reg.clients ?? [];
  const after = before.filter((c) => resolve(c.path) !== abs);
  if (after.length === before.length) return false;
  saveRegistryFile({ ...reg, clients: after });
  return true;
}

// ─────────────────────────── per-client reads (fail-soft) ───────────────────────────

function gitInfo(root: string): { branch: string; dirty: number } {
  const now = Date.now();
  const cached = gitCache.get(root);
  if (cached && cached.expiresAt > now) return { branch: cached.branch, dirty: cached.dirty };
  let branch = '?';
  let dirty = 0;
  try {
    branch = execSync('git branch --show-current', { encoding: 'utf-8', cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }).trim() || '?';
    dirty = execSync('git status --porcelain', { encoding: 'utf-8', cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean).length;
  } catch {
    /* not a repo / git failed */
  }
  gitCache.set(root, { branch, dirty, expiresAt: now + GIT_TTL_MS });
  return { branch, dirty };
}

function lastActivity(root: string): string | null {
  let latest = 0;
  for (const rel of ['.uap', join('.uap', 'deliver-runs'), join('agents', 'data', 'memory')]) {
    try {
      const m = statSync(join(root, rel)).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* absent */
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

/** Probe `GET /api/health` on a candidate port; true only when a dashboard
 * that serves `expectedRoot` answers. A wrong-root listener must NOT count
 * as alive, or the UI would link to another client's dashboard. */
export function probeDashboard(port: number, expectedRoot: string): Promise<boolean> {
  return new Promise((ret) => {
    const done = (v: boolean): void => ret(v);
    const req = httpGet(`http://127.0.0.1:${port}/api/health`, { timeout: 400 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as { ok?: boolean; root?: string };
          done(!!(j.ok && resolve(j.root || '') === resolve(expectedRoot)));
        } catch {
          done(false);
        }
      });
      // A response dying mid-body must not hang the fleet Promise.all.
      res.on('error', () => done(false));
      res.on('aborted', () => done(false));
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}

/** First bindable port at or after `start` (loopback). Distinguishes "free"
 * from "occupied by a foreign listener", which a health probe alone cannot. */
export function findFreePort(start: number): Promise<number> {
  return new Promise((ret) => {
    const tryPort = (port: number): void => {
      const srv = netCreateServer();
      srv.once('error', () => { tryPort(port + 1); });
      srv.listen(port, '127.0.0.1', () => { srv.close(() => ret(port)); });
    };
    tryPort(start);
  });
}

/** Fleet summary for every registered client. Concurrent probes; per-client
 * failures degrade that card only. */
export async function getClientSummaries(hostCwd: string, hostPort: number): Promise<ClientSummary[]> {
  const hostResolved = resolve(hostCwd);
  const entries = listClients(hostCwd);
  const summaries = await Promise.all(
    entries.map(async (entry): Promise<ClientSummary> => {
      const s: ClientSummary = {
        ...entry,
        branch: '?',
        dirty: 0,
        deliver: { running: 0, interrupted: 0, failed: 0, total: 0 },
        tasks: { open: 0, inProgress: 0, blocked: 0, total: 0 },
        lastActivity: null,
        dashboardAlive: false,
        degraded: false,
      };
      if (!entry.managed) return s; // unmanaged: no UAP state to read
      // Structural re-check for display: `.uap` may have been swapped for a
      // stray file since discovery — degrade loudly instead of reading zeros.
      if (!isManaged(entry.path)) {
        s.managed = false;
        s.degraded = true;
        s.error = '.uap is not a directory';
        return s;
      }
      try {
        const runs = listRuns(entry.path);
        s.deliver = {
          running: runs.filter((r) => r.status === 'running').length,
          interrupted: runs.filter((r) => r.status === 'interrupted').length,
          failed: runs.filter((r) => r.status === 'failed').length,
          total: runs.length,
        };
      } catch (e) {
        s.degraded = true;
        s.error = `deliver runs unreadable: ${(e as Error).message}`;
      }
      try {
        const t = getTaskData(entry.path);
        s.tasks = { open: t.open ?? 0, inProgress: t.inProgress ?? 0, blocked: t.blocked ?? 0, total: t.total ?? 0 };
      } catch (e) {
        s.degraded = true;
        s.error = s.error ? s.error + '; ' : '';
        s.error += `tasks unreadable: ${(e as Error).message}`;
      }
      Object.assign(s, gitInfo(entry.path));
      s.lastActivity = lastActivity(entry.path);
      // The host project IS this dashboard — probe our own port, not the assigned one.
      s.dashboardAlive = entry.host
        ? await probeDashboard(hostPort, hostResolved)
        : await probeDashboard(entry.port, entry.path);
      return s;
    }),
  );
  return summaries;
}

/**
 * Spawn-on-demand: bring up the client's own dashboard server (full control
 * surface — token-gated, loopback-bound, exactly like `uap dashboard serve`).
 *
 * Registry-only: the caller passes the HOST cwd; the client path is looked
 * up in the registry — the dashboard must never be talked into spawning a
 * process in an arbitrary folder.
 *
 * Ports are sticky: if the assigned port is held by a foreign listener, we
 * fall through to the next bindable port and PERSIST it, so a live
 * dashboard's port never drifts when the fleet list changes.
 *
 * Env is scrubbed of the host's UAP_CLIENTS_* overrides — the child serves
 * ITS OWN folder and must scan its own siblings, not the host's test fixture.
 * UAP_DASHBOARD_TOKEN is deliberately inherited so scripted control of the
 * fleet keeps working (each instance still injects the token into its own
 * same-origin page; sharing it grants no cross-origin read).
 */
export async function ensureClientDashboard(hostCwd: string, clientPath: string): Promise<ServeResult> {
  const resolved = resolve(clientPath);
  const entry = listClients(hostCwd).find((c) => c.path === resolved);
  if (!entry) throw new Error('client not in registry');
  if (!entry.managed) throw new Error('client is not UAP-managed (no .uap directory)');
  if (entry.host) throw new Error('client is served by this dashboard already');

  if (await probeDashboard(entry.port, resolved)) {
    return { port: entry.port, spawned: false, alive: true };
  }

  // Occupied by a foreign listener → next bindable port, persisted (sticky).
  const port = await findFreePort(entry.port);
  if (port !== entry.port) persistClientPort(resolved, port);

  const { cmd, preArgs } = resolveUapBin();
  const childEnv = { ...process.env };
  delete childEnv.UAP_CLIENTS_REGISTRY;
  delete childEnv.UAP_CLIENTS_SCAN_ROOT;
  const child = spawn(cmd, [...preArgs, 'dashboard', 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: resolved,
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  });
  // A missing/renamed bin (the bare-'uap' PATH fallback) emits an async
  // 'error' — without a listener that is an uncaughtException that kills
  // the host dashboard. Swallow it; the health loop below reports dead.
  const spawnFailed = new Promise<boolean>((ret) => child.once('error', () => ret(true)));
  child.unref();
  if (child.pid !== undefined) recordClientPid(resolved, child.pid, readPidStart(child.pid));

  // Wait for the health endpoint so the UI can link straight in.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probeDashboard(port, resolved)) {
      return { port, pid: child.pid, spawned: true, alive: true };
    }
    if (await spawnFailed) break;
  }
  return { port, pid: child.pid, spawned: true, alive: false };
}

export interface StopResult {
  port: number;
  stopped: boolean;
  wasAlive: boolean;
  /** Why a live dashboard could not be stopped (never kill blindly). */
  reason?: string;
}

/**
 * Stop a client's spawned dashboard (the UI Stop action / `uap clients stop`).
 *
 * Never signals on liveness alone. The kill happens only after ALL of:
 * (a) a root-matched live probe on the client's port,
 * (b) the recorded pid is an integer > 1 and still alive,
 * (c) identity pinning — the pid's /proc starttime matches the one recorded
 *     at spawn (a recycled pid is refused by identity, not liveness), and
 * (d) on Linux, `/proc/<pid>/cwd` is the client root.
 * Where /proc is unreadable (non-Linux) the recorded evidence above is what
 * we have — fail-open there, fail-closed on every mismatch.
 */
export async function stopClientDashboard(hostCwd: string, clientPath: string): Promise<StopResult> {
  const resolved = resolve(clientPath);
  const entry = listClients(hostCwd).find((c) => c.path === resolved);
  if (!entry) throw new Error('client not in registry');
  if (entry.host) throw new Error('client is served by this dashboard — stop the server it runs from');
  const reg = loadRegistryFile();
  const pid = reg.pids?.[resolved];

  if (!(await probeDashboard(entry.port, resolved))) {
    if (pid !== undefined) recordClientPid(resolved, undefined); // stale bookkeeping
    return { port: entry.port, stopped: false, wasAlive: false };
  }

  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) {
    return {
      port: entry.port, stopped: false, wasAlive: true,
      reason: `a dashboard answers on :${entry.port} but its pid is not recorded — stop it manually`,
    };
  }
  try {
    process.kill(pid, 0); // ESRCH when recycled/dead; RangeError on garbage → refusal
  } catch {
    recordClientPid(resolved, undefined);
    return {
      port: entry.port, stopped: false, wasAlive: true,
      reason: `recorded pid ${pid} is gone but a dashboard still answers on :${entry.port} — stop it manually`,
    };
  }
  // Identity pinning: same pid, different process (reuse) → refuse.
  const recordedStart = reg.pidStarts?.[resolved];
  const currentStart = readPidStart(pid);
  if (recordedStart && currentStart && recordedStart !== currentStart) {
    return {
      port: entry.port, stopped: false, wasAlive: true,
      reason: `pid ${pid} was recycled (recorded start ${recordedStart} ≠ current ${currentStart}) — refusing to kill`,
    };
  }
  try {
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    if (resolve(procCwd) !== resolved) {
      return {
        port: entry.port, stopped: false, wasAlive: true,
        reason: `pid ${pid} (cwd ${procCwd}) does not belong to this client — refusing to kill`,
      };
    }
  } catch {
    /* /proc unreadable (non-Linux or permission): recorded pid + root-matched probe is our evidence */
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced to exit — the confirmation loop decides */
  }
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await probeDashboard(entry.port, resolved))) {
      recordClientPid(resolved, undefined);
      return { port: entry.port, stopped: true, wasAlive: true };
    }
  }
  return {
    port: entry.port, stopped: false, wasAlive: true,
    reason: `SIGTERM sent to pid ${pid} but the dashboard on :${entry.port} is still answering`,
  };
}
