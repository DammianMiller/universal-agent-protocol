import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';
import {
  maybeCollaborationInjection,
  collaborationMode,
  activeAgentCount,
} from '../../src/coordination/collaboration-inject.js';
import { resolve } from '../../src/coordination/reactor.js';

describe('collaboration auto-activation', () => {
  let dir: string;
  let service: CoordinationService;

  function writeMode(mode: string): void {
    writeFileSync(
      join(dir, '.uap.json'),
      JSON.stringify({ version: '1.0.0', project: { name: 't' }, collaboration: { mode } })
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-collab-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to auto when unconfigured', () => {
    expect(collaborationMode(dir)).toBe('auto');
  });

  it('auto: activates on a collaboration-shaped task, silent on a trivial one', () => {
    expect(maybeCollaborationInjection(dir, 'optimize throughput, agents on a leaderboard')).toMatch(/collaboration is active/i);
    expect(maybeCollaborationInjection(dir, 'fix the typo in the readme')).toBeNull();
  });

  it('auto: activates when 2+ agents are active even for a trivial task', () => {
    service.register('a-1', ['x'], undefined, 'a-1');
    service.register('a-2', ['x'], undefined, 'a-2');
    expect(activeAgentCount(dir)).toBeGreaterThanOrEqual(2);
    expect(maybeCollaborationInjection(dir, 'fix the typo')).toMatch(/agents active/);
  });

  it('off: never activates', () => {
    writeMode('off');
    service.register('a-1', ['x'], undefined, 'a-1');
    service.register('a-2', ['x'], undefined, 'a-2');
    expect(collaborationMode(dir)).toBe('off');
    expect(maybeCollaborationInjection(dir, 'multi-agent benchmark challenge')).toBeNull();
  });

  it('always: activates even on a trivial solo task', () => {
    writeMode('always');
    expect(maybeCollaborationInjection(dir, 'rename a variable')).toMatch(/collaboration is active/i);
  });

  it('reactor surfaces collaboration guidance and dedupes via collab:active', () => {
    const r1 = resolve({ event: 'user-prompt', promptText: 'benchmark and optimize speed across agents', cwd: dir });
    expect(r1.inject).toMatch(/Agent collaboration/);
    expect(r1.surfacedKeys).toContain('collab:active');
    const r2 = resolve({
      event: 'user-prompt',
      promptText: 'benchmark and optimize speed across agents',
      cwd: dir,
      surfaced: ['collab:active'],
    });
    expect(r2.inject).not.toMatch(/Agent collaboration/);
  });
});
