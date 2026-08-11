/**
 * "Nothing is in flight" was answered from one directory, in a tree that nests
 * project roots.
 *
 * A project root is wherever `.uap/` sits, and this repo nests them: on
 * 2026-08-11 one worktree held runs in `src/sql/.uap` AND `src/rust-pg-ext/.uap`
 * at the same time. `currentHolder` only looks at the root it is handed, so
 * asking from the PARENT answered from the parent's own `.uap` — reporting
 * confidently on YESTERDAY's run and offering to resume it, while two of that
 * day's runs were live one directory down:
 *
 *     $ cd .worktrees/001-optimize-motivation-system && uap deliver --await-run
 *     ✓ The deliver run exited without recording a final status — it was interrupted.
 *       Continue it with resume:'run-20260810T035810-c0911f'
 *
 * The harm is already documented in this codebase: a caller told "nothing is in
 * flight, start the mission normally" starts a SECOND run against the same tree,
 * and two of them overwrite each other's edits.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  liveRunsInNestedRoots,
  nestedRunNotice,
  awaitInFlightDeliver,
  NESTED_ROOT_MAX_DEPTH,
} from '../../src/delivery/await-run.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-nested-'));
  roots.push(root);
  mkdirSync(join(root, '.uap'), { recursive: true });
  return root;
}

const ALIVE = 4242;
const isAlive = (pid: number) => pid === ALIVE;

function writeRun(
  projectRoot: string,
  runId: string,
  over: Record<string, unknown> = {}
): void {
  const dir = join(projectRoot, '.uap', 'deliver-runs', runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      runId,
      instruction: 'replace the lateral joins',
      presetId: 'p',
      projectRoot,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      pid: ALIVE,
      ...over,
    })
  );
}

function nestedRoot(root: string, rel: string): string {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '.uap'), { recursive: true });
  return p;
}

describe('liveRunsInNestedRoots', () => {
  it('finds the live run one directory down', () => {
    const root = tree();
    const sql = nestedRoot(root, 'src/sql');
    writeRun(sql, 'run-20260811T091247-84d1f1', { checkpoint: { turn: 3 } });
    const found = liveRunsInNestedRoots(root, isAlive);
    expect(found).toHaveLength(1);
    expect(found[0]!.runId).toBe('run-20260811T091247-84d1f1');
    expect(found[0]!.turn).toBe(3);
  });

  it('finds runs in SEVERAL nested roots — the real shape of that day', () => {
    const root = tree();
    writeRun(nestedRoot(root, 'src/sql'), 'run-a');
    writeRun(nestedRoot(root, 'src/rust-pg-ext'), 'run-b');
    expect(liveRunsInNestedRoots(root, isAlive).map((r) => r.runId).sort()).toEqual(['run-a', 'run-b']);
  });

  it('ignores a run whose PROCESS is gone, however the record reads', () => {
    // `status` stays 'running' on a run whose process died — deliberately, since
    // that IS the resumable state. Trusting it would report the nine dead runs
    // sitting in this project right now as live.
    const root = tree();
    writeRun(nestedRoot(root, 'src/sql'), 'run-dead', { pid: 999999 });
    expect(liveRunsInNestedRoots(root, isAlive)).toEqual([]);
  });

  it('ignores a finished run', () => {
    const root = tree();
    writeRun(nestedRoot(root, 'src/sql'), 'run-done', { status: 'delivered' });
    expect(liveRunsInNestedRoots(root, isAlive)).toEqual([]);
  });

  it('does NOT report the root it was asked about', () => {
    // The caller has already been told about its own root; repeating it as a
    // "nested" run would read as a second, concurrent mission.
    const root = tree();
    writeRun(root, 'run-mine');
    expect(liveRunsInNestedRoots(root, isAlive)).toEqual([]);
  });

  it('never descends into node_modules or .worktrees', () => {
    // A worktree is a separate checkout with its own live missions; reporting
    // those as "nested here" would send a caller to follow an unrelated tree.
    const root = tree();
    writeRun(nestedRoot(root, 'node_modules/pkg'), 'run-vendor');
    writeRun(nestedRoot(root, '.worktrees/001-other'), 'run-other-tree');
    expect(liveRunsInNestedRoots(root, isAlive)).toEqual([]);
  });

  it('never treats a run inside .uap ITSELF as a nested project', () => {
    // .uap holds machinery, and machinery contains project-shaped things: a
    // snapshot is a COPY of the tree, `.uap/snapshots/<id>/.uap/deliver-runs`,
    // carrying the run records it was copied with. Walking into .uap would
    // report those copies as live missions and send a caller to follow a
    // snapshot of a run instead of the run.
    const root = tree();
    const snap = join(root, '.uap', 'snapshots', 'uap-snap-abc');
    mkdirSync(join(snap, '.uap'), { recursive: true });
    writeRun(snap, 'run-in-a-snapshot');
    expect(liveRunsInNestedRoots(root, isAlive)).toEqual([]);
  });

  it('stops at the depth limit rather than walking a whole disk', () => {
    const root = tree();
    writeRun(nestedRoot(root, 'a/b/c/d/e/f/g'), 'run-deep');
    expect(liveRunsInNestedRoots(root, isAlive, 2)).toEqual([]);
    expect(NESTED_ROOT_MAX_DEPTH).toBeGreaterThan(0);
  });

  it('survives an unreadable directory instead of throwing', () => {
    const root = tree();
    writeRun(nestedRoot(root, 'src/sql'), 'run-a');
    expect(() => liveRunsInNestedRoots(join(root, 'does-not-exist'), isAlive)).not.toThrow();
    expect(liveRunsInNestedRoots(join(root, 'does-not-exist'), isAlive)).toEqual([]);
  });
});

describe('nestedRunNotice', () => {
  it('says do NOT start a mission here, and names where the run is', () => {
    const notice = nestedRunNotice([
      { runId: 'run-a', projectRoot: '/p/src/sql', pid: 1, turn: 3 },
    ]);
    expect(notice).toContain('run-a');
    expect(notice).toContain('/p/src/sql');
    expect(notice).toMatch(/do NOT start a mission here/i);
  });

  it('counts the others rather than listing a wall of them', () => {
    const notice = nestedRunNotice([
      { runId: 'run-a', projectRoot: '/p/a', pid: 1 },
      { runId: 'run-b', projectRoot: '/p/b', pid: 2 },
      { runId: 'run-c', projectRoot: '/p/c', pid: 3 },
    ]);
    expect(notice).toContain('and 2 more');
  });

  it('is empty when there is nothing to warn about', () => {
    expect(nestedRunNotice([])).toBe('');
  });
});

describe('awaitInFlightDeliver looks below before saying "start the mission"', () => {
  const opts = { timeoutMs: 50, pollMs: 10, isAlive, sleep: async () => undefined };

  it('refuses to say "start normally" while a nested run is live', async () => {
    const root = tree();
    writeRun(nestedRoot(root, 'src/sql'), 'run-live', { checkpoint: { turn: 3 } });
    const r = await awaitInFlightDeliver(root, opts);
    expect(r.nothingInFlight).toBe(true);
    expect(r.nestedLiveRuns).toHaveLength(1);
    expect(r.nextStep, 'this is the sentence that starts a second mission')
      .not.toMatch(/Start the mission normally/i);
    expect(r.nextStep).toContain('run-live');
  });

  it('still says "start normally" when the tree really is idle', async () => {
    const r = await awaitInFlightDeliver(tree(), opts);
    expect(r.nothingInFlight).toBe(true);
    expect(r.nestedLiveRuns).toBeUndefined();
    expect(r.nextStep).toMatch(/Start the mission normally/i);
  });

  it('appends the warning to a terminal report about this root\'s own last run', async () => {
    // The measured case: the parent had an old finished run AND a live nested
    // one, and answered only about the old one — offering to resume it.
    const root = tree();
    writeRun(root, 'run-yesterday', { status: 'interrupted' });
    writeRun(nestedRoot(root, 'src/sql'), 'run-today', { checkpoint: { turn: 3 } });
    const r = await awaitInFlightDeliver(root, opts);
    expect(r.runId).toBe('run-yesterday');
    expect(r.nestedLiveRuns?.[0]?.runId).toBe('run-today');
    expect(r.nextStep).toContain('run-today');
  });
});
