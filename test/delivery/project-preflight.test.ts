/**
 * A project that structurally cannot deliver must say so — loudly, once, at the
 * start — instead of burning a whole turn budget making no progress.
 *
 * The live failure this pins: a fresh `uap init` scaffold was NOT a git repo, so
 * deliver's worktree-based candidate workspace could not run and deliver/epics/
 * orchestration/tasks were all dead. Nothing reported it. The same scaffold also
 * left deliver.orchestrate/epics unset, silently dropping the always-on posture.
 * Both had been hand-fixed on this project once already — a hand-fix does not
 * survive the next reset, which is why the guard lives in the code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { preflightProject, isGitRepo, formatPreflightFailure } from '../../src/delivery/project-preflight.js';

const gitInit = (dir: string): void => {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
};
const readCfg = (dir: string): Record<string, any> =>
  JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));

describe('preflightProject — refuse to start where deliver cannot work', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-pf-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('BLOCKS a non-git project, and the message carries the fix', () => {
    const r = preflightProject(dir);
    expect(r.ok).toBe(false);
    expect(r.blockers.join('\n')).toMatch(/not a git repository/);
    // The operator must not have to go find the command.
    expect(formatPreflightFailure(r)).toMatch(/git -C .* init/);
  });

  it('passes once the project is a git repo', () => {
    gitInit(dir);
    expect(isGitRepo(dir)).toBe(true);
    expect(preflightProject(dir).ok).toBe(true);
  });

  it('SELF-HEALS an unset orchestrate/epics posture to "on"', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
    const r = preflightProject(dir);
    expect(r.ok).toBe(true);
    expect(r.healed).toHaveLength(2);
    const cfg = readCfg(dir);
    expect(cfg.deliver.orchestrate).toBe('on');
    expect(cfg.deliver.epics).toBe('on');
  });

  it('never overrides an EXPLICIT off — that is an operator decision', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ deliver: { orchestrate: 'off', epics: false } }));
    const r = preflightProject(dir);
    expect(r.healed).toHaveLength(0);
    const cfg = readCfg(dir);
    expect(cfg.deliver.orchestrate).toBe('off');
    expect(cfg.deliver.epics).toBe(false);
  });

  it('is idempotent — a healed project heals nothing on the next run', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
    expect(preflightProject(dir).healed).toHaveLength(2);
    expect(preflightProject(dir).healed).toHaveLength(0);
  });

  it('a malformed .uap.json never throws out of a mission start', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.uap.json'), '{ not json');
    expect(() => preflightProject(dir)).not.toThrow();
    expect(preflightProject(dir).ok).toBe(true);
  });

  it('no .uap.json at all is fine (git repo is the only hard requirement)', () => {
    gitInit(dir);
    const r = preflightProject(dir);
    expect(r.ok).toBe(true);
    expect(r.healed).toHaveLength(0);
  });
});

describe('deliver wiring — the blocker applies to real runs, not to planning', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-pfd-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = new URL('../../dist/bin/cli.js', import.meta.url).pathname;

  it('a REAL run in a non-git project exits non-zero with the fix', () => {
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
    const r = spawnSync('node', [cli, 'deliver', 'build a thing'], { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/not a git repository/);
  });

  it('a --dry-run only PLANS — no worktree, so the git requirement must not apply', () => {
    // Over-strictness here would break every planning path (and did: it failed 4
    // auto-optimizer dry-run tests before this carve-out).
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0' }));
    const r = spawnSync('node', [cli, 'deliver', 'build a thing', '--dry-run'], { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/cannot deliver/);
  });
});
