/**
 * The schema-diff pass marker is a CONTRACT between two programs: this CLI
 * writes it, and the Python enforcer (src/policies/enforcers/schema_diff_gate.py)
 * reads it with an anchored LIKE. Nothing tested either side of that handshake
 * before, which is how the rubber stamp below shipped.
 *
 * Reproduced against the shipped CLI:
 *   $ uap schema-diff -b definitely-not-a-real-ref
 *   fatal: ambiguous argument 'definitely-not-a-real-ref': unknown revision
 *   Recorded schema-diff pass for the schema-diff-gate (1h window)   <- exit 0
 * The git failure was swallowed, an empty result read as "no breaking changes",
 * and the marker cleared the gate for a staged DROP TABLE nothing had examined.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runSchemaDiff, recordSchemaDiffPass } from '../../src/cli/schema-diff.js';

/** The anchor the enforcer matches: LIKE 'schema-diff pass: base %'. */
const MARKER_PREFIX = 'schema-diff pass: base ';

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'uap-schema-diff-'));
  git('init', '-q');
  mkdirSync(join(repo, 'migrations'), { recursive: true });
  writeFileSync(join(repo, 'migrations', '001.sql'), 'CREATE TABLE t (id int);');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('schema-diff run reporting', () => {
  it('reports ran=false when git could not produce a file list', async () => {
    const run = await runSchemaDiff('definitely-not-a-real-ref', repo);
    expect(run.ran).toBe(false);
    expect(run.results).toEqual([]);
  });

  it('reports ran=true for a real base even when nothing schema-relevant changed', async () => {
    // The two cases were indistinguishable before: both produced an empty
    // array, and the caller recorded a pass for both.
    const run = await runSchemaDiff('HEAD', repo);
    expect(run.ran).toBe(true);
  });

  it('lists the files it examined, not just those with changes', async () => {
    writeFileSync(join(repo, 'migrations', '002.sql'), 'DROP TABLE t;');
    git('add', '-A');
    const run = await runSchemaDiff('HEAD', repo);
    expect(run.ran).toBe(true);
    expect(run.examined.map((f) => f.path)).toContain('migrations/002.sql');
    // Each entry carries the blob SHA of the bytes read — that is what makes a
    // pass content-scoped rather than merely time-scoped.
    expect(run.examined.every((f) => /^[0-9a-f]{40}$/.test(f.sha))).toBe(true);
  });
});

describe('deadlock recovery', () => {
  /**
   * Removing the rubber stamp created a hard deadlock, verified before this
   * test existed: in a repo at its initial commit (or a shallow CI clone)
   * `HEAD~1` does not resolve, so the documented remedy reported "nothing was
   * checked", recorded nothing, and the gate refused every commit with no
   * waiver and no override. This gate had already self-deadlocked twice.
   */
  it('falls back to the empty tree when the DEFAULT base cannot resolve', async () => {
    // `repo` has exactly one commit, so HEAD~1 does not exist.
    const run = await runSchemaDiff('HEAD~1', repo, true);
    expect(run.ran).toBe(true);
  });

  it('does NOT fall back for an explicit -b, so the rubber stamp stays shut', async () => {
    const run = await runSchemaDiff('definitely-not-a-real-ref', repo, false);
    expect(run.ran).toBe(false);
  });

  it('cannot be tricked into falling back by a FILE named like the base', async () => {
    /**
     * The bypass this test exists for, verified against the first cut:
     *
     *   touch 'HEAD~1' && uap schema-diff   ->  "Recorded schema-diff pass"
     *   <gate>                              ->  {"allowed": true}
     *
     * git refuses an argument that is both a revision and an existing path
     * ("fatal: ambiguous argument"), the code read ANY diff failure as "no
     * baseline", and the empty-tree fallback finds nothing by construction —
     * so one `touch` cleared the gate for a staged DROP TABLE. Fixed by a `--`
     * separator plus a positive `rev-parse --verify` check.
     */
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'second'], {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    writeFileSync(join(repo, 'HEAD~1'), 'a file, not a revision');
    const run = await runSchemaDiff('HEAD~1', repo, true);
    expect(run.ran).toBe(true);
    expect(run.effectiveBase).not.toMatch(/no baseline/);
    expect(run.effectiveBase).toBe('HEAD~1');
  });
});

describe('runs correctly from a subdirectory', () => {
  it('does not report a MODIFIED file as deleted', async () => {
    // git emits repo-root-relative paths; reading them against process.cwd()
    // made every file miss existsSync() and be reported deleted+breaking,
    // blocking the very commit the run was asked to clear.
    writeFileSync(join(repo, 'migrations', '001.sql'), 'CREATE TABLE t (id int, name text);');
    const run = await runSchemaDiff('HEAD', repo);
    expect(run.ran).toBe(true);
    const deleted = run.results
      .flatMap((r) => r.changes)
      .filter((c) => /was deleted/.test(c.description));
    expect(deleted).toEqual([]);
  });
});

describe('marker handshake with the enforcer', () => {
  async function markers(): Promise<string[]> {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(repo, 'agents/data/memory/short_term.db'), { readonly: true });
    const rows = db
      .prepare(`SELECT content FROM memories WHERE content LIKE '${MARKER_PREFIX}%'`)
      .all() as { content: string }[];
    db.close();
    return rows.map((r) => r.content);
  }

  it('writes a marker the enforcer’s anchored query will match', async () => {
    await recordSchemaDiffPass('HEAD', [{ path: 'migrations/001.sql', sha: 'abc1234def' }], repo);
    const found = await markers();
    expect(found).toHaveLength(1);
    expect(found[0].startsWith(MARKER_PREFIX)).toBe(true);
    // `path@sha7` — auditable by a human AND checkable by the enforcer. A bare
    // path would be read as a legacy marker and skip coverage entirely.
    expect(found[0]).toContain('migrations/001.sql@abc1234');
  });

  it('is accepted by the REAL enforcer, end to end', async () => {
    // The prefix lives as a literal in four places (writer, reader, and each
    // side's tests), linked only by comments — so each side can be changed
    // together with its own test while both suites stay green and the real
    // handshake is broken, which deadlocks the gate with no reachable remedy.
    // This is the only test that runs both halves against each other.
    const enforcer = join(
      __dirname,
      '..',
      '..',
      'src',
      'policies',
      'enforcers',
      'schema_diff_gate.py'
    );
    writeFileSync(join(repo, 'migrations', '003.sql'), 'CREATE TABLE u (id int);');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });

    // A PATH carrying git and python3 and nothing else. This test is about the
    // MARKER handshake, which the gate only reaches when its inline checker
    // cannot answer; on the ambient PATH the enforcer finds the installed
    // `uap`, the inline layer answers first, and the marker is never consulted.
    // It passed only while that binary predated --json. Same pinning as
    // tools/agents/tests/test_schema_diff_gate.py, for the same reason.
    const shim = mkdtempSync(join(tmpdir(), 'uap-gitonly-'));
    for (const bin of ['git', 'python3']) {
      const resolved = execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf-8' }).trim();
      symlinkSync(resolved, join(shim, bin));
    }

    const allowed = (): boolean => {
      // The enforcer exits 2 to DENY, which makes execFileSync throw — the
      // verdict is on stdout either way.
      let out: string;
      try {
        out = execFileSync(
          'python3',
          [enforcer, '--operation', 'git-commit', '--args', '{"command":"git commit -m x"}'],
          {
            cwd: repo,
            encoding: 'utf-8',
            env: {
              ...process.env,
              PATH: shim,
              UAP_REPO_ROOT: repo,
              UAP_WORKTREE_ROOT: repo,
            },
          }
        );
      } catch (err) {
        out = String((err as { stdout?: string }).stdout ?? '');
      }
      return JSON.parse(out || '{}').allowed === true;
    };

    expect(allowed()).toBe(false); // watched change staged, no marker yet
    const scoped = await runSchemaDiff('HEAD', repo);
    await recordSchemaDiffPass('HEAD', scoped.examined, repo);
    expect(allowed()).toBe(true); // this CLI's marker satisfies that enforcer

    // THE REDESIGN: the pass vouches for BYTES, not for a time window. Editing
    // the file after the check re-arms the gate — previously one pass cleared
    // every watched path for an hour regardless of what happened next, so a
    // reviewed migration could be swapped for an unreviewed one and committed.
    writeFileSync(join(repo, 'migrations', '003.sql'), 'DROP TABLE u;');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    expect(allowed()).toBe(false);

    // ...and re-running the remedy clears it again, so the block is escapable.
    const rescoped = await runSchemaDiff('HEAD', repo);
    await recordSchemaDiffPass('HEAD', rescoped.examined, repo);
    expect(allowed()).toBe(true);
  });

  it('does not match the gate’s own refusal text', async () => {
    // The old query was LIKE '%schema-diff%pass%', which this satisfies — so
    // an agent storing the blocker as a lesson unblocked itself.
    const refusal =
      'schema-diff-gate: changes to migrations/001.sql require `uap schema-diff` to pass (within 1h).';
    expect(refusal.startsWith(MARKER_PREFIX)).toBe(false);
    expect(/schema-diff.*pass/.test(refusal)).toBe(true);
  });
});
