/**
 * The gateless-root REFUSAL, exercised through the built CLI.
 *
 * The helper-level tests cover the predicate; none of them cover the thing that
 * actually changed — that a run stops, with the right exit code and a parseable
 * payload, and that the documented escapes work. This is the wiring test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';

const CLI = resolve(process.cwd(), 'dist/bin/cli.js');
let root: string;

/** A repo whose ROOT has no manifest but whose sub/app does. */
function makeGatelessRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateless-cli-'));
  mkdirSync(join(dir, 'sub', 'app'), { recursive: true });
  writeFileSync(
    join(dir, 'sub', 'app', 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: 'true', test: 'true' } }),
  );
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  // deliver refuses a non-git project before anything else, so give it a baseline.
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline');
  return dir;
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, 'deliver', ...args], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, UAP_DELIVER_NO_DETACH: '1', ...env },
  });
}

/** The CLI prints prose too; the contract is that the LAST JSON object parses. */
function lastJson(out: string): Record<string, unknown> | null {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '{') {
      try { return JSON.parse(lines.slice(i).join('\n')) as Record<string, unknown>; } catch { /* keep looking */ }
    }
  }
  return null;
}

describe('gateless-root refusal through the CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`build first: ${CLI} missing`);
    root = makeGatelessRepo();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('refuses by default, with exit 2 and a parseable payload naming the better root', () => {
    const r = runCli(['--json', '--project-root', root, 'probe']);
    expect(r.status).toBe(2);
    // JSON is a stdout contract; stderr carries the human prose.
    const json = lastJson(r.stdout);
    expect(json?.gatelessRoot).toBe(true);
    expect(json?.suggestedProjectRoot).toBe(join(root, 'sub', 'app'));
  }, 150_000);

  it('does NOT name the bypass in the machine-readable payload', () => {
    // The refusal exists because an agent-driven launch ignores advice, and
    // nextStep is the field such a caller reads first. Naming the off-switch
    // there would hand it the way around this gate.
    const r = runCli(['--json', '--project-root', root, 'probe']);
    const json = lastJson(r.stdout);
    expect(String(json?.nextStep ?? '')).not.toMatch(/allow-gateless-root/i);
    expect(JSON.stringify(json)).not.toMatch(/UAP_ALLOW_GATELESS_ROOT/i);
    // ...while the human prose still tells an operator how to override.
    expect(r.stderr).toMatch(/allow-gateless-root/i);
  }, 150_000);

  it('proceeds past the refusal with the explicit flag', () => {
    const r = runCli(['--json', '--dry-run', '--allow-gateless-root', '--project-root', root, 'probe']);
    expect(r.status).not.toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/refusing to start/);
  }, 150_000);

  it('proceeds past the refusal with the env escape', () => {
    const r = runCli(['--json', '--dry-run', '--project-root', root, 'probe'], { UAP_ALLOW_GATELESS_ROOT: '1' });
    expect(r.status).not.toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/refusing to start/);
  }, 150_000);

  it('never refuses a --dry-run, which is the diagnostic for the refusal itself', () => {
    // Refusing this would remove the one tool that explains the refusal, and
    // a dry-run plans without writing anything.
    const r = runCli(['--json', '--dry-run', '--project-root', root, 'probe']);
    expect(r.status).not.toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/refusing to start/);
  }, 150_000);

  it('leaves a properly-rooted project alone', () => {
    const r = runCli(['--json', '--dry-run', '--project-root', join(root, 'sub', 'app'), 'probe']);
    expect(r.status).not.toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/gateless root/);
  }, 150_000);
});
