/**
 * A clock is not progress.
 *
 * While a caller waits, the follow ticker printed elapsed seconds and nothing
 * else:
 *
 *     …following deliver (pid 1551963) — 16s
 *     …following deliver (pid 1551963) — 30s
 *
 * That ticks at exactly the same rate whether the mission is completing turns
 * or spinning on nothing, so a caller watching it for a whole poll learns only
 * that time passed. The runs killed on 2026-08-11 — at turns 3, 8 and 10 — were
 * killed by a caller who had been watching precisely this.
 *
 * The final reply already carried turn counts (v1.194.0). The LIVE line did not,
 * and the live line is what somebody actually watches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  followTickDetail,
  awaitInFlightDeliver,
  type FollowProgress,
} from '../../src/delivery/await-run.js';

const base: FollowProgress = { heartbeatAgeSec: 12, wedgeAfterSec: 1800, health: 'active' };

describe('followTickDetail', () => {
  it('shows the turn count, so two ticks can be compared', () => {
    expect(followTickDetail({ ...base, turn: 3 })).toContain('3 turns');
  });

  it('CALLS OUT a completed turn — the one unambiguous sign of advancement', () => {
    const line = followTickDetail({ ...base, turn: 4 }, 3);
    expect(line).toContain('turn 3 → 4');
    expect(line, 'a completed turn should read as an event, not a number').toContain('✓');
  });

  it('does not claim advancement when the turn has not moved', () => {
    const line = followTickDetail({ ...base, turn: 4 }, 4);
    expect(line).not.toContain('→');
    expect(line).toContain('4 turns');
  });

  it('says PLANNING rather than showing an empty turn count', () => {
    // "0 turns" reads as failure to start; the stage is the honest answer, and
    // this is the state the 59-second kills happened in.
    const line = followTickDetail({ ...base, stage: 'planning' });
    expect(line).toContain('planning');
    expect(line).not.toContain('turn');
  });

  it('carries liveness alongside advancement', () => {
    expect(followTickDetail({ ...base, turn: 2 })).toContain('active 12s ago');
  });

  it('omits liveness rather than inventing it when there is no heartbeat yet', () => {
    const line = followTickDetail({ ...base, heartbeatAgeSec: null, stage: 'planning' });
    expect(line).not.toContain('active');
    expect(line).toContain('planning');
  });

  it('includes the phase when the mission is decomposed', () => {
    expect(followTickDetail({ ...base, turn: 1, phase: '2/7' })).toContain('phase 2/7');
  });

  it('adds nothing at all when there is no projection to show', () => {
    // The ticker must degrade to its old shape rather than printing a stray
    // separator: a line ending in "— 30s ·" reads as truncated output.
    expect(followTickDetail(undefined)).toBe('');
    expect(followTickDetail({ heartbeatAgeSec: null, wedgeAfterSec: 1800, health: 'starting' })).toBe('');
  });

  it('reads as one appended clause, not a second line', () => {
    const line = followTickDetail({ ...base, turn: 4, phase: '1/3' }, 3);
    expect(line.startsWith(' · ')).toBe(true);
    expect(line).not.toContain('\n');
  });

  it('singularises one turn', () => {
    expect(followTickDetail({ ...base, turn: 1 })).toContain('1 turn,');
  });

  it('survives a turn count that goes BACKWARDS without claiming a turn completed', () => {
    // Resume re-seeds the checkpoint, and a resumed run can legitimately report
    // a lower turn than the tick before it.
    const line = followTickDetail({ ...base, turn: 2 }, 5);
    expect(line).not.toContain('→');
    expect(line).toContain('2 turns');
  });
});

describe('the ticker actually RECEIVES a projection', () => {
  // Testing the formatter is not testing the ticker: onTick can keep its old
  // two-argument shape while followTickDetail stays perfect, and the live line
  // goes back to being a bare clock. This drives the real follow loop.
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'uap-tick-'));
    roots.push(root);
    mkdirSync(join(root, '.uap'), { recursive: true });
    return root;
  }

  it('hands the follow tick a projection carrying the turn count', async () => {
    const root = project();
    writeFileSync(join(root, '.uap', 'deliver.lock'), `4242|${new Date().toISOString()}`);
    const dir = join(root, '.uap', 'deliver-runs', 'run-20260811T091247-84d1f1');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      runId: 'run-20260811T091247-84d1f1', instruction: 'x', presetId: 'p', projectRoot: root,
      status: 'running', createdAt: now, updatedAt: now, pid: 4242, checkpoint: { turn: 3 },
    }));

    const seen: Array<FollowProgress | undefined> = [];
    await awaitInFlightDeliver(root, {
      timeoutMs: 60,
      pollMs: 10,
      isAlive: (pid) => pid === 4242,
      sleep: async () => undefined,
      onTick: (_elapsed, _pid, progress) => { seen.push(progress); },
    });

    expect(seen.length, 'the follow loop must have ticked').toBeGreaterThan(0);
    expect(seen[0], 'onTick received no projection — the live line is a bare clock again').toBeTruthy();
    expect(seen[0]!.turn).toBe(3);
    expect(followTickDetail(seen[0])).toContain('3 turns');
  });
});
