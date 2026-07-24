/**
 * Reference-counted, session-scoped proxy lifecycle.
 *
 * Goal (per product spec): the UAP Anthropic proxy should start when an agent
 * session is triggered (via the SessionStart hook) and exit WITH the agent —
 * but only when it is safe to do so:
 *
 *   - If a proxy is already running, ADOPT it (reuse) — never start a second.
 *   - A proxy we adopted (already up), OR a systemd-managed unit, is NEVER
 *     stopped by us on session end (systemd units are persistent infra).
 *   - A proxy WE spawned as a plain process is reference-counted across
 *     sessions: it is stopped on release only when the LAST client (agent
 *     session) leaves. If any other client is still using it, it keeps running.
 *
 * This module holds the pure decision logic + a tiny file-backed registry so it
 * is unit-testable without spawning a real proxy or touching systemd. The real
 * side effects (spawn / systemctl / HTTP health probe) are injected as `deps`.
 *
 * Liveness note: a client's `pid` MUST be the long-lived AGENT process (the one
 * that spawns SessionStart and SessionEnd), NOT the ephemeral hook/CLI process
 * — otherwise the dead-pid pruning below evicts every live session moments
 * after it registers. The hook passes `$PPID` (the agent) via `--client-pid`.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import os from 'os';

/** Default port the proxy listens on (matches run-anthropic-proxy-continuity.sh). */
export const DEFAULT_PROXY_PORT = Number(process.env.PROXY_PORT ?? 4000);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Runtime root for the client registry + owner marker. Prefer XDG_RUNTIME_DIR
 * (tmpfs at /run/user/<uid>, mode 0700, cleared on logout) and fall back to
 * ~/.cache. Overridable via UAP_PROXY_RUNTIME_DIR for tests.
 */
export function runtimeDir(): string {
  const override = process.env.UAP_PROXY_RUNTIME_DIR;
  if (override) return override;
  const base = process.env.XDG_RUNTIME_DIR || join(os.homedir(), '.cache');
  return join(base, 'uap-proxy');
}

/**
 * Services whose lifecycle `uap proxy` manages. The operational dashboard rides
 * along with the proxy — same registry, same refcount, same ownership rules —
 * so an agent session gets monitoring without a second command to run.
 */
export type ServiceName = 'proxy' | 'dash';

function clientsDir(rt: string): string {
  return join(rt, 'clients');
}
/** 'proxy' keeps the historical filenames so markers written by an older uap
 *  are still honoured across an upgrade; new services are suffixed. */
function ownerPath(rt: string, service: ServiceName = 'proxy'): string {
  return join(rt, service === 'proxy' ? 'owner.json' : `owner-${service}.json`);
}
function lockPath(rt: string, service: ServiceName = 'proxy'): string {
  return join(rt, service === 'proxy' ? 'start.lock' : `start-${service}.lock`);
}

/** How the proxy we own was launched — only 'process' is ever auto-stopped. */
export type OwnerKind = 'process' | 'systemd';

export interface OwnerRecord {
  kind: OwnerKind;
  /** pid of the launched proxy process (kind==='process'). */
  pid?: number;
  /**
   * Opaque process-identity token captured at launch (e.g. /proc start-time).
   * Checked before signaling to defend against PID reuse.
   */
  startToken?: string;
  /** systemd unit name (kind==='systemd'). */
  unit?: string;
  port: number;
  startedAt: string;
}

export interface ClientRecord {
  clientId: string;
  /** pid of the long-lived AGENT process, used to prune dead clients. */
  pid: number;
  harness?: string;
  registeredAt: string;
}

/** Is a pid still alive? `kill(pid, 0)` throws ESRCH when it isn't. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeFilename(clientId: string): string {
  // Registry files are named by client id; keep them filesystem-safe and
  // incapable of escaping the clients dir (no path separators survive).
  return clientId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'anon';
}

/** Derive the agent pid encoded in a `ppid-<n>` fallback client id, if present. */
export function pidFromClientId(clientId: string): number | null {
  const m = /^ppid-(\d+)$/.exec(clientId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Atomic write (tmp + rename) with restrictive mode so a torn read is impossible. */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Math.floor(process.hrtime()[1] % 1e6)}`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  renameSync(tmp, path);
}

/** Register (or refresh) a client in the registry. Idempotent per clientId. */
export function registerClient(rt: string, rec: ClientRecord): void {
  const dir = clientsDir(rt);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  atomicWrite(join(dir, safeFilename(rec.clientId)), JSON.stringify(rec));
}

/** Remove a client from the registry (no-op if absent). */
export function deregisterClient(rt: string, clientId: string): void {
  try {
    rmSync(join(clientsDir(rt), safeFilename(clientId)), { force: true });
  } catch {
    /* best-effort */
  }
}

/** List live clients, pruning any whose AGENT process has died (self-healing). */
export function listClients(rt: string, opts: { prune?: boolean } = {}): ClientRecord[] {
  const dir = clientsDir(rt);
  if (!existsSync(dir)) return [];
  const out: ClientRecord[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name.endsWith('.tmp') || name.includes('.tmp.')) continue; // in-flight write
    const full = join(dir, name);
    let rec: ClientRecord | null = null;
    try {
      rec = JSON.parse(readFileSync(full, 'utf8')) as ClientRecord;
    } catch {
      rec = null;
    }
    if (!rec || typeof rec.clientId !== 'string') {
      if (opts.prune !== false) rmSync(full, { force: true });
      continue;
    }
    // A client whose AGENT process is gone ended without a clean release
    // (crash). Drop it so it never pins the proxy alive forever. pid<=0 means
    // "liveness unknown" — keep it (rely on clean release) rather than evict.
    if (typeof rec.pid === 'number' && rec.pid > 0 && !isPidAlive(rec.pid)) {
      if (opts.prune !== false) rmSync(full, { force: true });
      continue;
    }
    out.push(rec);
  }
  return out;
}

export function readOwner(rt: string, service: ServiceName = 'proxy'): OwnerRecord | null {
  const p = ownerPath(rt, service);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as OwnerRecord;
    if (rec && (rec.kind === 'process' || rec.kind === 'systemd')) return rec;
  } catch {
    /* fall through */
  }
  return null;
}

export function writeOwner(rt: string, rec: OwnerRecord, service: ServiceName = 'proxy'): void {
  mkdirSync(rt, { recursive: true, mode: DIR_MODE });
  atomicWrite(ownerPath(rt, service), JSON.stringify(rec));
}

export function clearOwner(rt: string, service: ServiceName = 'proxy'): void {
  try {
    rmSync(ownerPath(rt, service), { force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Start lock — serialize the probe->start->writeOwner critical section so two
// simultaneous SessionStarts don't both spawn a proxy onto the same port.
// ---------------------------------------------------------------------------
const LOCK_STALE_MS = 30_000;

export async function acquireStartLock(
  rt: string,
  timeoutMs = 5000,
  service: ServiceName = 'proxy'
): Promise<boolean> {
  mkdirSync(rt, { recursive: true, mode: DIR_MODE });
  const p = lockPath(rt, service);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(p); // atomic: succeeds only if it did not exist
      return true;
    } catch {
      // Held. Steal it if it is stale (a crashed holder).
      try {
        const st = statSync(p);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmSync(p, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // vanished between attempts — retry
      }
      if (Date.now() >= deadline) return false; // give up; caller proceeds (fail-open)
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export function releaseStartLock(rt: string, service: ServiceName = 'proxy'): void {
  try {
    rmSync(lockPath(rt, service), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Injected side effects (real impls live in proxy.ts; tests pass fakes).
// ---------------------------------------------------------------------------

/** Outcome of a start attempt. `owner` is set ONLY for a process WE spawned and
 *  confirmed serving — systemd/adopted starts return owner:null (never stopped). */
export interface StartResult {
  healthy: boolean;
  owner: OwnerRecord | null;
}

export interface LifecycleDeps {
  /** Resolve true when the proxy answers a health probe on `port`. */
  probeHealth: (port: number) => Promise<boolean>;
  /** Start the proxy; wait for health; return {healthy, owner}. Owner==null
   *  means "do not claim stoppable ownership" (systemd / failed / adopted). */
  startProxy: (port: number) => Promise<StartResult>;
  /** Stop a proxy WE own (kill pid after identity check). */
  stopProxy: (owner: OwnerRecord) => Promise<void>;
  /** ISO timestamp (injectable for deterministic tests). */
  now: () => string;

  // --- Co-located dashboard (optional). Present only when the caller wants the
  // monitoring UI to ride along with the proxy; all three must be supplied for
  // the dashboard to be managed at all. ---
  /** True when the dashboard answers a health probe on `port`. */
  probeDashHealth?: (port: number) => Promise<boolean>;
  /** Start the dashboard server; same adopt/own contract as `startProxy`. */
  startDashboard?: (port: number) => Promise<StartResult>;
  /** Stop a dashboard WE own. */
  stopDashboard?: (owner: OwnerRecord) => Promise<void>;
}

export type EnsureAction = 'reused' | 'started' | 'start-failed';
export interface ServiceEnsureResult {
  action: EnsureAction;
  port: number;
  owner: OwnerRecord | null;
}
export interface EnsureResult extends ServiceEnsureResult {
  clients: number;
  /** Present only when a dashboard was requested AND adapters were supplied. */
  dashboard?: ServiceEnsureResult;
}

/** Ride-along dashboard request passed to `ensureProxy`. */
export interface DashboardEnsureOptions {
  enabled: boolean;
  port: number;
}
export interface EnsureOptions {
  dashboard?: DashboardEnsureOptions;
}

/**
 * Start-or-adopt one service under its own owner marker + start lock.
 *  - already healthy -> ADOPT (reuse); claim no ownership.
 *  - not healthy -> take the lock, re-probe, start. Claim ownership ONLY if the
 *    adapter returns a stoppable owner (a process we spawned).
 * Never throws: a failed start returns 'start-failed'.
 */
export async function ensureService(
  rt: string,
  service: ServiceName,
  port: number,
  probe: (port: number) => Promise<boolean>,
  start: (port: number) => Promise<StartResult>
): Promise<ServiceEnsureResult> {
  // A throwing adapter must not escape: these run on the SessionStart hook path,
  // where an exception would abort the whole ensure (including the OTHER
  // service) instead of degrading to "running without it".
  const safeProbe = async (p: number): Promise<boolean> => {
    try {
      return await probe(p);
    } catch {
      return false;
    }
  };

  if (await safeProbe(port)) {
    return { action: 'reused', port, owner: readOwner(rt, service) };
  }

  const locked = await acquireStartLock(rt, 5000, service);
  try {
    // Another session may have started it while we waited for the lock.
    if (await safeProbe(port)) {
      return { action: 'reused', port, owner: readOwner(rt, service) };
    }
    let res: StartResult;
    try {
      res = await start(port);
    } catch {
      return { action: 'start-failed', port, owner: null };
    }
    if (!res.healthy) return { action: 'start-failed', port, owner: null };
    // Own ONLY a process we spawned + confirmed. systemd/adopted -> owner null.
    if (res.owner) writeOwner(rt, res.owner, service);
    return { action: 'started', port, owner: res.owner };
  } finally {
    if (locked) releaseStartLock(rt, service);
  }
}

/**
 * Ensure a proxy — and, when requested, the operational dashboard — is
 * available for this client. Both follow the same start-or-adopt contract
 * (see `ensureService`).
 *
 * The dashboard is deliberately ensured even when the proxy failed to start:
 * monitoring is what the operator needs MOST when the proxy is unhealthy, and
 * the two are separate processes with no runtime dependency between them.
 *
 * The two are ensured CONCURRENTLY — they take different locks and write
 * different owner markers, and serializing them would stack two health waits
 * (up to 15s + 10s) inside a SessionStart hook that is killed at 30s. A hook
 * killed mid-wait leaves a spawned service with no owner marker, which nothing
 * would ever reap.
 *
 * Fail-open: a failed start returns 'start-failed' and never throws.
 */
export async function ensureProxy(
  rt: string,
  client: ClientRecord,
  port: number,
  deps: LifecycleDeps,
  opts: EnsureOptions = {}
): Promise<EnsureResult> {
  listClients(rt); // prune dead clients first
  registerClient(rt, client);

  const dash = opts.dashboard;
  const wantDash = Boolean(dash?.enabled && deps.probeDashHealth && deps.startDashboard);

  const [proxy, dashboard] = await Promise.all([
    ensureService(rt, 'proxy', port, deps.probeHealth, deps.startProxy),
    wantDash
      ? ensureService(rt, 'dash', dash!.port, deps.probeDashHealth!, deps.startDashboard!)
      : Promise.resolve(undefined),
  ]);

  return { ...proxy, clients: listClients(rt).length, dashboard };
}

export type ReleaseAction =
  | 'stopped'
  /** We own it and were the last client, but the stop adapter failed. The owner
   *  marker is kept so a later release retries rather than orphaning it. */
  | 'stop-failed'
  | 'left-other-clients'
  | 'left-adopted'
  | 'not-running';
export interface ReleaseResult {
  action: ReleaseAction;
  remainingClients: number;
  /** Present only when dashboard adapters were supplied. */
  dashboard?: { action: ReleaseAction };
}

/**
 * Stop one service iff we own it AND this was the last client. Shared by the
 * proxy and the ride-along dashboard so both obey identical teardown rules.
 */
async function releaseService(
  rt: string,
  service: ServiceName,
  isLastClient: boolean,
  stop: (owner: OwnerRecord) => Promise<void>
): Promise<ReleaseAction> {
  const owner = readOwner(rt, service);
  if (!owner) return 'left-adopted';
  if (!isLastClient) return 'left-other-clients';
  try {
    await stop(owner);
  } catch {
    // A stop that throws must not abort the caller: this client has ALREADY
    // been deregistered, so an escaping error would leave the OTHER service
    // permanently un-releasable (no future release can be "the last client").
    // The owner marker is kept on purpose so a later release can retry the kill.
    return 'stop-failed';
  }
  clearOwner(rt, service);
  return 'stopped';
}

/**
 * Release this client. Stop a service ONLY when:
 *   - we own it (a process WE spawned — owner marker present), AND
 *   - no other client remains after removing this one.
 * Otherwise leave it running:
 *   - 'left-other-clients' — another agent session is still using it.
 *   - 'left-adopted'       — we never owned it (pre-existing / systemd / external).
 *
 * The dashboard is evaluated independently of the proxy: we may own the
 * dashboard while the proxy is systemd-managed (or vice versa), and each is
 * torn down strictly on its own ownership.
 */
export async function releaseProxy(
  rt: string,
  clientId: string,
  deps: LifecycleDeps
): Promise<ReleaseResult> {
  deregisterClient(rt, clientId);
  const remaining = listClients(rt); // prunes dead clients too
  const isLast = remaining.length === 0;

  // Proxy FIRST: it is the service the session actually depends on, and
  // releaseService swallows adapter failures so neither can block the other.
  const action = await releaseService(rt, 'proxy', isLast, deps.stopProxy);

  const stopDash = deps.stopDashboard;
  const dashboard = stopDash
    ? { action: await releaseService(rt, 'dash', isLast, stopDash) }
    : undefined;

  return { action, remainingClients: remaining.length, dashboard };
}

/**
 * Derive a stable client id shared across a session's SessionStart + Stop
 * hooks. Order MATCHES the hook derivation (session-start.sh) so a manual CLI
 * call and the hook agree: explicit flag, then harness session ids, then the
 * parent pid (the agent) — spelled `ppid-<n>` to match the hook.
 */
export function resolveClientId(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.CLAUDE_SESSION_ID,
    process.env.FACTORY_SESSION_ID,
    process.env.CURSOR_SESSION_ID,
    process.env.UAP_SESSION_ID,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return `ppid-${process.ppid}`;
}
