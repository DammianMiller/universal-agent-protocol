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

function clientsDir(rt: string): string {
  return join(rt, 'clients');
}
function ownerPath(rt: string): string {
  return join(rt, 'owner.json');
}
function lockPath(rt: string): string {
  return join(rt, 'start.lock');
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

export function readOwner(rt: string): OwnerRecord | null {
  const p = ownerPath(rt);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as OwnerRecord;
    if (rec && (rec.kind === 'process' || rec.kind === 'systemd')) return rec;
  } catch {
    /* fall through */
  }
  return null;
}

export function writeOwner(rt: string, rec: OwnerRecord): void {
  mkdirSync(rt, { recursive: true, mode: DIR_MODE });
  atomicWrite(ownerPath(rt), JSON.stringify(rec));
}

export function clearOwner(rt: string): void {
  try {
    rmSync(ownerPath(rt), { force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Start lock — serialize the probe->start->writeOwner critical section so two
// simultaneous SessionStarts don't both spawn a proxy onto the same port.
// ---------------------------------------------------------------------------
const LOCK_STALE_MS = 30_000;

export async function acquireStartLock(rt: string, timeoutMs = 5000): Promise<boolean> {
  mkdirSync(rt, { recursive: true, mode: DIR_MODE });
  const p = lockPath(rt);
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

export function releaseStartLock(rt: string): void {
  try {
    rmSync(lockPath(rt), { recursive: true, force: true });
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
}

export type EnsureAction = 'reused' | 'started' | 'start-failed';
export interface EnsureResult {
  action: EnsureAction;
  port: number;
  owner: OwnerRecord | null;
  clients: number;
}

/**
 * Ensure a proxy is available for this client.
 *  - already healthy -> ADOPT (reuse); register client; claim no ownership.
 *  - not healthy -> take the start lock, re-probe, then start. Claim ownership
 *    ONLY if the adapter returns a stoppable owner (a process we spawned).
 * Fail-open: a failed start returns 'start-failed' and never throws.
 */
export async function ensureProxy(
  rt: string,
  client: ClientRecord,
  port: number,
  deps: LifecycleDeps
): Promise<EnsureResult> {
  listClients(rt); // prune dead clients first
  registerClient(rt, client);

  if (await deps.probeHealth(port)) {
    return { action: 'reused', port, owner: readOwner(rt), clients: listClients(rt).length };
  }

  const locked = await acquireStartLock(rt);
  try {
    // Another session may have started it while we waited for the lock.
    if (await deps.probeHealth(port)) {
      return { action: 'reused', port, owner: readOwner(rt), clients: listClients(rt).length };
    }
    const res = await deps.startProxy(port);
    if (!res.healthy) {
      return { action: 'start-failed', port, owner: null, clients: listClients(rt).length };
    }
    // Own ONLY a process we spawned + confirmed. systemd/adopted -> owner null.
    if (res.owner) writeOwner(rt, res.owner);
    return { action: 'started', port, owner: res.owner, clients: listClients(rt).length };
  } finally {
    if (locked) releaseStartLock(rt);
  }
}

export type ReleaseAction =
  | 'stopped'
  | 'left-other-clients'
  | 'left-adopted'
  | 'not-running';
export interface ReleaseResult {
  action: ReleaseAction;
  remainingClients: number;
}

/**
 * Release this client. Stop the proxy ONLY when:
 *   - we own it (a process WE spawned — owner marker present), AND
 *   - no other client remains after removing this one.
 * Otherwise leave it running:
 *   - 'left-other-clients' — another agent session is still using it.
 *   - 'left-adopted'       — we never owned it (pre-existing / systemd / external).
 */
export async function releaseProxy(
  rt: string,
  clientId: string,
  deps: LifecycleDeps
): Promise<ReleaseResult> {
  deregisterClient(rt, clientId);
  const remaining = listClients(rt); // prunes dead clients too
  const owner = readOwner(rt);

  if (!owner) {
    return { action: 'left-adopted', remainingClients: remaining.length };
  }
  if (remaining.length > 0) {
    return { action: 'left-other-clients', remainingClients: remaining.length };
  }
  // We own it and we are the last client — shut it down with the agent.
  try {
    await deps.stopProxy(owner);
  } finally {
    clearOwner(rt);
  }
  return { action: 'stopped', remainingClients: 0 };
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
