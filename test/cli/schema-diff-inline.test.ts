/**
 * The checker's side of the inline-check pivot.
 *
 * The gate no longer looks for a marker saying somebody ran this; it runs it,
 * passing the exact paths it is about to gate and the source the command will
 * store. That turns three things into contracts the gate depends on, all
 * asserted here:
 *
 *   --paths    is authoritative, not a filter over this file's own enumeration
 *   --source   selects index vs worktree, and they really can differ
 *   --json     is the whole of stdout, because the gate parses it
 *
 * Plus the classification the gate now BLOCKS on. While the checker only
 * printed advice, calling every added SQL column "breaking" was noise; as a
 * blocking verdict it would refuse ordinary additive migrations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runSchemaDiff } from '../../src/cli/schema-diff.js';

const SQL = 'migrations/001.sql';
const BASE = 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n';

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
}

function write(content: string): void {
  writeFileSync(join(repo, SQL), content);
}

/** Every breaking change description, flattened. */
function breaking(run: Awaited<ReturnType<typeof runSchemaDiff>>): string[] {
  return run.results
    .filter((r) => r.breaking)
    .flatMap((r) => r.changes.filter((c) => c.breaking).map((c) => c.description));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'uap-schema-inline-'));
  git('init', '-q');
  mkdirSync(join(repo, 'migrations'), { recursive: true });
  write(BASE);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('--paths is authoritative', () => {
  it('examines a staged-only change the worktree diff cannot see', async () => {
    // `git diff --name-only <base>` compares the WORKTREE, so a path staged
    // with its worktree copy restored does not appear in it at all. Filtering
    // the caller's paths through that list would hand the gate an empty
    // examined set and let the staged change commit as "covered".
    write('CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
    git('add', SQL);
    write(BASE); // worktree back to base; only the index carries the drop

    const listed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(listed).toBe(''); // nothing for the enumeration to find

    const run = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    expect(run.ran).toBe(true);
    expect(run.examined.map((f) => f.path)).toEqual([SQL]);
    expect(breaking(run)).toContain('Field "t.name" (TEXT) was removed');
  });

  it('does not examine a watched path the caller did not ask about', async () => {
    mkdirSync(join(repo, 'migrations'), { recursive: true });
    writeFileSync(join(repo, 'migrations', '002.sql'), 'CREATE TABLE u (id INTEGER);\n');
    write('CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
    git('add', '-A');

    const run = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    expect(run.examined.map((f) => f.path)).toEqual([SQL]);
  });
});

describe('--source selects which bytes are judged', () => {
  it('reads the index and the worktree differently when they disagree', async () => {
    write('CREATE TABLE t (id INTEGER PRIMARY KEY);\n'); // breaking
    git('add', SQL);
    write(BASE); // worktree clean

    const staged = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    const worktree = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'worktree' });

    expect(breaking(staged)).toContain('Field "t.name" (TEXT) was removed');
    expect(breaking(worktree)).toEqual([]);
  });

  it('is symmetric: a worktree-only break is invisible to the index read', async () => {
    write('CREATE TABLE t (id INTEGER PRIMARY KEY);\n'); // unstaged break

    const staged = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    const worktree = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'worktree' });

    expect(breaking(staged)).toEqual([]);
    expect(breaking(worktree)).toContain('Field "t.name" (TEXT) was removed');
  });
});

describe('quiet mode keeps stdout parseable', () => {
  it('prints nothing, so the caller owns the whole of stdout', async () => {
    write('CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
    git('add', SQL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const run = await runSchemaDiff('HEAD', repo, false, {
        only: [SQL],
        source: 'index',
        quiet: true,
      });
      expect(run.ran).toBe(true);
      expect(breaking(run)).not.toEqual([]); // it really did find something
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('SQL additions are classified by whether existing rows can satisfy them', () => {
  async function verdict(after: string): Promise<string[]> {
    write(after);
    git('add', SQL);
    return breaking(await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' }));
  }

  it('allows a nullable column', async () => {
    expect(
      await verdict('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT);\n')
    ).toEqual([]);
  });

  it('allows NOT NULL when a DEFAULT fills it', async () => {
    expect(
      await verdict(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT NOT NULL DEFAULT '');\n"
      )
    ).toEqual([]);
  });

  it('refuses NOT NULL with nothing to fill it', async () => {
    const changes = await verdict(
      'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT NOT NULL);\n'
    );
    expect(changes.join(' ')).toContain('t.note');
  });

  it('still refuses a dropped column', async () => {
    expect(await verdict('CREATE TABLE t (id INTEGER PRIMARY KEY);\n')).toContain(
      'Field "t.name" (TEXT) was removed'
    );
  });

  it('sees columns declared after a parenthesised type', async () => {
    // The table body used to be matched with `\(([\s\S]*?)\)`, which stops at
    // the first `)` — so one DECIMAL(10,2) hid every column after it, and a
    // drop behind one was undetectable.
    write('CREATE TABLE t (id INTEGER PRIMARY KEY, amt DECIMAL(10,2), name TEXT);\n');
    git('add', SQL);
    git('commit', '-q', '-m', 'with decimal');

    expect(await verdict('CREATE TABLE t (id INTEGER PRIMARY KEY, amt DECIMAL(10,2));\n')).toContain(
      'Field "t.name" (TEXT) was removed'
    );
  });
});

describe('the verdict distinguishes "clean" from "could not analyse"', () => {
  // The gate blocks on `breaking`, so an empty list has to mean "I read it and
  // it is fine". Each case below used to produce an empty list for a reason
  // that was nothing of the sort, and the gate published it as an all-clear.

  it('marks a file with no analyser as not analysed', async () => {
    mkdirSync(join(repo, 'infra', 'helm_charts'), { recursive: true });
    const chart = 'infra/helm_charts/pgdog-values.yaml';
    writeFileSync(join(repo, chart), 'pgdog:\n  replicas: 3\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chart');
    writeFileSync(join(repo, chart), 'pgdog:\n  replicas: 1\n');
    git('add', '-A');

    const run = await runSchemaDiff('HEAD', repo, false, { only: [chart], source: 'index' });
    const result = run.results.find((r) => r.file === chart);
    expect(result?.analysed).toBe(false);
    expect(result?.breaking).toBe(false); // and so it says nothing either way
  });

  it('marks a .sql file as analysed even with no baseline', async () => {
    writeFileSync(join(repo, 'migrations', '002.sql'), 'CREATE TABLE fresh (id INTEGER);\n');
    git('add', '-A');
    const run = await runSchemaDiff('HEAD', repo, false, {
      only: ['migrations/002.sql'],
      source: 'index',
    });
    expect(run.results[0].analysed).toBe(true);
  });

  it('marks a new .ts file as not analysed', async () => {
    // There is no DDL analogue for TypeScript: with nothing to compare
    // against, a new file tells us nothing about what it breaks.
    writeFileSync(join(repo, 'types.ts'), 'export interface A { a: string }\n');
    git('add', '-A');
    const run = await runSchemaDiff('HEAD', repo, false, { only: ['types.ts'], source: 'index' });
    expect(run.results[0].analysed).toBe(false);
  });
});

describe('destructive DDL is breaking with or without a baseline', () => {
  async function verdictForNewFile(sql: string): Promise<string[]> {
    writeFileSync(join(repo, 'migrations', '090.sql'), sql);
    git('add', '-A');
    const run = await runSchemaDiff('HEAD', repo, false, {
      only: ['migrations/090.sql'],
      source: 'index',
    });
    return breaking(run);
  }

  it('catches DROP TABLE in a brand-new migration', async () => {
    // The canonical breaking change, and the one the checker waved through: a
    // new file has no HEAD version, so "nothing was removed relative to the
    // old file" was true and meaningless.
    expect((await verdictForNewFile('DROP TABLE users;\n')).join(' ')).toContain('DROP TABLE users');
  });

  it('catches ALTER TABLE ... DROP COLUMN', async () => {
    expect((await verdictForNewFile('ALTER TABLE t DROP COLUMN name;\n')).join(' ')).toContain(
      'DROP COLUMN name'
    );
  });

  it('catches a column added NOT NULL with nothing to fill it', async () => {
    expect(
      (await verdictForNewFile('ALTER TABLE t ADD COLUMN x TEXT NOT NULL;\n')).join(' ')
    ).toContain('NOT NULL with no default');
  });

  it('allows the same addition when a DEFAULT fills it', async () => {
    expect(
      await verdictForNewFile("ALTER TABLE t ADD COLUMN x TEXT NOT NULL DEFAULT '';\n")
    ).toEqual([]);
  });

  it('allows a purely additive new table', async () => {
    expect(await verdictForNewFile('CREATE TABLE fresh (id INTEGER, note TEXT);\n')).toEqual([]);
  });

  it('ignores destructive statements the base already had', async () => {
    writeFileSync(join(repo, 'migrations', '091.sql'), 'DROP TABLE old_thing;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'existing drop');
    writeFileSync(join(repo, 'migrations', '091.sql'), 'DROP TABLE old_thing;\n-- note\n');
    git('add', '-A');
    const run = await runSchemaDiff('HEAD', repo, false, {
      only: ['migrations/091.sql'],
      source: 'index',
    });
    expect(breaking(run)).toEqual([]);
  });

  it('does not fire on a DROP inside a comment', async () => {
    expect(
      await verdictForNewFile('CREATE TABLE a (id INTEGER); -- do not DROP TABLE users\n')
    ).toEqual([]);
  });
});

describe('SQL comments cannot swallow the schema', () => {
  it('an added comment containing "(" is not a breaking change', async () => {
    // Paren counting ran straight over the comment: depth never returned to
    // zero, the table contributed no columns, every column read as removed —
    // an added comment reported as BREAKING.
    write('CREATE TABLE t (\n  id INTEGER,\n  name TEXT\n);\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'plain');
    write('CREATE TABLE t (\n  id INTEGER,   -- natural key (see ADR-14\n  name TEXT\n);\n');
    git('add', SQL);

    const run = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    expect(breaking(run)).toEqual([]);
  });

  it('a real drop hidden behind such a comment is still caught', async () => {
    write('CREATE TABLE t (\n  id INTEGER,   -- natural key (see ADR-14\n  name TEXT\n);\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'with comment');
    write('CREATE TABLE t (\n  id INTEGER   -- natural key (see ADR-14\n);\n');
    git('add', SQL);

    const run = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    expect(breaking(run).join(' ')).toContain('t.name');
  });
});

describe('the recorded sha describes the source, not whatever could be read', () => {
  it('reports an empty sha and a deletion for a path removed from the index', async () => {
    // `git rm --cached x` leaves the worktree copy in place. The sha used to
    // fall back to it, so the gate compared a worktree blob against an index
    // that no longer held the path — and before that, the analysis compared
    // the untouched worktree copy against HEAD and called the deletion clean.
    execFileSync('git', ['rm', '-q', '--cached', SQL], { cwd: repo, stdio: 'ignore' });
    const run = await runSchemaDiff('HEAD', repo, false, { only: [SQL], source: 'index' });
    expect(run.examined[0].sha).toBe('');
    expect(breaking(run).join(' ')).toContain('staged deletion');
    expect(run.results[0].analysed).toBe(true);
  });
});
