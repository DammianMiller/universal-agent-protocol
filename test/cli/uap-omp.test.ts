/**
 * The `uap-omp` command group (debt sweep: the shell-interpolation cleanup).
 * These commands used to reach bash/sqlite3/jq through `execSync` template
 * strings — one of them (`memory query`) with a genuinely injectable
 * user/LLM-controlled search term. The pins here are the new mechanics:
 * argv-array bash, library SQL with bound parameters, plain JSON printing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const cli = new URL('../../dist/bin/cli.js', import.meta.url).pathname;
const savedHome = process.env.HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uap-omp-'));
  process.env.HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync('node', [cli, 'uap-omp', ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env },
  });
  return { status: r.status, out: String(r.stdout), err: String(r.stderr) };
}

function ompMemoryDb(): string {
  const dbPath = join(home, '.uap', 'omp', 'memory', 'short_term.db');
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, type TEXT, importance INTEGER)');
  db.prepare('INSERT INTO memories (content, type, importance) VALUES (?, ?, ?)').run(
    "stored note: $(id) `id` '; DROP TABLE memories;-- appears here as literal data",
    'decision',
    8
  );
  db.prepare('INSERT INTO memories (content, type, importance) VALUES (?, ?, ?)').run(
    'a plain note',
    'note',
    3
  );
  db.close();
  return dbPath;
}

describe('uap-omp worktree list — plain JSON, no shell, no jq', () => {
  it('pretty-prints the tracked worktrees file', () => {
    mkdirSync(join(home, '.uap', 'omp'), { recursive: true });
    writeFileSync(join(home, '.uap', 'omp', 'worktrees.json'), JSON.stringify({ '357-x': '/tmp/a' }));
    const r = run(['worktree', 'list']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ '357-x': '/tmp/a' });
    expect(r.out).toContain('\n'); // pretty-printed
  });

  it('says not-installed when the file is missing', () => {
    const r = run(['worktree', 'list']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('No worktrees tracked');
  });

  it('degrades on malformed JSON with a message, not a crash', () => {
    mkdirSync(join(home, '.uap', 'omp'), { recursive: true });
    writeFileSync(join(home, '.uap', 'omp', 'worktrees.json'), '{not json');
    const r = run(['worktree', 'list']);
    expect(r.status).toBe(0);
    expect(r.err).toContain('Error listing worktrees');
  });
});

describe('uap-omp memory — library SQL with bound parameters, never a shell', () => {
  it('status reads counts via better-sqlite3', () => {
    ompMemoryDb();
    const r = run(['memory', 'status']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('total: 2');
    expect(r.out).toContain('types: 2');
  });

  it('a hostile search term (shell metacharacters + SQL quotes) is DATA, not code', () => {
    ompMemoryDb();
    // The exact payload that would have executed through the old execSync
    // string: command substitution, backticks, and SQL comment, all in one.
    const hostile = "$(id) `id` '; DROP TABLE memories;--";
    const r = run(['memory', 'query', hostile]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('stored note:');
    // The DB survived — the term matched as a literal LIKE pattern.
    const db = new Database(join(home, '.uap', 'omp', 'memory', 'short_term.db'), { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    db.close();
    expect(n).toBe(2);
  });

  it('query respects --limit', () => {
    ompMemoryDb();
    const r = run(['memory', 'query', 'a plain note', '-n', '1']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('a plain note');
    expect(r.out).not.toContain('stored note:');
  });

  it('says not-installed when the DB is missing', () => {
    const r = run(['memory', 'status']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('No memory database found');
  });
});
