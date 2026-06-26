import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';

describe('findings ledger', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-findings-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('proposes a finding and also posts it to the board', () => {
    const id = service.proposeFinding('agent-a', '247 TPS via MTP speculative decoding', 'log link');
    expect(id).toBeGreaterThan(0);
    const f = service.getFinding(id);
    expect(f?.status).toBe('proposed');
    expect(f?.claim).toMatch(/247 TPS/);
    // Mirrored to the board as a finding.
    const board = service.readBoard({ kind: 'finding' });
    expect(board.some((p) => p.text.includes('247 TPS'))).toBe(true);
  });

  it('confirms and reverses, tracking status transitions', () => {
    const id = service.proposeFinding('a', 'int4-Marlin floor is a hard ceiling');
    expect(service.updateFinding(id, 'confirmed', { resolution: 'reproduced 3x' })).toBe(true);
    expect(service.getFinding(id)?.status).toBe('confirmed');
    expect(service.updateFinding(id, 'reversed', { resolution: 'proof was circular' })).toBe(true);
    expect(service.getFinding(id)?.status).toBe('reversed');
    expect(service.getFinding(id)?.resolution).toMatch(/circular/);
  });

  it('flagging disputes the finding and raises a board flag (escalation)', () => {
    const id = service.proposeFinding('a', 'TPS win is real');
    expect(service.flagFinding('reviewer', id, 'PPL is teacher-forced, blind to decode divergence')).toBe(true);
    expect(service.getFinding(id)?.status).toBe('disputed');
    const flags = service.readBoard({ kind: 'flag' });
    expect(flags.some((p) => p.text.includes('teacher-forced'))).toBe(true);
  });

  it('tracks lineage via supersedes', () => {
    const old = service.proposeFinding('a', '127 TPS wall');
    const newer = service.proposeFinding('b', '247 TPS wall broken', undefined, old);
    const lineage = service.findingLineage(newer);
    expect(lineage.map((f) => f.id)).toEqual([newer, old]);
  });

  it('lists by status', () => {
    service.proposeFinding('a', 'claim one');
    const c = service.proposeFinding('a', 'claim two');
    service.updateFinding(c, 'confirmed');
    expect(service.listFindings({ status: 'proposed' })).toHaveLength(1);
    expect(service.listFindings({ status: 'confirmed' })).toHaveLength(1);
    expect(service.listFindings()).toHaveLength(2);
  });

  it('returns false / null for unknown ids', () => {
    expect(service.updateFinding(999, 'confirmed')).toBe(false);
    expect(service.getFinding(999)).toBeNull();
    expect(service.findingLineage(999)).toEqual([]);
  });
});
