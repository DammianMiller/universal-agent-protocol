/**
 * Reference-counted, session-scoped proxy lifecycle (uap proxy ensure/release).
 * Verifies the product spec:
 *   - start-if-absent + adopt-if-present (never a second proxy)
 *   - a process we started is stopped only when the LAST client leaves
 *   - a proxy we adopted / a systemd unit (owner:null) is NEVER stopped by us
 *   - the liveness pid is the AGENT (a dead agent pid is pruned; a live one is
 *     kept — so overlapping sessions don't evict each other)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureProxy,
  releaseProxy,
  listClients,
  readOwner,
  registerClient,
  resolveClientId,
  pidFromClientId,
  isPidAlive,
  acquireStartLock,
  releaseStartLock,
  type LifecycleDeps,
  type OwnerRecord,
  type StartResult,
  type ClientRecord,
} from '../../src/cli/proxy-lifecycle.js';

const now = () => '2026-07-07T00:00:00Z';
/** A live-agent client (pid = this process, which is alive during the test). */
const client = (id: string, pid = process.pid): ClientRecord => ({
  clientId: id,
  pid,
  harness: 'test',
  registeredAt: now(),
});

/** Fake side-effects with a controllable "up" state + counters. `ownable`
 *  toggles whether a start claims stoppable ownership (process) or not (systemd). */
function fakeDeps(ownable = true) {
  const state = { up: false, started: 0, stopped: 0 };
  const deps: LifecycleDeps = {
    probeHealth: async () => state.up,
    startProxy: async (port): Promise<StartResult> => {
      state.started++;
      state.up = true;
      const owner: OwnerRecord | null = ownable
        ? { kind: 'process', pid: 999999, startToken: 'tok', port, startedAt: now() }
        : null; // systemd / adopted — not owned
      return { healthy: true, owner };
    },
    stopProxy: async () => {
      state.stopped++;
      state.up = false;
    },
    now,
  };
  return { state, deps };
}

describe('proxy lifecycle — start / adopt / refcount / release', () => {
  let rt: string;
  beforeEach(() => {
    rt = mkdtempSync(join(tmpdir(), 'uap-proxy-rt-'));
  });
  afterEach(() => rmSync(rt, { recursive: true, force: true }));

  it('starts and owns the proxy (process) when none is running', async () => {
    const { state, deps } = fakeDeps();
    const r = await ensureProxy(rt, client('A'), 4000, deps);
    expect(r.action).toBe('started');
    expect(state.started).toBe(1);
    expect(readOwner(rt)?.kind).toBe('process');
    expect(r.clients).toBe(1);
  });

  it('adopts (reuses) an already-running proxy without starting a second', async () => {
    const { state, deps } = fakeDeps();
    state.up = true;
    const r = await ensureProxy(rt, client('A'), 4000, deps);
    expect(r.action).toBe('reused');
    expect(state.started).toBe(0);
    expect(readOwner(rt)).toBeNull();
  });

  it('two overlapping live sessions: releasing one keeps the proxy for the other', async () => {
    const { state, deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps); // A starts + owns
    await ensureProxy(rt, client('B'), 4000, deps); // B reuses
    expect(listClients(rt).length).toBe(2);
    const rel = await releaseProxy(rt, 'B', deps);
    expect(rel.action).toBe('left-other-clients');
    expect(rel.remainingClients).toBe(1);
    expect(state.stopped).toBe(0); // A still using it
  });

  it('stops the process we own when the LAST client leaves', async () => {
    const { state, deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps);
    await ensureProxy(rt, client('B'), 4000, deps);
    await releaseProxy(rt, 'B', deps);
    const rel = await releaseProxy(rt, 'A', deps);
    expect(rel.action).toBe('stopped');
    expect(state.stopped).toBe(1);
    expect(readOwner(rt)).toBeNull();
  });

  it('NEVER stops a systemd/adopted proxy (owner:null), even as the last client', async () => {
    const { state, deps } = fakeDeps(false); // start returns owner:null (systemd)
    const r = await ensureProxy(rt, client('C'), 4000, deps);
    expect(r.action).toBe('started');
    expect(readOwner(rt)).toBeNull(); // not owned
    const rel = await releaseProxy(rt, 'C', deps);
    expect(rel.action).toBe('left-adopted');
    expect(state.stopped).toBe(0);
  });

  it('prunes a DEAD-agent client so a crashed session never pins the proxy', async () => {
    const { state, deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps); // live owner-client (this pid)
    // A crashed session B left a client file whose AGENT pid is dead.
    registerClient(rt, { ...client('ghost'), pid: 2147483647 });
    expect(listClients(rt).find((c) => c.clientId === 'ghost')).toBeUndefined();
    const rel = await releaseProxy(rt, 'A', deps); // only live client leaves
    expect(rel.action).toBe('stopped');
    expect(state.stopped).toBe(1);
  });

  it('keeps a live-agent client across an unrelated ensure (no false eviction)', async () => {
    const { deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps); // A: live pid
    await ensureProxy(rt, client('B'), 4000, deps); // B: live pid, reuse
    // An unrelated status/ensure must NOT evict A or B (both agents alive).
    expect(listClients(rt).map((c) => c.clientId).sort()).toEqual(['A', 'B']);
  });

  it("pid<=0 (liveness unknown) clients are kept, not evicted", async () => {
    const { deps } = fakeDeps();
    await ensureProxy(rt, client('A'), 4000, deps);
    registerClient(rt, { ...client('nopid'), pid: 0 });
    expect(listClients(rt).find((c) => c.clientId === 'nopid')).toBeTruthy();
  });

  it('start-failed (unhealthy) leaves no ownership', async () => {
    const state = { started: 0, stopped: 0 };
    const deps: LifecycleDeps = {
      probeHealth: async () => false,
      startProxy: async () => {
        state.started++;
        return { healthy: false, owner: null };
      },
      stopProxy: async () => {
        state.stopped++;
      },
      now,
    };
    const r = await ensureProxy(rt, client('A'), 4000, deps);
    expect(r.action).toBe('start-failed');
    expect(readOwner(rt)).toBeNull();
  });

  it('double-probe under lock: a proxy that came up during the wait is reused', async () => {
    let probes = 0;
    const state = { started: 0 };
    const deps: LifecycleDeps = {
      // down on the first probe, up on the second (another session started it).
      probeHealth: async () => ++probes >= 2,
      startProxy: async () => {
        state.started++;
        return { healthy: true, owner: { kind: 'process', pid: 1, port: 4000, startedAt: now() } };
      },
      stopProxy: async () => {},
      now,
    };
    const r = await ensureProxy(rt, client('A'), 4000, deps);
    expect(r.action).toBe('reused');
    expect(state.started).toBe(0); // we did NOT start a second proxy
  });
});

describe('start lock', () => {
  let rt: string;
  beforeEach(() => {
    rt = mkdtempSync(join(tmpdir(), 'uap-proxy-lock-'));
  });
  afterEach(() => rmSync(rt, { recursive: true, force: true }));

  it('is exclusive: a second acquire times out while held, succeeds after release', async () => {
    expect(await acquireStartLock(rt)).toBe(true);
    expect(await acquireStartLock(rt, 200)).toBe(false); // held
    releaseStartLock(rt);
    expect(await acquireStartLock(rt)).toBe(true);
  });
});

describe('resolveClientId / pidFromClientId / isPidAlive', () => {
  it('prefers explicit, then CLAUDE_ session id, then ppid- fallback', () => {
    expect(resolveClientId('explicit-123')).toBe('explicit-123');
    const saved = {
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      UAP_SESSION_ID: process.env.UAP_SESSION_ID,
    };
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.FACTORY_SESSION_ID;
    delete process.env.CURSOR_SESSION_ID;
    delete process.env.UAP_SESSION_ID;
    expect(resolveClientId()).toBe(`ppid-${process.ppid}`);
    process.env.CLAUDE_SESSION_ID = 'claude-abc';
    expect(resolveClientId()).toBe('claude-abc');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('pidFromClientId parses the ppid- fallback and rejects others', () => {
    expect(pidFromClientId('ppid-4321')).toBe(4321);
    expect(pidFromClientId('claude-uuid')).toBeNull();
    expect(pidFromClientId('ppid-0')).toBeNull();
  });

  it('isPidAlive: own pid alive, impossible pid not', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2147483647)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });
});
