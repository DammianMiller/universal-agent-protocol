/**
 * Visual captures (uplift 0.3) — pairing, freshness, sibling-artifact
 * placement, and the CLI exit-code contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isUiFile,
  changedFilesVsBase,
  recordCapture,
  validateCaptures,
  capturesArtifactPath,
  UI_EXT,
  UI_DIR_PREFIXES,
} from '../src/review/visual-captures.js';
import { reviewCommand } from '../src/cli/review.js';

let repo: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** Repo on feature/x with a master base commit, like the enforcer tests. */
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'uap-visual-captures-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.dev']);
  git(['config', 'user.name', 't']);
  git(['checkout', '-q', '-b', 'master']);
  writeFileSync(join(repo, 'README.md'), '# base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'feature/x']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  process.exitCode = undefined;
});

function add(file: string, content = 'x'): void {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `add ${file}`]);
}

function fakeCaptures(): { before: string; after: string } {
  writeFileSync(join(repo, 'before.png'), 'png-before');
  writeFileSync(join(repo, 'after.png'), 'png-after');
  return { before: 'before.png', after: 'after.png' };
}

describe('UI file classification', () => {
  it('flags style/component/markup surfaces', () => {
    for (const f of [
      'src/app.tsx', 'a/b.css', 'x.scss', 'index.html', 'c.vue',
      'c.svelte', 'c.astro', 'c.jsx',
    ]) {
      expect(isUiFile(f)).toBe(true);
    }
    // directory prefixes catch extension-less or asset paths
    expect(isUiFile('web/anything.bin')).toBe(true);
    expect(isUiFile('public/logo.txt')).toBe(true);
  });

  it('does not flag backend or doc surfaces', () => {
    for (const f of ['src/server.ts', 'docs/guide.md', 'infra/main.tf', 'test/x.test.ts']) {
      expect(isUiFile(f)).toBe(false);
    }
  });

  it('matches case-insensitively (parity with the enforcer)', () => {
    expect(isUiFile('Web/app.bin')).toBe(true);
    expect(isUiFile('SRC/DASHBOARD/x.ts')).toBe(true);
    expect(isUiFile('src/Component.TSX')).toBe(true);
  });

  it('pins the UI surface definition (mirrored in both Python enforcers)', () => {
    // If this set changes, update UI_EXT/UI_DIR_PREFIXES in
    // expert_review_required.py AND visual_verification.py in the same PR.
    expect([...UI_EXT].sort()).toEqual([
      '.astro', '.css', '.html', '.jsx', '.less', '.sass', '.scss', '.svelte', '.tsx', '.vue',
    ]);
    expect(UI_DIR_PREFIXES).toEqual(['web/', 'src/dashboard/', 'public/']);
  });
});

describe('changedFilesVsBase', () => {
  it('returns files changed vs master', () => {
    add('src/app.tsx');
    add('src/server.ts');
    expect(changedFilesVsBase(repo)?.sort()).toEqual(['src/app.tsx', 'src/server.ts']);
  });

  it('fails open (null) when no base resolves', () => {
    const bare = mkdtempSync(join(tmpdir(), 'uap-visual-nobase-'));
    execFileSync('git', ['init', '-q'], { cwd: bare });
    expect(changedFilesVsBase(bare)).toBeNull();
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('recordCapture + validateCaptures', () => {
  it('is not required when the diff has no UI files', () => {
    add('src/server.ts');
    const v = validateCaptures(repo);
    expect(v.required).toBe(false);
    expect(v.ok).toBe(true);
  });

  it('requires captures when the diff touches UI files', () => {
    add('src/app.tsx');
    const v = validateCaptures(repo);
    expect(v.required).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('no captures artifact');
  });

  it('records a pair and validates clean', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    const rec = recordCapture(repo, { tool: 'tuistory', before, after });
    expect('error' in rec).toBe(false);
    const v = validateCaptures(repo);
    expect(v.ok).toBe(true);
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0].tool).toBe('tuistory');
  });

  it('refuses pairs whose files do not exist or escape the project', () => {
    add('src/app.tsx');
    expect('error' in recordCapture(repo, { tool: 't', before: 'nope.png', after: 'after.png' })).toBe(true);
    expect('error' in recordCapture(repo, { tool: 't', before: '../x.png', after: 'after.png' })).toBe(true);
  });

  it('writes the SIBLING artifact, never the enforcer-watched <slug>.json', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    recordCapture(repo, { tool: 'agent-browser', before, after });
    expect(existsSync(join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'))).toBe(true);
    expect(existsSync(join(repo, '.uap', 'reviews', 'feature%2Fx.json'))).toBe(false);
    expect(capturesArtifactPath(repo, 'feature/x')).toContain('feature%2Fx.captures.json');
  });

  it('accumulates multiple pairs across registrations', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    recordCapture(repo, { tool: 'tuistory', before, after });
    recordCapture(repo, { tool: 'agent-browser', before, after, note: 'home page' });
    const artifact = JSON.parse(
      readFileSync(join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'), 'utf-8'),
    );
    expect(artifact.captures).toHaveLength(2);
    expect(artifact.ui_files).toEqual(['src/app.tsx']);
  });

  it('fails when a UI file changed after the captures were taken', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    recordCapture(repo, { tool: 'tuistory', before, after });
    // Simulate a post-capture edit: push the UI file's mtime into the future.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'src/app.tsx'), future, future);
    const v = validateCaptures(repo);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('changed after the captures');
  });

  it('fails when a referenced capture file was deleted', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    recordCapture(repo, { tool: 'tuistory', before, after });
    rmSync(join(repo, 'after.png'));
    const v = validateCaptures(repo);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('missing on disk');
  });

  it('fails closed on a malformed artifact (no crash, no corruption on add)', () => {
    add('src/app.tsx');
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    const artifactPath = join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json');
    writeFileSync(artifactPath, JSON.stringify({ captures: 'not-an-array', at: 'now' }));
    const v = validateCaptures(repo);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('no complete before/after pair');
    // A subsequent add must REPLACE the garbage, not spread it into chars.
    const { before, after } = fakeCaptures();
    const rec = recordCapture(repo, { tool: 'tuistory', before, after });
    expect('error' in rec).toBe(false);
    if (!('error' in rec)) expect(rec.artifact.captures).toHaveLength(1);
  });

  it('fails closed when the artifact `at` is unparseable (enforcer parity)', () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    recordCapture(repo, { tool: 'tuistory', before, after });
    const artifactPath = join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json');
    const data = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    data.at = 'not-a-date';
    writeFileSync(artifactPath, JSON.stringify(data));
    const v = validateCaptures(repo);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('no parseable `at`');
  });

  it('allows a legitimate filename starting with two dots', () => {
    add('src/app.tsx');
    writeFileSync(join(repo, '..assets-before.png'), 'b');
    writeFileSync(join(repo, 'after.png'), 'a');
    const rec = recordCapture(repo, { tool: 't', before: '..assets-before.png', after: 'after.png' });
    expect('error' in rec).toBe(false);
  });

  it('fails open on a detached HEAD like the enforcer does', () => {
    add('src/app.tsx');
    git(['checkout', '-q', '--detach', 'HEAD']);
    const v = validateCaptures(repo);
    expect(v.required).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.reasons.join(' ')).toContain('detached');
  });
});

describe('captures CLI contract', () => {
  it('check exits 1 on an uncovered UI diff, including the --json path', async () => {
    add('src/app.tsx');
    await reviewCommand(['captures', 'check'], { projectDir: repo, json: true });
    expect(process.exitCode).toBe(1);
  });

  it('add then check exits clean', async () => {
    add('src/app.tsx');
    const { before, after } = fakeCaptures();
    await reviewCommand(['captures', 'add'], { projectDir: repo, tool: 'tuistory', before, after });
    expect(process.exitCode).toBeUndefined();
    await reviewCommand(['captures'], { projectDir: repo });
    expect(process.exitCode).toBeUndefined();
  });

  it('add without both paths exits 1', async () => {
    await reviewCommand(['captures', 'add'], { projectDir: repo, tool: 't', before: 'x.png' });
    expect(process.exitCode).toBe(1);
  });
});
