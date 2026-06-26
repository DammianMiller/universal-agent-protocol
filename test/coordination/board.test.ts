import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { maybeBoardInjection, coordDbPath } from '../../src/coordination/board-inject.js';
import { resolve } from '../../src/coordination/reactor.js';

describe('collaboration board', () => {
  let dir: string;
  let dbPath: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-board-'));
    dbPath = coordDbPath(dir);
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts and re-reads board messages (not consumed like a mailbox)', () => {
    service.postBoard('agent-a', 'int4 floor proof is circular', 'finding');
    service.postBoard('agent-b', '2B drafter loses at batch-1', 'dead-end');
    // Reading twice returns the same posts — the board is durable, not read-once.
    const first = service.readBoard();
    const second = service.readBoard();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0].kind).toBe('dead-end'); // most recent first
    expect(first[1].kind).toBe('finding');
  });

  it('filters by kind and surfaces a context digest', () => {
    service.postBoard('a', 'note one', 'note');
    service.postBoard('a', 'a dead end', 'dead-end');
    expect(service.readBoard({ kind: 'dead-end' })).toHaveLength(1);
    const digest = service.formatBoardForContext();
    expect(digest).toContain('dead-end');
    expect(digest).toContain('a dead end');
  });

  it('assigns higher priority to flags', () => {
    const id = service.postBoard('a', 'verification loophole found', 'flag');
    expect(id).toBeGreaterThan(0);
    const posts = service.readBoard({ kind: 'flag' });
    expect(posts[0].text).toMatch(/loophole/);
  });

  it('maybeBoardInjection returns a formatted block for the project board', () => {
    service.postBoard('agent-x', 'significance: deltas <4 TPS are ties', 'norm');
    const inj = maybeBoardInjection(dir);
    expect(inj).not.toBeNull();
    expect(inj).toMatch(/significance/);
    expect(inj).toMatch(/norm/);
  });

  it('maybeBoardInjection returns null with no DB / no posts', () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-board-empty-'));
    try {
      expect(maybeBoardInjection(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reactor surfaces the board per-turn and dedupes via surfaced key', () => {
    service.postBoard('agent-y', 'shared playbook updated', 'note');
    const r1 = resolve({ event: 'user-prompt', promptText: 'continue the optimization work', cwd: dir });
    expect(r1.inject).toMatch(/Collaboration board/);
    expect(r1.inject).toMatch(/shared playbook/);
    expect(r1.surfacedKeys).toContain('board:recent');
    // Once surfaced, it isn't re-injected.
    const r2 = resolve({
      event: 'user-prompt',
      promptText: 'continue the optimization work',
      cwd: dir,
      surfaced: ['board:recent'],
    });
    expect(r2.inject).not.toMatch(/Collaboration board/);
  });
});
