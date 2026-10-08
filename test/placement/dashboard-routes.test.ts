/**
 * Dashboard placement read routes (spec §4.7) — the read-only half of
 * phase 2: state, pending, and preview against injected fixtures.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { getPlacementState, getPlacementPending, getPlacementPreview } from '../../src/dashboard/placement-routes.js';
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
