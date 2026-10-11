/**
 * S3 · `uap diff` local diff view (bridge P5) — pure parse/render pins plus
 * end-to-end facts from a real scratch git repo. Degrade-never-throw is part
 * of the contract: a non-repo yields the honest gitError view, not a crash.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseNumstat,
  applyPorcelain,
  gatherDiffFacts,
  renderDiffView,
  diffCommand,
  type FileDelta,
  type DiffFacts,
} from '../../src/cli/diff.js';

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const dirs: string[] = [];
function tmp(): string {
  const d = join(tmpdir(), `uap-diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf-8' });
}

/** A scratch repo: one commit on its default branch; returns {cwd, base}. */
function scratchRepo(): { cwd: string; base: string } {
  const cwd = tmp();
  git(cwd, ['init', '--quiet']);
  writeFileSync(join(cwd, 'README.md'), '# scratch\n');
  writeFileSync(join(cwd, 'gone.tmp'), 'x\n'); // committed so a worktree delete is a real D
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', 'base']);
  const base = git(cwd, ['symbolic-ref', '--short', 'HEAD']).trim();
  return { cwd, base };
}

describe('parseNumstat', () => {
  it('parses numeric and binary rows, ignores junk', () => {
    const rows = parseNumstat('10\t2\tsrc/a.ts\n-\t-\timg/logo.png\nnot a numstat line\n3\t0\tsrc/b.ts\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ path: 'src/a.ts', added: 10, removed: 2, status: '!' });
    expect(rows[1]).toEqual({ path: 'img/logo.png', added: null, removed: null, status: '!' });
    expect(rows[2].path).toBe('src/b.ts');
  });

  it('keeps rename path shapes verbatim ({old => new})', () => {
    const rows = parseNumstat('0\t0\tsrc/{old.ts => new.ts}\n');
    expect(rows[0].path).toBe('src/{old.ts => new.ts}');
  });
  it('strips git\'s outer quotes from space-carrying paths (P5 polish: the porcelain fold must see ONE spelling)', () => {
    // git quotes paths with spaces in numstat as `"a b.txt"`; the porcelain
    // reader already strips its side. Both sides must agree or the exact
    // match silently fails and the row keeps its `!` fallback status.
    const rows = parseNumstat('1\t1\t"file with space.txt"\n');
    expect(rows[0].path).toBe('file with space.txt');
  });
});

describe('applyPorcelain', () => {
  const row = (path: string, added = 1): FileDelta => ({ path, added, removed: 0, status: '!' });

  it('collects untracked separately and never folds them onto delta rows', () => {
    const { untracked } = applyPorcelain([row('src/a.ts')], '?? new.txt\n M src/a.ts\n');
    expect(untracked).toEqual(['new.txt']);
  });

  it('prefers the worktree code (Y) over the index code (X)', () => {
    const rows = [row('src/a.ts'), row('src/b.ts')];
    applyPorcelain(rows, 'MD src/a.ts\nA  src/b.ts\n');
    expect(rows[0].status).toBe('D'); // M in index, D on disk → the disk wins
    expect(rows[1].status).toBe('A');
  });

  it('maps every status code and leaves uncovered rows as-is', () => {
    const rows = [row('m.ts'), row('a.ts'), row('d.ts'), row('r.ts'), row('u.ts'), row('silent.ts')];
    applyPorcelain(rows, ' M m.ts\nA  a.ts\n D d.ts\nR  r.ts\nUU u.ts\n');
    expect(rows[0].status).toBe('M');
    expect(rows[1].status).toBe('A');
    expect(rows[2].status).toBe('D');
    expect(rows[3].status).toBe('R');
    expect(rows[4].status).toBe('?'); // unmerged: a code outside M/A/D/R
    expect(rows[5].status).toBe('!'); // untouched row keeps its unknown mark
  });

  it('matches rename spellings onto numstat rows (both `old -> new` and bare `new`)', () => {
    const arrow = [row('src/{old.ts => new.ts}')];
    applyPorcelain(arrow, 'R  src/old.ts -> src/new.ts\n');
    expect(arrow[0].status).toBe('R');

    const bare = [row('src/{old.ts => new.ts}')];
    applyPorcelain(bare, 'R  src/new.ts\n');
    expect(bare[0].status).toBe('R');
  });
});

describe('renderDiffView — pure renderer', () => {
  const facts = (over: Partial<DiffFacts> = {}): DiffFacts => ({
    branch: 'feature/x',
    worktree: null,
    uncommitted: [],
    untracked: [],
    unpushedCommits: [],
    ahead: 0,
    behind: 0,
    unpushedFiles: [],
    base: 'master',
    numstatOk: true,
    statusOk: true,
    gitError: null,
    ...over,
  });

  it('names the branch and worktree in the header', () => {
    expect(renderDiffView(facts({ worktree: '357-bridge-p5-surfaces' }))).toContain(
      'feature/x in worktree 357-bridge-p5-surfaces'
    );
    expect(renderDiffView(facts({ branch: null }))).toContain('(detached)');
  });

  it('says clean when nothing is uncommitted or untracked', () => {
    const out = renderDiffView(facts());
    expect(out).toContain('working tree: clean');
    expect(out).toContain('unpushed: none (in sync with master)');
  });

  it('says UNKNOWN — never "clean" — when a git read failed or timed out', () => {
    // The core honesty rule of the view: an absence of data must not render
    // as a positive claim of cleanliness.
    const out = renderDiffView(facts({ numstatOk: false, statusOk: true }));
    expect(out).toContain('working tree: UNKNOWN');
    expect(out).not.toContain('working tree: clean');
    const out2 = renderDiffView(facts({ numstatOk: true, statusOk: false }));
    expect(out2).toContain('working tree: UNKNOWN');
    expect(out2).not.toContain('working tree: clean');
  });

  it('sorts uncommitted rows by additions, caps them, and prints honest totals', () => {
    const uncommitted: FileDelta[] = [
      { path: 'small.ts', added: 2, removed: 1, status: 'M' },
      { path: 'big.ts', added: 100, removed: 5, status: 'A' },
      { path: 'gone.ts', added: 0, removed: 40, status: 'D' },
      { path: 'bin.png', added: null, removed: null, status: 'M' },
    ];
    const out = renderDiffView(facts({ uncommitted, untracked: ['x.txt'] }), 2);
    const first = out.indexOf('big.ts');
    const second = out.indexOf('small.ts');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(out).toContain('… and 2 more modified file(s)');
    expect(out).toContain('? x.txt');
    expect(out).toContain('tracked totals: +102 -46 across 4 tracked, 1 untracked');
  });

  it('keeps the unknown glyph for binary rows', () => {
    const out = renderDiffView(
      facts({ uncommitted: [{ path: 'img/bin.png', added: null, removed: null, status: 'M' }] })
    );
    expect(out).toContain('img/bin.png');
    expect(out).toContain('+± -±');
  });

  it('renders unpushed commits with ahead/behind and the aggregate delta', () => {
    const out = renderDiffView(
      facts({
        ahead: 2,
        behind: 1,
        unpushedCommits: ['abc1234 fix', 'def5678 feat'],
        unpushedFiles: [{ path: 'src/x.ts', added: 10, removed: 3, status: 'M' }],
      })
    );
    expect(out).toContain('unpushed: 2 commit(s) vs master, 1 behind:');
    expect(out).toContain('abc1234 fix');
    expect(out).toContain('diff vs master: +10 -3 across 1 file(s)');
  });

  it('caps the commit list at --max with an honest "… and N more" line', () => {
    const out = renderDiffView(
      facts({ ahead: 3, unpushedCommits: ['c1 fix', 'c2 fix', 'c3 fix'] }),
      2
    );
    expect(out).toContain('c1 fix');
    expect(out).toContain('c2 fix');
    expect(out).not.toContain('c3 fix');
    expect(out).toContain('… and 1 more commit(s)');
  });

  it('strips terminal-control bytes from commit subjects', () => {
    const out = renderDiffView(
      facts({ ahead: 1, unpushedCommits: ['abc \u001b]52;c;base64\u0007 evil subject'] })
    );
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('abc ]52;c;base64 evil subject');
  });

  it('says unknown when there is no merge-base with the base', () => {
    expect(renderDiffView(facts({ ahead: null, behind: null }))).toContain(
      'unpushed: unknown (no merge-base with master?)'
    );
  });

  it('stops at the gitError line when git was unusable', () => {
    const out = renderDiffView(facts({ gitError: 'git unavailable or not a repository' }));
    expect(out).toContain('git: git unavailable or not a repository');
    expect(out).not.toContain('working tree');
  });

  it('always ends with the inspect footer', () => {
    expect(renderDiffView(facts())).toContain('inspect: git diff -- <file>');
  });
  it('caps overlong paths at the 64-char column so every row aligns (P5 polish)', () => {
    const longPath = `${'d/'.repeat(32)}tail.ts`; // 71 chars > the 64-char column
    const uncommitted: FileDelta[] = [
      { path: 'short.ts', added: 3, removed: 1, status: 'M' },
      { path: longPath, added: 5, removed: 2, status: 'M' },
    ];
    const out = renderDiffView(facts({ uncommitted }));
    const lines = out.split('\n').filter((l) => l.includes('.ts'));
    const shortRow = lines.find((l) => l.includes('short.ts'))!;
    const longRow = lines.find((l) => l.includes('tail.ts'))!;
    // The long path is tailed with an ellipsis — its HEAD is gone, its TAIL
    // (the informative half) survives — and the FULL path never appears.
    expect(longRow).toContain('…');
    expect(longRow).toContain('d/tail.ts');
    expect(longRow).not.toContain(longPath);
    // Column integrity: both rows are exactly the same width before the
    // +N column, so the deltas line up visually.
    expect(shortRow.indexOf('+')).toBe(longRow.indexOf('+'));
  });
});

describe('gatherDiffFacts — against a real scratch repo', () => {
  it('sees modified, deleted, and untracked files with real statuses', () => {
    const { cwd } = scratchRepo();
    writeFileSync(join(cwd, 'README.md'), '# scratch, changed\n');
    unlinkSync(join(cwd, 'gone.tmp')); // delete a COMMITTED file → D
    writeFileSync(join(cwd, 'untracked.log'), 'noise\n');
    const facts = gatherDiffFacts(cwd);
    const byPath = new Map(facts.uncommitted.map((f) => [f.path, f]));
    expect(byPath.get('README.md')?.status).toBe('M');
    expect(byPath.get('gone.tmp')?.status).toBe('D');
    expect(facts.untracked).toContain('untracked.log');
  });
  it('reports space + unicode paths verbatim (quotepath=false, no octal escapes, fold intact)', () => {
    const { cwd } = scratchRepo();
    const dirName = 'dir with space';
    const fileName = 'фаéл.txt';
    mkdirSync(join(cwd, dirName), { recursive: true });
    writeFileSync(join(cwd, dirName, fileName), 'one\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '--quiet', '-m', 'add unicode file']);
    writeFileSync(join(cwd, dirName, fileName), 'one\ntwo\n'); // modify → M
    const facts = gatherDiffFacts(cwd);
    const rel = `${dirName}/${fileName}`;
    const row = facts.uncommitted.find((f) => f.path === rel);
    expect(row).toBeDefined();
    // Verbatim on both reads: no quotes, no octal mangling — and the
    // porcelain fold found the row, so the status is real (not the `!`
    // fallback of a misspelled exact match).
    expect(row!.status).toBe('M');
    expect(row!.path).toBe(rel);
    expect(JSON.stringify(facts.uncommitted)).not.toContain('\\u0');
    expect(facts.uncommitted.map((f) => f.path)).not.toContain(expect.stringMatching(/^"/));
  });

  it('sees unpushed commits and their aggregate deltas vs the base', () => {
    const { cwd, base } = scratchRepo();
    git(cwd, ['checkout', '--quiet', '-b', 'feature/x']);
    writeFileSync(join(cwd, 'feature.ts'), 'export const x = 1;\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '--quiet', '-m', 'feat: one']);
    const facts = gatherDiffFacts(cwd, { base });
    expect(facts.ahead).toBe(1);
    expect(facts.behind).toBe(0);
    expect(facts.unpushedCommits.join('\n')).toContain('feat: one');
    expect(facts.unpushedFiles.map((f) => f.path)).toContain('feature.ts');
  });

  it('degrades honestly outside a repository (no throw, gitError set)', () => {
    const facts = gatherDiffFacts(tmp());
    expect(facts.gitError).toBe('git unavailable or not a repository');
    expect(facts.branch).toBeNull();
    expect(facts.uncommitted).toEqual([]);
  });

  it('an unborn repo (no commits) marks the numstat read FAILED — never "clean"', () => {
    // The exact real-world failure mode behind the UNKNOWN rule: rev-parse
    // works, `git diff HEAD` cannot resolve HEAD. The view must not render
    // the empty result as a clean tree.
    const cwd = tmp();
    git(cwd, ['init', '--quiet']);
    const facts = gatherDiffFacts(cwd);
    expect(facts.gitError).toBeNull();
    expect(facts.numstatOk).toBe(false); // HEAD does not resolve: no deltas
    expect(facts.statusOk).toBe(true); // status itself works
    expect(facts.uncommitted).toEqual([]);
    const view = renderDiffView(facts);
    expect(view).toContain('working tree: UNKNOWN');
    expect(view).not.toContain('working tree: clean');
  });
});

describe('diffCommand — the CLI wrapper', () => {
  it('prints the rendered view for a clean scratch repo', async () => {
    const { cwd } = scratchRepo();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    await diffCommand({ cwd, base: 'master' });
    const out = logs.join('\n');
    expect(out).toContain('Local changes —');
    expect(out).toContain('working tree: clean');
  });

  it('--json emits the raw facts including the read-success booleans', async () => {
    const { cwd } = scratchRepo();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    await diffCommand({ cwd, json: true });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.gitError).toBeNull();
    expect(parsed.numstatOk).toBe(true);
    expect(parsed.statusOk).toBe(true);
    expect(Array.isArray(parsed.untracked)).toBe(true);
  });

  it('refuses a --base that would reach git as an option (argv injection)', async () => {
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
    await diffCommand({ cwd: tmp(), base: '--output=/tmp/x' });
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('--base must be a ref, not an option');
  });

  it('refuses garbage --max loudly instead of rendering a NaN-capped view', async () => {
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
    await diffCommand({ cwd: tmp(), max: 'abc' });
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('--max must be a positive integer');
  });
});
