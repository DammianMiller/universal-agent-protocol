import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';

describe('staged work (relay / quota-pooling)', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-staged-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stages work and posts a handoff to the board', () => {
    const id = service.stageWork('gpu-poor', { title: 'int4 checkpoint', needs: 'gpu', acceptance: 'loads + 1 decode' });
    expect(id).toBeGreaterThan(0);
    expect(service.getStaged(id)?.status).toBe('staged');
    expect(service.readBoard({ kind: 'handoff' }).some((p) => p.text.includes('int4 checkpoint'))).toBe(true);
  });

  it('claim is atomic — a second claimant fails', () => {
    const id = service.stageWork('a', { title: 'run me' });
    expect(service.claimStaged('runner-1', id)).toBe(true);
    expect(service.claimStaged('runner-2', id)).toBe(false);
    expect(service.getStaged(id)?.claimant).toBe('runner-1');
    expect(service.getStaged(id)?.status).toBe('claimed');
  });

  it('completing credits the originator on the board', () => {
    const id = service.stageWork('gpu-poor', { title: 'checkpoint' });
    service.claimStaged('gpu-rich', id);
    expect(service.completeStaged('gpu-rich', id, '118 TPS')).toBe(true);
    const f = service.getStaged(id);
    expect(f?.status).toBe('completed');
    expect(f?.result).toBe('118 TPS');
    const board = service.readBoard({ kind: 'finding' });
    expect(board.some((p) => p.text.includes('orig. gpu-poor'))).toBe(true);
  });

  it('releasing returns work to the pool (or abandons it)', () => {
    const id = service.stageWork('a', { title: 'x' });
    service.claimStaged('b', id);
    expect(service.releaseStaged(id)).toBe(true);
    expect(service.getStaged(id)?.status).toBe('staged');
    expect(service.getStaged(id)?.claimant).toBeNull();
    expect(service.releaseStaged(id, true)).toBe(true);
    expect(service.getStaged(id)?.status).toBe('abandoned');
  });

  it('claimableFor matches capability needs (incl. no-needs items)', () => {
    service.stageWork('a', { title: 'needs gpu', needs: 'gpu' });
    service.stageWork('a', { title: 'needs deploy', needs: 'deploy' });
    service.stageWork('a', { title: 'no needs' });
    const forGpu = service.claimableFor(['gpu']).map((w) => w.title);
    expect(forGpu).toContain('needs gpu');
    expect(forGpu).toContain('no needs');
    expect(forGpu).not.toContain('needs deploy');
  });

  it('lists by status and needs', () => {
    const a = service.stageWork('a', { title: 'one', needs: 'gpu' });
    service.stageWork('a', { title: 'two' });
    service.claimStaged('b', a);
    expect(service.listStaged({ status: 'staged' })).toHaveLength(1);
    expect(service.listStaged({ status: 'claimed' })).toHaveLength(1);
    expect(service.listStaged({ needs: 'gpu' })).toHaveLength(1);
  });
});
