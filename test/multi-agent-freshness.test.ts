/**
 * Multi-agent freshness & collision prevention.
 *
 * Parallel agents lose each other's work in two distinct ways, and before this
 * work only one of them was covered anywhere:
 *
 *   CONCURRENT — two agents in the same file at the same moment. Caught by the
 *     live-agent lock in coordinate-file.sh. Already handled.
 *   SEQUENTIAL — agent A lands a change; agent B's branch predates it and was
 *     never re-synced, so B edits a stale copy and its merge silently reverts A.
 *     Nothing caught this. Measured on this repo: 151 worktrees, worst 1241
 *     commits behind origin/master, 23 holding unmerged commits.
 *
 * These tests cover the sequential half end-to-end (real git repos, real hook
 * invocations) plus the ordering/ownership logic that keeps PRs from colliding.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  matchGlob,
  ownersFor,
  lanesForPaths,
  assessConflict,
  selectDisjoint,
  loadOwnershipMap,
  type OwnershipMap,
} from '../src/coordination/ownership.js';
import {
  orderQueue,
  impactedBy,
  overlappingFiles,
  checksVerdict,
  type PullRequest,
} from '../src/cli/merge-queue.js';
import {
  parseRevListCount,
  summarizeHygiene,
  liveAgentBranches,
  STALE_BEHIND_LIMIT,
  type BranchDrift,
} from '../src/cli/worktree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '../templates/hooks/coordinate-file.sh');

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/**
 * A bare "remote" plus a clone, with `foo.ts` and `bar.ts` on the default branch.
 * Real git — the drift check reads merge-base and remote refs, so a mock would
 * only prove the mock works.
 */
function newRepo(): { work: string } {
  const base = mkdtempSync(join(tmpdir(), 'uap-fresh-'));
  tmpDirs.push(base);
  const remote = join(base, 'remote');
  const work = join(base, 'work');
  mkdirSync(remote, { recursive: true });

  git(remote, 'init', '-q', '--bare');
  git(base, 'clone', '-q', remote, 'work');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  writeFileSync(join(work, 'foo.ts'), 'v1\n');
  writeFileSync(join(work, 'bar.ts'), 'v1\n');
  // Nested files matter: a pathspec bug made the drift check a silent no-op for
  // everything below the repo root, and root-only fixtures hid it completely.
  mkdirSync(join(work, 'src/cli'), { recursive: true });
  writeFileSync(join(work, 'src/cli/deep.ts'), 'v1\n');
  writeFileSync(join(work, 'src/cli/other.ts'), 'v1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  git(work, 'branch', '-M', 'master');
  git(work, 'push', '-qu', 'origin', 'master');
  return { work };
}

/** Run the coordination hook the way pre-tool-use-edit-write.sh does. */
function runHook(
  work: string,
  relPath: string,
  env: Record<string, string> = {}
): { status: number; stderr: string } {
  const r = spawnSync(
    'bash',
    [HOOK, '/nonexistent.db', 'agentB', 'nameB', 'feature/agent-b', relPath, join(work, relPath)],
    { cwd: work, encoding: 'utf-8', env: { ...process.env, ...env } }
  );
  return { status: r.status ?? 0, stderr: r.stderr ?? '' };
}

describe('sequential drift detection (coordinate-file.sh)', () => {
  it('blocks editing a file that changed upstream since the branch point', () => {
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    // Agent A lands a change to foo.ts while B is on its own branch.
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'foo.ts'), 'v2-from-agent-A\n');
    git(work, 'commit', '-qam', 'A changes foo');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    const { status, stderr } = runHook(work, 'foo.ts');

    expect(status).toBe(2);
    expect(stderr).toContain('STALE FILE');
    expect(stderr).toContain('foo.ts');
    // The remedy must be actionable, not just a complaint.
    expect(stderr).toContain('uap worktree sync');
  });

  it('allows editing a file that did NOT move upstream', () => {
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'foo.ts'), 'v2\n');
    git(work, 'commit', '-qam', 'A changes foo only');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    // bar.ts is untouched upstream — a stale branch must not be frozen wholesale.
    expect(runHook(work, 'bar.ts').status).toBe(0);
  });

  it('degrades to a warning under UAP_COORD_DRIFT=warn and is silent when off', () => {
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'foo.ts'), 'v2\n');
    git(work, 'commit', '-qam', 'A changes foo');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    const warned = runHook(work, 'foo.ts', { UAP_COORD_DRIFT: 'warn' });
    expect(warned.status).toBe(0);
    expect(warned.stderr).toContain('COORDINATION WARNING');

    const off = runHook(work, 'foo.ts', { UAP_COORD_DRIFT: 'off' });
    expect(off.status).toBe(0);
    expect(off.stderr).not.toContain('STALE FILE');
  });

  it('blocks a NESTED file that changed upstream (pathspec regression)', () => {
    // REGRESSION: git resolves a pathspec against the process prefix. Running the
    // check from the FILE's directory with a root-relative path meant git looked
    // for src/cli/src/cli/deep.ts, matched nothing, and allowed the edit. Every
    // real source file was unprotected, silently, while root-level fixtures passed.
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'src/cli/deep.ts'), 'v2-from-agent-A\n');
    git(work, 'commit', '-qam', 'A changes deep');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    const { status, stderr } = runHook(work, 'src/cli/deep.ts');
    expect(status).toBe(2);
    expect(stderr).toContain('src/cli/deep.ts');

    // A sibling in the same directory that did NOT move must still pass.
    expect(runHook(work, 'src/cli/other.ts').status).toBe(0);
  });

  it('does not block while a merge is in progress', () => {
    // `uap worktree sync` hitting a conflict leaves MERGE_HEAD set. The files the
    // agent must now edit are exactly the ones that moved upstream, so blocking
    // there deadlocks the resolution the sync just asked for.
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    writeFileSync(join(work, 'src/cli/deep.ts'), 'v2-from-B\n');
    git(work, 'commit', '-qam', 'B changes deep');
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'src/cli/deep.ts'), 'v2-from-A\n');
    git(work, 'commit', '-qam', 'A changes deep');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    // Conflicting merge — left in progress on purpose.
    spawnSync('git', ['merge', '--no-edit', 'origin/master'], { cwd: work, encoding: 'utf-8' });
    expect(existsSync(join(work, '.git/MERGE_HEAD'))).toBe(true);

    expect(runHook(work, 'src/cli/deep.ts').status).toBe(0);
  });

  it('keeps the fetch stamp in the shared git dir for a nested file', () => {
    // If the stamp path is wrong the write fails silently, the throttle always
    // reads 0, and a network fetch runs on EVERY edit. Invisible, and on the
    // hottest path in the system.
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    runHook(work, 'src/cli/other.ts');
    expect(existsSync(join(work, '.git/.uap-drift-fetch'))).toBe(true);
  });

  it('tolerates a corrupt or future-dated fetch stamp', () => {
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    writeFileSync(join(work, '.git/.uap-drift-fetch'), 'garbage');
    expect(runHook(work, 'src/cli/other.ts').status).toBe(0);
    writeFileSync(join(work, '.git/.uap-drift-fetch'), String(2 ** 40));
    expect(runHook(work, 'src/cli/other.ts').status).toBe(0);
  });

  it('fails open in a repo with no remote at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-noremote-'));
    tmpDirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'foo.ts'), 'v1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    expect(runHook(dir, 'foo.ts').status).toBe(0);
  });

  it('ignores a non-numeric throttle instead of erroring', () => {
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    const r = runHook(work, 'src/cli/other.ts', { UAP_COORD_FETCH_SECONDS: 'not-a-number' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('integer expression expected');
  });

  it('fails open outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-nogit-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'foo.ts'), 'x\n');
    expect(runHook(dir, 'foo.ts').status).toBe(0);
  });

  it('still guards drift when the coordination DB is absent', () => {
    // Regression: the DB prerequisite used to `exit 0` ABOVE the drift check, so
    // a missing/unwritable coordination DB silently disabled overwrite protection
    // entirely. Drift depends only on git and must survive that.
    const { work } = newRepo();
    git(work, 'checkout', '-qb', 'feature/agent-b');
    git(work, 'checkout', '-q', 'master');
    writeFileSync(join(work, 'foo.ts'), 'v2\n');
    git(work, 'commit', '-qam', 'A changes foo');
    git(work, 'push', '-q', 'origin', 'master');
    git(work, 'checkout', '-q', 'feature/agent-b');
    git(work, 'fetch', '-q', 'origin', 'master');

    // '/nonexistent.db' is passed by runHook — no DB exists at all.
    expect(runHook(work, 'foo.ts').status).toBe(2);
  });
});

describe('ownership lanes', () => {
  const map: OwnershipMap = {
    lanes: {
      cli: ['src/cli/**', 'src/bin/**'],
      delivery: ['src/delivery/**'],
      policy: ['src/policies/**', 'policies/**'],
    },
  };

  it('matches globs by segment depth', () => {
    expect(matchGlob('src/cli/**', 'src/cli/worktree.ts')).toBe(true);
    expect(matchGlob('src/cli/**', 'src/cli/nested/deep/file.ts')).toBe(true);
    expect(matchGlob('src/cli/**', 'src/delivery/run.ts')).toBe(false);
    // A single star must not cross a separator.
    expect(matchGlob('src/*.ts', 'src/index.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/cli/index.ts')).toBe(false);
    expect(matchGlob('test/deliver-?.test.ts', 'test/deliver-1.test.ts')).toBe(true);
    // Regex metacharacters in a pattern are literals, not operators.
    expect(matchGlob('src/a+b.ts', 'src/aaab.ts')).toBe(false);
    expect(matchGlob('src/a+b.ts', 'src/a+b.ts')).toBe(true);
  });

  it('resolves paths to lanes and ignores unmapped paths', () => {
    expect(ownersFor('src/cli/worktree.ts', map)).toEqual(['cli']);
    expect(ownersFor('README.md', map)).toEqual([]);
    expect(lanesForPaths(['src/cli/a.ts', 'src/delivery/b.ts'], map)).toEqual(['cli', 'delivery']);
  });

  it('flags shared files and shared lanes separately', () => {
    const sameFile = assessConflict(['src/cli/a.ts'], ['src/cli/a.ts'], map);
    expect(sameFile.conflicts).toBe(true);
    expect(sameFile.sharedFiles).toEqual(['src/cli/a.ts']);

    // Different files, same module — the semantic conflict file-overlap misses.
    const sameLane = assessConflict(['src/cli/a.ts'], ['src/bin/b.ts'], map);
    expect(sameLane.conflicts).toBe(true);
    expect(sameLane.sharedFiles).toEqual([]);
    expect(sameLane.sharedLanes).toEqual(['cli']);

    expect(assessConflict(['src/cli/a.ts'], ['src/delivery/b.ts'], map).conflicts).toBe(false);
  });

  it('selects a disjoint batch and respects already-held lanes', () => {
    const items = [
      { id: 'a', paths: ['src/cli/x.ts'] },
      { id: 'b', paths: ['src/cli/y.ts'] }, // same lane as a -> excluded
      { id: 'c', paths: ['src/delivery/z.ts'] },
      { id: 'd', paths: ['README.md'] }, // unmapped -> always selectable
    ];
    const picked = selectDisjoint(items, (i) => i.paths, map).map((r) => r.item.id);
    expect(picked).toEqual(['a', 'c', 'd']);

    const withHeld = selectDisjoint(items, (i) => i.paths, map, ['cli']).map((r) => r.item.id);
    expect(withHeld).toEqual(['c', 'd']);
  });

  it('treats a missing or malformed ownership file as no lanes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-own-'));
    tmpDirs.push(dir);
    expect(loadOwnershipMap(dir).lanes).toEqual({});

    writeFileSync(join(dir, '.uap-ownership.json'), '{ not json');
    expect(loadOwnershipMap(dir).lanes).toEqual({});

    writeFileSync(
      join(dir, '.uap-ownership.json'),
      JSON.stringify({ lanes: { good: ['src/**'], bad: 'not-an-array', empty: [] } })
    );
    expect(loadOwnershipMap(dir).lanes).toEqual({ good: ['src/**'] });
  });

  it('reads the TRACKED map, with the local one as an override', () => {
    // .uap/ is gitignored, so a lane map living only there can never be shared
    // between agents, clones or CI — the exact situation lanes exist for.
    const dir = mkdtempSync(join(tmpdir(), 'uap-own2-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, '.uap-ownership.json'), JSON.stringify({ lanes: { shared: ['a/**'] } }));
    expect(loadOwnershipMap(dir).lanes).toEqual({ shared: ['a/**'] });

    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap/ownership.json'), JSON.stringify({ lanes: { local: ['b/**'] } }));
    expect(loadOwnershipMap(dir).lanes).toEqual({ local: ['b/**'] });
  });
});

describe('merge queue ordering', () => {
  const pr = (over: Partial<PullRequest> & { number: number }): PullRequest => ({
    title: `PR ${over.number}`,
    headRefName: `feature/${over.number}`,
    isDraft: false,
    updatedAt: '2026-01-01T00:00:00Z',
    labels: [],
    files: [],
    ...over,
  });

  it('lands fixes before features and docs last', () => {
    const ordered = orderQueue([
      pr({ number: 1, headRefName: 'docs/readme', files: ['a.md'] }),
      pr({ number: 2, headRefName: 'feature/thing', files: ['b.ts'] }),
      pr({ number: 3, headRefName: 'fix/crash', files: ['c.ts'] }),
    ]).map((p) => p.number);
    expect(ordered).toEqual([3, 2, 1]);
  });

  it('prefers smaller diffs, then older branches, within a priority band', () => {
    const ordered = orderQueue([
      pr({ number: 1, files: ['a.ts', 'b.ts', 'c.ts'], updatedAt: '2026-01-01T00:00:00Z' }),
      pr({ number: 2, files: ['d.ts'], updatedAt: '2026-02-01T00:00:00Z' }),
      pr({ number: 3, files: ['e.ts'], updatedAt: '2026-01-01T00:00:00Z' }),
    ]).map((p) => p.number);
    expect(ordered).toEqual([3, 2, 1]);
  });

  it('treats P0/critical labels as top priority regardless of branch name', () => {
    const ordered = orderQueue([
      pr({ number: 1, headRefName: 'fix/small', files: ['a.ts'] }),
      pr({ number: 2, headRefName: 'feature/big', labels: ['P0'], files: ['b.ts', 'c.ts'] }),
    ]).map((p) => p.number);
    expect(ordered).toEqual([2, 1]);
  });

  it('classifies check states instead of collapsing them to red', () => {
    // Collapsing every non-zero exit into "failing" stopped the queue dead twice
    // over: a repo with no CI could never land anything, and PRs whose checks were
    // still running after the previous merge's re-sync were reported as broken.
    expect(checksVerdict(0, 'all good')).toBe('green');
    expect(checksVerdict(8, '')).toBe('none');
    expect(checksVerdict(1, 'build\tpending\thttps://…')).toBe('pending');
    expect(checksVerdict(1, 'lint\tin_progress\t…')).toBe('pending');
    expect(checksVerdict(1, 'test\tfail\t…')).toBe('red');
  });

  it('detects which PRs a merge invalidates, by file and by lane', () => {
    const landed = pr({ number: 1, files: ['src/cli/a.ts'] });
    const sharesFile = pr({ number: 2, files: ['src/cli/a.ts'] });
    const sharesLane = pr({ number: 3, files: ['src/bin/b.ts'] });
    const unrelated = pr({ number: 4, files: ['docs/readme.md'] });

    expect(overlappingFiles(landed, sharesFile)).toEqual(['src/cli/a.ts']);

    // Without a lane map, only the file overlap is visible.
    expect(impactedBy(landed, [sharesFile, sharesLane, unrelated]).map((p) => p.number)).toEqual([2]);

    // With lanes, the same-module PR is caught too.
    const map: OwnershipMap = { lanes: { cli: ['src/cli/**', 'src/bin/**'] } };
    expect(
      impactedBy(landed, [sharesFile, sharesLane, unrelated], map).map((p) => p.number)
    ).toEqual([2, 3]);
  });
});

describe('worktree hygiene reporting', () => {
  const drift = (over: Partial<BranchDrift>): BranchDrift => ({
    name: 'wt',
    path: '/tmp/wt',
    branch: 'feature/x',
    behind: 0,
    ahead: 0,
    dirty: 0,
    ...over,
  });

  it('parses rev-list counts and rejects garbage', () => {
    expect(parseRevListCount('42\n')).toBe(42);
    expect(parseRevListCount('')).toBe(0);
    expect(parseRevListCount('not-a-number')).toBe(0);
    expect(parseRevListCount('-5')).toBe(0);
  });

  it('stays silent on a healthy repo', () => {
    expect(summarizeHygiene([], 'origin/master')).toBe('');
    expect(summarizeHygiene([drift({ behind: 3 })], 'origin/master')).toBe('');
  });

  it('reports unmerged work and stale branches with the worst offender', () => {
    const msg = summarizeHygiene(
      [
        drift({ name: 'a', ahead: 2 }),
        drift({ name: 'b', dirty: 4 }),
        drift({ name: 'c', behind: 1241 }),
        drift({ name: 'd', behind: 1 }),
      ],
      'origin/master'
    );
    expect(msg).toContain('2 worktree(s) hold unmerged or uncommitted work');
    expect(msg).toContain('1 are >200 commits behind origin/master');
    expect(msg).toContain('worst: c at 1241 behind');
  });
});

describe('live-agent awareness (git metadata cannot tell abandoned from in-progress)', () => {
  const drift = (over: Partial<BranchDrift>): BranchDrift => ({
    name: 'wt',
    path: '/tmp/wt',
    branch: 'feature/x',
    behind: 0,
    ahead: 0,
    dirty: 0,
    ...over,
  });

  function coordDb(rows: Array<{ branch: string; ageSeconds: number; status?: string }>): string {
    const root = mkdtempSync(join(tmpdir(), 'uap-live-'));
    tmpDirs.push(root);
    const dir = join(root, 'agents', 'data', 'coordination');
    mkdirSync(dir, { recursive: true });
    const db = join(dir, 'coordination.db');
    const sql = [
      `CREATE TABLE agent_registry (id TEXT PRIMARY KEY, name TEXT, session_id TEXT, status TEXT,
         current_task TEXT, worktree_branch TEXT, started_at TEXT, last_heartbeat TEXT, capabilities TEXT);`,
      `CREATE TABLE work_announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, agent_name TEXT,
         worktree_branch TEXT, intent_type TEXT, resource TEXT, description TEXT, files_affected TEXT,
         estimated_completion TEXT, announced_at TEXT, completed_at TEXT);`,
    ];
    rows.forEach((r, i) => {
      const id = `agent-${i}`;
      sql.push(
        `INSERT INTO agent_registry (id,name,session_id,status,started_at,last_heartbeat)
         VALUES ('${id}','a','${id}','${r.status ?? 'active'}', datetime('now'), datetime('now','-${r.ageSeconds} seconds'));`
      );
      sql.push(
        `INSERT INTO work_announcements (agent_id,agent_name,worktree_branch,intent_type,resource,announced_at)
         VALUES ('${id}','a','${r.branch}','editing','src/a.ts', datetime('now','-${r.ageSeconds} seconds'));`
      );
    });
    const res = spawnSync('sqlite3', [db, sql.join('\n')], { encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`sqlite3 failed: ${res.stderr}`);
    return root;
  }

  it('reports a branch whose agent is heartbeating as live', () => {
    const root = coordDb([{ branch: 'feature/live', ageSeconds: 10 }]);
    expect(liveAgentBranches(root).has('feature/live')).toBe(true);
  });

  it('does NOT report an agent whose heartbeat went stale', () => {
    const root = coordDb([{ branch: 'feature/dead', ageSeconds: 100000 }]);
    expect(liveAgentBranches(root).has('feature/dead')).toBe(false);
  });

  it('ignores completed agents', () => {
    const root = coordDb([{ branch: 'feature/done', ageSeconds: 5, status: 'completed' }]);
    expect(liveAgentBranches(root).has('feature/done')).toBe(false);
  });

  it('fails open when there is no coordination DB', () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-nodb-'));
    tmpDirs.push(empty);
    expect(liveAgentBranches(empty).size).toBe(0);
  });

  it('an ACTIVE worktree is never counted as drift or as prunable-stale', () => {
    // The failure this exists to prevent: an old, drifted, dirty worktree with a
    // live agent in it reads as abandoned salvage on git metadata alone. It is not.
    const active = summarizeHygiene(
      [drift({ name: 'busy', behind: 1242, ahead: 3, dirty: 8, active: true })],
      'origin/master'
    );
    expect(active).toContain('LIVE agent');
    expect(active).not.toContain('hold unmerged or uncommitted work');
    expect(active).not.toContain('commits behind');
  });

  it('still reports genuinely idle drift alongside active worktrees', () => {
    const msg = summarizeHygiene(
      [
        drift({ name: 'busy', behind: 1242, ahead: 2, active: true }),
        drift({ name: 'idle', behind: 900 }),
        drift({ name: 'orphan', ahead: 4 }),
      ],
      'origin/master'
    );
    expect(msg).toContain('1 worktree(s) hold unmerged or uncommitted work'); // orphan only
    expect(msg).toContain(`1 are >${STALE_BEHIND_LIMIT} commits behind`); // idle only
    expect(msg).toContain('1 have a LIVE agent');
    expect(msg).toContain('worst: idle at 900 behind'); // ranked among IDLE, not the busy one
  });
});
