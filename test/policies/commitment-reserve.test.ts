/**
 * commitment-reserve: an all-in move with no way back is blocked until a
 * reserve exists (destructive git ops need a stash/marker; overwriting a real
 * source file with a stub needs a verified same-day .uap-backups backup).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'commitment_reserve.py');

// The enforcer honors reserve/exemption env vars; strip them so a value leaked
// into the test runner's environment (e.g. DELIVER_ACTIVE in a deliver session)
// can't turn every assertion vacuous.
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.UAP_RESERVE_OK;
delete CLEAN_ENV.UAP_COMMITMENT_RESERVE_OFF;
delete CLEAN_ENV.DELIVER_ACTIVE;

function run(
  op: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): { exit: number; allowed: boolean; reason: string } {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify(args)], {
    encoding: 'utf8',
    env: { ...CLEAN_ENV, ...env },
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

const bash = (command: string) => run('Bash', { command });

// The enforcer uses python date.today() (LOCAL date); mirror it without UTC skew.
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('commitment-reserve enforcer — shell all-in moves', () => {
  it('blocks git reset --hard with no reserve', () => {
    const r = bash('git reset --hard origin/master');
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/reserve/i);
  });

  it('allows git reset --hard when an inline stash CREATES the reserve', () => {
    expect(bash('git stash && git reset --hard origin/master').exit).toBe(0);
    expect(bash('git stash push -m wip; git reset --hard HEAD~1').exit).toBe(0);
  });

  it('does NOT unlock via reserve-destroying or inert stash subcommands', () => {
    expect(bash('git stash drop && git reset --hard origin/master').exit).toBe(2);
    expect(bash('git stash clear; git clean -fd').exit).toBe(2);
    expect(bash('git stash list && git push --force origin x').exit).toBe(2);
  });

  it('honors the reserve marker ONLY as a leading env assignment of the segment', () => {
    expect(bash('UAP_RESERVE_OK=1 git reset --hard HEAD~1').exit).toBe(0);
    expect(bash('echo UAP_RESERVE_OK=1; git clean -fd').exit).toBe(2);
    expect(bash('git reset --hard # UAP_RESERVE_OK=1').exit).toBe(2);
  });

  it('never fires on commands that merely MENTION a destructive pattern', () => {
    expect(bash('grep -rn "git reset --hard" .').exit).toBe(0);
    expect(bash('echo "rm -rf src"').exit).toBe(0);
    expect(bash('git commit -m "docs: warn against git reset --hard"').exit).toBe(0);
  });

  it('blocks force-push variants but allows --force-with-lease', () => {
    expect(bash('git push --force origin feature').exit).toBe(2);
    expect(bash('git push -f origin feature').exit).toBe(2);
    expect(bash('git push origin +feature:feature').exit).toBe(2);
    expect(bash('git push --force-with-lease origin feature').exit).toBe(0);
  });

  it('blocks git clean force forms but allows dry runs', () => {
    expect(bash('git clean -fd').exit).toBe(2);
    expect(bash('git clean --force -d').exit).toBe(2);
    expect(bash('git clean -nfd').exit).toBe(0); // -n dry-run wins in git
    expect(bash('git clean --dry-run --force').exit).toBe(0);
  });

  it('blocks wholesale working-tree discards in all common spellings', () => {
    expect(bash('git checkout -- .').exit).toBe(2);
    expect(bash('git restore .').exit).toBe(2);
    expect(bash('git checkout HEAD -- .').exit).toBe(2);
    expect(bash('git restore --worktree .').exit).toBe(2);
    expect(bash('git checkout -f').exit).toBe(2);
  });

  it('allows restoring a specific file and git with global flags stays parsed', () => {
    expect(bash('git restore src/cli/policy.ts').exit).toBe(0);
    expect(bash('git checkout -- README.md').exit).toBe(0);
    expect(bash('git -C /some/repo reset --hard').exit).toBe(2); // still detected
  });

  it('blocks recursive forced deletes of source roots and tree/parent escapes', () => {
    expect(bash('rm -rf src').exit).toBe(2);
    expect(bash('rm -fr test/').exit).toBe(2);
    expect(bash('rm -r -f tools').exit).toBe(2);
    expect(bash('rm -Rf .').exit).toBe(2);
    expect(bash('rm -rf *').exit).toBe(2);
    expect(bash('rm -rf ..').exit).toBe(2);
    expect(bash('rm -rf ~/').exit).toBe(2);
  });

  it('allows scratch/derived deletes, including scratch dirs nested in source roots', () => {
    expect(bash('rm -rf node_modules').exit).toBe(0);
    expect(bash('rm -rf dist build coverage').exit).toBe(0);
    expect(bash('rm -rf /tmp/uap-scratch').exit).toBe(0);
    expect(bash('rm -rf src/__pycache__').exit).toBe(0);
    expect(bash('rm -rf tests/__pycache__ src/generated').exit).toBe(0);
    expect(bash('rm -r src/old-module').exit).toBe(0); // recursive but not forced
    expect(bash('rm -f src/one-file.ts').exit).toBe(0); // forced but not recursive
  });

  it('allows ordinary commands', () => {
    expect(bash('git status && npm run build').exit).toBe(0);
    expect(bash('git push origin feature').exit).toBe(0);
  });
});

describe('commitment-reserve enforcer — stub overwrites (Write)', () => {
  function bigSourceFile(dir?: string): string {
    const d = dir ?? mkdtempSync(join(tmpdir(), 'uap-reserve-'));
    const file = join(d, 'engine.ts');
    writeFileSync(file, `// real implementation\n${'export const x = 1;\n'.repeat(400)}`);
    return file;
  }

  it('blocks gutting a real source file into a stub', () => {
    const file = bigSourceFile();
    const r = run('Write', { file_path: file, content: 'export {};\n' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/stub/i);
  });

  it('allows an overwrite that keeps comparable substance', () => {
    const file = bigSourceFile();
    const content = `// rewrite\n${'export const y = 2;\n'.repeat(300)}`;
    expect(run('Write', { file_path: file, content }).exit).toBe(0);
  });

  it('unlocks a stub overwrite when a REAL same-day backup exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-reserve-root-'));
    const file = bigSourceFile(root);
    const backupDir = join(root, '.uap-backups', localToday());
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(file, join(backupDir, 'engine.ts'));
    const env = { UAP_WORKTREE_ROOT: root, UAP_REPO_ROOT: root };
    expect(run('Write', { file_path: file, content: 'export {};\n' }, env).exit).toBe(0);
  });

  it('does NOT count an empty same-named file as a reserve', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-reserve-root-'));
    const file = bigSourceFile(root);
    const backupDir = join(root, '.uap-backups', localToday());
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'engine.ts'), ''); // zero-byte decoy
    const env = { UAP_WORKTREE_ROOT: root, UAP_REPO_ROOT: root };
    expect(run('Write', { file_path: file, content: 'export {};\n' }, env).exit).toBe(2);
  });

  it('allows overwriting small files, new files, and non-source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-reserve-'));
    const small = join(dir, 'small.ts');
    writeFileSync(small, 'export const a = 1;\n');
    expect(run('Write', { file_path: small, content: '' }).exit).toBe(0);
    expect(run('Write', { file_path: join(dir, 'brand-new.ts'), content: 'x' }).exit).toBe(0);
    const notes = join(dir, 'notes.md');
    writeFileSync(notes, 'x'.repeat(8192));
    expect(run('Write', { file_path: notes, content: 'short' }).exit).toBe(0);
  });

  it('never touches incremental Edit operations and survives malformed args', () => {
    const r = run('Edit', { file_path: '/anything/at/all.ts', old_string: 'a', new_string: '' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
    // non-dict args payload must fail open, not crash
    const weird = spawnSync('python3', [ENFORCER, '--operation', 'Write', '--args', '[1,2,3]'], {
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    expect(weird.status).toBe(0);
  });
});
