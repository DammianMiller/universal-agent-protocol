/**
 * Dashboard control surface (write endpoints behind the mutation-token gate) +
 * the deliver run-state helpers that back them: listRuns, the cooperative
 * stop-file lifecycle, and cancel flipping an orphaned run to interrupted.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDashboardServer } from '../src/dashboard/server.js';
import {
  listRuns,
  saveRunState,
  loadRunState,
  requestStop,
  isStopRequested,
  clearStop,
  stopFilePath,
  type DeliverRunState,
} from '../src/delivery/run-state.js';
import { handleDeliverCancel, handleOrchestratorToggle } from '../src/dashboard/controls.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'uap-dash-ctl-'));
}
function run(over: Partial<DeliverRunState> & { runId: string }): DeliverRunState {
  return {
    instruction: 'x',
    presetId: 'p',
    projectRoot: '',
    status: 'running',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...over,
  } as DeliverRunState;
}

describe('deliver run-state: listRuns + stop-file', () => {
  it('listRuns returns [] when the runs dir is absent', () => {
    const dir = tmp();
    try {
      expect(listRuns(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listRuns returns persisted runs, most-recently-updated first', () => {
    const dir = tmp();
    try {
      saveRunState(run({ runId: 'run-old', projectRoot: dir, status: 'delivered', updatedAt: '2020-01-01T00:00:00.000Z' }));
      saveRunState(run({ runId: 'run-new', projectRoot: dir, status: 'running', updatedAt: '2030-01-01T00:00:00.000Z' }));
      const runs = listRuns(dir);
      expect(runs.map((r) => r.runId)).toEqual(['run-new', 'run-old']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requestStop → isStopRequested → clearStop lifecycle', () => {
    const dir = tmp();
    const id = 'run-stop';
    try {
      expect(isStopRequested(dir, id)).toBe(false);
      expect(requestStop(dir, id)).toBe(true);
      expect(existsSync(stopFilePath(dir, id))).toBe(true);
      expect(isStopRequested(dir, id)).toBe(true);
      clearStop(dir, id);
      expect(isStopRequested(dir, id)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handleDeliverCancel', () => {
  it('flips an orphaned running run to interrupted and writes the stop-file', () => {
    const dir = tmp();
    const id = 'run-orphan';
    try {
      // No pid recorded → the owning process is treated as gone.
      saveRunState(run({ runId: id, projectRoot: dir, status: 'running' }));
      const res = handleDeliverCancel(dir, id);
      expect(res.cancelRequested).toBe(true);
      expect(res.interrupted).toBe(true);
      expect(existsSync(stopFilePath(dir, id))).toBe(true);
      expect(loadRunState(dir, id)?.status).toBe('interrupted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a path-traversal runId before any side effect', () => {
    const dir = tmp();
    try {
      expect(() => handleDeliverCancel(dir, '../evil')).toThrow(/invalid runId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handleOrchestratorToggle', () => {
  it('persists deliver.orchestrate to .uap.json', () => {
    const dir = tmp();
    try {
      expect(handleOrchestratorToggle(dir, { state: 'off' }).state).toBe('off');
      const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8')) as { deliver?: { orchestrate?: string } };
      expect(cfg.deliver?.orchestrate).toBe('off');
      // 'auto' removes the key (returns to default behaviour).
      handleOrchestratorToggle(dir, { state: 'auto' });
      const cfg2 = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8')) as { deliver?: { orchestrate?: string } };
      expect(cfg2.deliver?.orchestrate).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid state', () => {
    const dir = tmp();
    try {
      expect(() => handleOrchestratorToggle(dir, { state: 'bogus' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dashboard control routes (server)', () => {
  const TOKEN = 'test-ctl-token';
  let server: { close: () => void; readonly port: number } | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.UAP_DASHBOARD_TOKEN;
    process.env.UAP_DASHBOARD_TOKEN = TOKEN;
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    if (prevToken === undefined) delete process.env.UAP_DASHBOARD_TOKEN;
    else process.env.UAP_DASHBOARD_TOKEN = prevToken;
  });

  const boot = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dashboard server never listened')), 5000);
      server = startDashboardServer({ port: 0, host: '127.0.0.1', onListening: ({ port }) => { clearTimeout(timer); resolve(port); } });
    });

  it('rejects a control mutation with NO token (401)', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/deliver/run-x/cancel`, { method: 'POST' });
    expect(r.status).toBe(401);
  }, 20000);

  it('a correct token passes the gate; an invalid runId → 400 (not 401)', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/deliver/.badid/cancel`, {
      method: 'POST',
      headers: { 'X-Uap-Dashboard-Token': TOKEN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(400);
  }, 20000);

  it('/api/dashboard exposes the new deliverRuns + orchestrate fields', async () => {
    const port = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { deliverRuns?: unknown; orchestrate?: unknown };
    expect(Array.isArray(d.deliverRuns)).toBe(true);
    expect(typeof d.orchestrate).toBe('string');
  }, 20000);
});
