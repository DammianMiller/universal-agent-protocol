import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPendingStatus,
  readPendingReplayOutcome,
  writePendingReplayOutcome,
  type PendingReplayOutcome,
} from '../../src/delivery/pending-intents.js';
import { join as joinPath } from 'node:path';

const outcome: PendingReplayOutcome = {
  at: '2026-11-22T00:14:31.000Z',
  root: '/project',
  applied: [
    { file: 'src/world/island.ts', kind: 'write', ts: 1795306234 },
    { file: 'scripts/patch3.py', kind: 'write', ts: 1795306471 },
  ],
  skipped: [{ file: 'src/protected.ts', reason: 'protected path — gate config' }],
  gates: { passed: false, rungs: 3, feedback: 'Type-check (tsc --noEmit): FAIL\nsrc/world/world.ts(242,25): error TS2339' },
};

describe('pending replay outcome state (U-E)', () => {
  it('round-trips the last replay outcome through the state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-pend-'));
    try {
      expect(readPendingReplayOutcome(dir)).toBeNull();
      writePendingReplayOutcome(dir, outcome);
      const back = readPendingReplayOutcome(dir);
      expect(back).not.toBeNull();
      expect(back!.applied).toHaveLength(2);
      expect(back!.applied[0].file).toBe('src/world/island.ts');
      expect(back!.gates?.passed).toBe(false);
      expect(back!.gates?.feedback).toContain('TS2339');
      // Overwrite semantics: the LAST replay wins.
      writePendingReplayOutcome(dir, { ...outcome, gates: { passed: true, rungs: 3, feedback: '' } });
      expect(readPendingReplayOutcome(dir)?.gates?.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives an unwritable state file (observability must never fail a replay)', () => {
    // Pseudo-fs root (ENOENT class). This case also guards the node
    // recursive-mkdir spin: `mkdirSync(dir, { recursive: true })` never
    // returns on /proc roots (99% CPU forever, node 24.19.0 / kernel 7.3.0),
    // so the guarded non-recursive call must throw in microseconds — the
    // 15s vitest timeout is the tripwire if that ever regresses.
    writePendingReplayOutcome('/proc/definitely-not-writable', outcome);
    expect(readPendingReplayOutcome('/proc/definitely-not-writable')).toBeNull();
    // Real-fs unwritable root (EACCES class).
    const ro = mkdtempSync(join(tmpdir(), 'uap-pend-ro-'));
    try {
      chmodSync(ro, 0o500);
      writePendingReplayOutcome(ro, outcome);
      expect(readPendingReplayOutcome(ro)).toBeNull();
    } finally {
      chmodSync(ro, 0o700);
      rmSync(ro, { recursive: true, force: true });
    }
  });
});

describe('pending status report (U-E)', () => {
  it('reports empty state honestly when nothing has been recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-pend-empty-'));
    try {
      const s = formatPendingStatus(dir);
      expect(s).toContain('queue: empty');
      expect(s).toContain('none recorded yet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports queue depth, the last replay outcome, and gate verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-pend-full-'));
    try {
      writePendingReplayOutcome(dir, outcome);
      mkdirSync(joinPath(dir, '.uap'), { recursive: true });
      writeFileSync(
        join(dir, '.uap', 'pending-deliver.jsonl'),
        JSON.stringify({ ts: 1, tool: 'Edit', file_path: 'src/world/surround.ts', edit: { content: 'x' } }) + '\n' +
          JSON.stringify({ ts: 2, tool: 'Edit', file_path: 'src/world/props.ts', edit: { content: 'y' } }) + '\n',
        'utf-8'
      );
      const s = formatPendingStatus(dir);
      expect(s).toContain('queue: 2 intent(s)');
      expect(s).toContain('last replay: 2026-11-22T00:14:31.000Z');
      expect(s).toContain('applied 2, skipped 1');
      expect(s).toContain('✓ applied write: src/world/island.ts');
      expect(s).toContain('⚠ skipped src/protected.ts: protected path');
      expect(s).toContain('gates: FAIL (3 required fast gate(s))');
      expect(s).toContain('TS2339');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('autoroute annotation (U-E)', () => {
  it('points the model at the one-command outcome check', () => {
    // The annotation is the model's only in-context signal after a blocked
    // write; it must name the verification command (run 4 burned turns
    // verifying "did it land?" by hand).
    const hook = readFileSync(join(process.cwd(), 'templates/hooks/deliver_autoroute.py'), 'utf-8');
    expect(hook).toContain('uap deliver --pending-status');
    // Both live copies must stay in sync (installs copy from templates/).
    const live = readFileSync(join(process.cwd(), '.factory/hooks/deliver_autoroute.py'), 'utf-8');
    expect(live).toBe(hook);
  });
});
