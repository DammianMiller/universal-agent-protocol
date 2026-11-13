/**
 * `uap models measure` (src/cli/models.ts) — the KV-resident resolution at
 * the measurement boundary. Pinned to the live 2026-11-13 incident: the
 * edge0-strata engine template sets no --kv-resident, the backend reports
 * engine.kv_resident 0, and the raw write produced a machine-local registry
 * that failed its own positive-number validation on every later models
 * command. These tests never touch the network, the GPU, or systemd.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelsCommand, resolveKvResidentCells } from '../../src/cli/models.js';
import { loadModelRegistry } from '../../src/placement/registry.js';

// System probes are stubbed for the whole file: measure fails closed without
// a resident backend, and the fixtures stand in for one (port listener pid
// 4242 holding 21268 MiB with 44364 MiB host RSS — the real edge0 numbers).
vi.mock('../../src/placement/probes.js', () => ({
  gpuComputeMiB: () => 21268,
  gpuStatsByIndex: () => new Map(),
  hostRssMiB: () => 44364,
  hostTotalMiB: () => null,
  listeningPortPid: () => 4242,
  unitCgroupPids: () => null,
  unitMainPid: () => null,
  isUnitActive: () => false,
}));

let dir: string;
const realFetch = globalThis.fetch;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'models-measure-cli-'));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// The live edge0-145B /metrics engine block, verbatim shape: kv_resident 0
// because the template never splits the pool — the whole 131072 stays resident.
const EDGE0_METRICS = {
  engine: {
    model: 'edge0_145b',
    max_context: 131072,
    context: 131072,
    kv: 'int8',
    kv_resident: 0,
    vram_free_mib: 999,
    version: '0.1.44',
  },
  live: { state: 'idle', phase: 'idle', prompt_tokens: 0 },
};

// A split-pool engine for the passthrough cases: 32768 resident of a 131072
// pool — the reading must survive, never be inflated to the full pool.
const SPLIT_METRICS = {
  ...EDGE0_METRICS,
  engine: { ...EDGE0_METRICS.engine, model: 'edge0_145b_split', kv_resident: 32768 },
};

function stubMetrics(doc: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    ({ ok: true, status: 200, json: async () => doc }) as unknown as typeof fetch,
  );
}

/** An unmeasured registry the backend's model id maps to unambiguously.
 * Each call gets its own subdir so real-write tests never leave a local
 * registry behind for a later dry-run assertion to trip over. */
function writeRegistryFixture(name = 'fx'): { repoPath: string; localPath: string } {
  const sub = join(dir, name);
  mkdirSync(sub, { recursive: true });
  const repoPath = join(sub, 'repo.json');
  const localPath = join(sub, 'local.json');
  writeFileSync(repoPath, JSON.stringify({
    version: 1,
    devices: { gpu0: { kind: 'gpu' }, cpu0: { kind: 'cpu' } },
    models: {
      'edge0-145b': {
        display: 'Edge0 145B',
        advertises: ['edge0_145b', 'edge0_145b_split'],
        configs: {
          q3k: {
            status: 'unmeasured',
            files: [{ path: join(dir, 'model.gguf'), repo: 'Edge0-AI/Edge0', bytes: 3 }],
          },
        },
      },
    },
  }));
  return { repoPath, localPath };
}

type LocalDoc = { models: Record<string, { configs: Record<string, Record<string, unknown>> }> };
const readLocal = (p: string): LocalDoc => JSON.parse(readFileSync(p, 'utf-8')) as LocalDoc;

describe('resolveKvResidentCells — the zero-kv fallback', () => {
  it('resolves a present-but-zero kv_resident to the full pool (engine accounts no resident subset)', () => {
    // The live edge0 case: writing the raw 0 produced
    // "kv_resident_cells: Number must be greater than 0" on every later
    // models command. The pool size is the truthful reading.
    expect(resolveKvResidentCells(0, 131072)).toBe(131072);
  });

  it('passes a positive resident subset through unchanged — never inflates it to the pool', () => {
    expect(resolveKvResidentCells(32768, 131072)).toBe(32768);
    expect(resolveKvResidentCells(1, 4096)).toBe(1);
  });
});

describe('models measure (CLI) — kv_resident 0 from a live backend', () => {
  it('records the pool as the resident KV and writes a registry that reloads clean', async () => {
    const { repoPath, localPath } = writeRegistryFixture('pool');
    stubMetrics(EDGE0_METRICS);
    const code = await modelsCommand('measure', { repoPath, localPath, endpoint: 'http://127.0.0.1:8080' });
    expect(code).toBe(0);

    const local = readLocal(localPath);
    const cfg = local.models['edge0-145b'].configs['q3k'];
    expect(cfg.kv_resident_cells).toBe(131072);
    expect(cfg.context_pool_cells).toBe(131072);
    expect(cfg.resident_gpu_mib).toBe(21268);
    expect(cfg.host_rss_mib).toBe(44364);
    // The regression this file pins: the machine-local registry must load
    // with ZERO errors — the old raw write poisoned every later command.
    const reloaded = loadModelRegistry(dir, { repoPath, localPath });
    expect(reloaded.errors).toEqual([]);
  });

  it('keeps a split-pool engine\'s real subset instead of the pool fallback', async () => {
    const { repoPath, localPath } = writeRegistryFixture('split');
    stubMetrics(SPLIT_METRICS);
    const code = await modelsCommand('measure', { repoPath, localPath, endpoint: 'http://127.0.0.1:8080' });
    expect(code).toBe(0);
    const q3k = readLocal(localPath).models['edge0-145b'].configs['q3k'];
    expect(q3k.kv_resident_cells).toBe(32768);
    expect(loadModelRegistry(dir, { repoPath, localPath }).errors).toEqual([]);
  });

  it('dry-run resolves and prints the fallback without writing anything', async () => {
    const { repoPath, localPath } = writeRegistryFixture('dryrun');
    stubMetrics(EDGE0_METRICS);
    const code = await modelsCommand('measure', { repoPath, localPath, dryRun: true });
    expect(code).toBe(0);
    expect(existsSync(localPath)).toBe(false);
  });

  it('a zero kv_resident_cells in the local registry is what breaks loading — the reason the fallback exists', () => {
    const { repoPath, localPath } = writeRegistryFixture('zero');
    // The OLD behavior's write: the raw engine reading, zero and all.
    writeFileSync(localPath, JSON.stringify({
      version: 1,
      models: {
        'edge0-145b': {
          display: 'Edge0 145B',
          configs: {
            q3k: {
              engine: 'edge0-strata',
              resident_gpu_mib: 21268,
              host_rss_mib: 44364,
              context_pool_cells: 131072,
              kv_resident_cells: 0,
              kv_kind: 'int8',
              measured_at: '2026-11-13T00:00:00.000Z',
              measured_on: 'gpu0',
            },
          },
        },
      },
    }));
    const reloaded = loadModelRegistry(dir, { repoPath, localPath });
    expect(reloaded.errors.some((e) => e.includes('kv_resident_cells'))).toBe(true);
  });
});
