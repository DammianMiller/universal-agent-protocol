/**
 * Dashboard placement read routes (spec §4.7) — the read-only half of
 * phase 2: state, pending, and preview against injected fixtures.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { getPlacementState, getPlacementPending, getPlacementPreview, getPlacementAdmit, PLACEMENT_PENDING_TTL_MS } from '../../src/dashboard/placement-routes.js';
import { loadModelRegistry, type ModelRegistry } from '../../src/placement/registry.js';
import { withLedger, type PlacementLedger } from '../../src/placement/ledger.js';

const registry: ModelRegistry = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu', total_mib: 24576, reserved_mib: 1293 },
    cpu0: { kind: 'cpu', total_mib: 126944, reserved_mib: 8192 },
  },
  models: {
    'qwen3.8-flash-next': {
      display: 'Qwen3.8 Flash Next',
      engine: 'strata',
      unit: 'uap-strata-server',
      advertises: ['qwen3.8-flash-next-iq3_s'],
      affinity: { device: ['gpu0'] },
      configs: {
        'strata-iq3_s': {
          unit: 'uap-strata-server',
          resident_gpu_mib: 21812,
          host_rss_mib: 52857,
          context_pool_cells: 131072,
          kv_resident_cells: 32768,
          kv_kind: 'int8',
          measured_at: '2026-10-08T14:02:00Z',
          measured_on: 'gpu0',
        },
      },
    },
  },
};

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshLedger(): string {
  dir = mkdtempSync(join(tmpdir(), 'placement-routes-'));
  return join(dir, 'placement.json');
}

describe('dashboard placement routes', () => {
  it('state: registry summary + synced ledger, with provenance per measured config', () => {
    const ledgerPath = freshLedger();
    const loaded = loadModelRegistry('', { repoPath: '', localPath: join(dir, 'absent.json') });
    // Inject a fully-populated registry via the loaded wrapper.
    const payload = getPlacementState(process.cwd(), {
      loaded: { ...loaded, registry, measuredFrom: new Map([['qwen3.8-flash-next/strata-iq3_s', 'repo']]), errors: [] },
      ledgerPath,
      isActive: () => false, // deterministic: never reconcile live units
    });
    expect(payload.registry_errors).toEqual([]);
    expect(payload.models.length).toBe(1);
    const cfg = payload.models[0].configs[0];
    expect(cfg.measured).toBe(true);
    expect(cfg.source).toBe('repo');
    expect(cfg.resident_gpu_mib).toBe(21812);
    expect(Object.keys(payload.devices)).toContain('gpu0');
    expect(payload.residents).toEqual([]);
    expect(payload.pending).toEqual([]);
  });

  it('pending: parked requests are read from the ledger as-is', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.pending.push({
        id: 'plc-7f2a',
        requested_model: 'Qwen3.8-27B',
        client: 'claude-code',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'not_resident',
      });
    });
    const pending = getPlacementPending(ledgerPath);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe('plc-7f2a');
    expect(pending[0].reason).toBe('not_resident');
  });

  it('preview: ranked options against an injected ledger', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.devices = {
        gpu0: { kind: 'gpu', total_mib: 24576, free_mib: 1016, reserved_mib: 1293, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', total_mib: 126944, free_mib: 30424, reserved_mib: 8192, source: 'MemAvailable' },
      };
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        state: 'hot',
        gpu_mib: 21812,
        host_rss_mib: 52857,
        holders: [],
        since: new Date().toISOString(),
      });
    });
    const result = getPlacementPreview(process.cwd(), 'qwen3.8-flash-next-iq3_s', {
      registry,
      ledgerPath,
    });
    expect(result.matched).toBe(true);
    expect(result.options.map((o) => o.kind)).toEqual(['reuse']);
  });

  it('state survives a corrupt local registry file: errors surface, not a crash', () => {
    const ledgerPath = freshLedger();
    const repo = join(dir, 'repo.json');
    const local = join(dir, 'local.json');
    writeFileSync(repo, JSON.stringify(registry));
    writeFileSync(local, '{ broken');
    const payload = getPlacementState(process.cwd(), { loaded: loadModelRegistry('', { repoPath: repo, localPath: local }), ledgerPath });
    expect(payload.registry_errors.length).toBeGreaterThan(0);
    // The repo shape still summarizes: measured flash-next from repo.
    expect(payload.models[0].configs[0].measured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admission (spec §4.3) — the proxy gate's controller endpoint
// ---------------------------------------------------------------------------

describe('placement admit (proxy gate controller)', () => {
  const loaded = () => ({
    registry,
    measuredFrom: new Map([['qwen3.8-flash-next/strata-iq3_s', 'repo']]),
    errors: [],
  });

  it('forwards on resident reuse with the resident target id (device:endpoint)', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        endpoint: 'http://192.168.1.165:8080/v1',
        state: 'hot',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    // The wire id the client asked for is the ADVERTISED alias, not the key.
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('forward');
    expect(answer.target_id).toBe('gpu0:http://192.168.1.165:8080/v1');
  });

  it('does not forward to a draining resident', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        state: 'draining',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
  });

  it('parks with reason not_resident (measured but not loaded) and writes a pending entry', () => {
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code', session: 's1' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('not_resident');
    expect(answer.placement_id).toMatch(/^plc-[0-9a-f]{6}$/);
    const pending = getPlacementPending(ledgerPath);
    expect(pending.length).toBe(1);
    expect(pending[0].requested_model).toBe('qwen3.8-flash-next-iq3_s');
    expect(pending[0].client).toBe('claude-code');
    expect(pending[0].reason).toBe('not_resident');
    expect(pending[0].expires_at > new Date().toISOString()).toBe(true);
  });

  it('parks with reason no_measured_config (fail closed) and unknown_model', () => {
    const ledgerPath = freshLedger();
    const unmeasured: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'qwen3.8-27b': {
          display: 'Qwen3.8 27B',
          engine: 'llama',
          advertises: ['Qwen3.8-27B'],
          affinity: { device: ['gpu0'] },
          configs: { 'llama-mtp': { unit: 'uap-qwen27b' } },
        },
      },
    };
    const a = getPlacementAdmit(process.cwd(), { model_id: 'Qwen3.8-27B' }, { loaded: { registry: unmeasured, measuredFrom: new Map(), errors: [] }, ledgerPath });
    expect(a.decision).toBe('park');
    expect(a.reason).toBe('no_measured_config');
    const b = getPlacementAdmit(process.cwd(), { model_id: 'gpt-99' }, { loaded: loaded(), ledgerPath });
    expect(b.decision).toBe('park');
    expect(b.reason).toBe('unknown_model');
  });

  it('dedupes on (requested_model, client): one pending entry, one placement id', () => {
    const ledgerPath = freshLedger();
    const first = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    const second = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    expect(first.placement_id).toBe(second.placement_id);
    expect(getPlacementPending(ledgerPath).length).toBe(1);
    // A different client is a different prompt.
    const third = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'codex' }, { loaded: loaded(), ledgerPath });
    expect(third.placement_id).not.toBe(first.placement_id);
    expect(getPlacementPending(ledgerPath).length).toBe(2);
  });

  it('still answers park when the ledger lock is unavailable (write fails, decision does not)', async () => {
    const ledgerPath = freshLedger();
    const { acquireLedgerLock, releaseLedgerLock } = await import('../../src/placement/ledger.js');
    expect(acquireLedgerLock(ledgerPath)).toBe(true);
    try {
      const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
      expect(answer.decision).toBe('park');
      expect(answer.reason).toBe('not_resident');
      expect(answer.placement_id).toMatch(/^plc-/);
    } finally {
      releaseLedgerLock(ledgerPath);
    }
  });

  it('rejects a missing model_id without touching the ledger', () => {
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(process.cwd(), { model_id: '' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('invalid_request');
    expect(getPlacementPending(ledgerPath)).toEqual([]);
  });

  it('the ledger pending TTL is the operator-prompt window (120s), deliberately longer than the proxy burst window', () => {
    // The proxy's own in-memory dedupe is a ~5s burst window so a resolved
    // placement forwards on the next request; this 120s window only bounds
    // how long one operator prompt lives. Spec §4.3 pins the split.
    expect(PLACEMENT_PENDING_TTL_MS).toBe(120_000);
  });
});
