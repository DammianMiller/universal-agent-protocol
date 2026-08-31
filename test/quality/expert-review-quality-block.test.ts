import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'expert_review_required.py');

let proj: string;
let branch: string;

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: proj, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  proj = mkdtempSync(join(tmpdir(), 'uap-erq-'));
  git(['init', '-b', 'feat/quality-fusion']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(proj, 'a.ts'), 'export const a = 1;\n');
  git(['add', 'a.ts']);
  git(['commit', '-m', 'init']);
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
});
afterAll(() => rmSync(proj, { recursive: true, force: true }));

function slugFor(b: string): string {
  return b.replace(/%/g, '%25').replace(/\//g, '%2F');
}

function writeArtifact(extra: Record<string, unknown>): void {
  mkdirSync(join(proj, '.uap', 'reviews'), { recursive: true });
  writeFileSync(
    join(proj, '.uap', 'reviews', `${slugFor(branch)}.json`),
    JSON.stringify({
      branch,
      head: git(['rev-parse', 'HEAD']),
      verdict: 'approve',
      reviewers: ['code-quality-reviewer'],
      ...extra,
    })
  );
}

function run(command: string): { exit: number; allowed: boolean; reason: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.UAP_NO_REVIEW;
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command })],
    { env: { ...baseEnv, UAP_REPO_ROOT: proj, UAP_WORKTREE_ROOT: proj }, encoding: 'utf8' }
  );
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

describe('expert-review quality block (step 5b)', () => {
  it('ALLOWS a ship when the artifact carries no quality block (fail-open)', () => {
    writeArtifact({});
    const r = run('git commit -m "x"');
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('ALLOWS a ship when quality.pass is true', () => {
    writeArtifact({ quality: { pass: true, blocking: 0, report: '.uap/quality-report.json' } });
    const r = run('git commit -m "x"');
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/expert-review satisfied/);
  });

  it('ALLOWS a ship when quality is null (gate inactive)', () => {
    writeArtifact({ quality: null });
    expect(run('git commit -m "x"').exit).toBe(0);
  });

  it('BLOCKS a ship when quality.pass is false, citing the blocking count', () => {
    writeArtifact({ quality: { pass: false, blocking: 3, report: '.uap/quality-report.json' } });
    const r = run('git commit -m "x"');
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/quality gate FAILED/);
    expect(r.reason).toMatch(/3 blocking/);
  });

  it('BLOCKS a push too — the veto applies to every ship action', () => {
    writeArtifact({ quality: { pass: false, blocking: 1 } });
    const r = run('git push origin HEAD');
    expect(r.exit).toBe(2);
    expect(r.reason).toMatch(/quality gate FAILED/);
  });
});
