/**
 * `uap policy add-tool` must explain a wrong working directory.
 *
 * This is the command an operator runs to put a merged enforcer INTO FORCE,
 * usually while something is already broken. Both of its failure modes have one
 * cause — cwd — and neither said so:
 *
 *   - `-c` is read relative to cwd, so a repo-relative path threw a raw ENOENT
 *     stack trace naming only the relative string.
 *   - the policy DB defaults to `<cwd>/agents/data/memory/policies.db`, so from
 *     the wrong directory it opened a DIFFERENT (empty) database and reported
 *     "Policy <uuid> not found" about a policy that plainly exists. The DB layer
 *     creates the directory it is pointed at, so that path also leaves an empty
 *     policies.db behind.
 *
 * Both cost a round-trip on 2026-08-10. Exercised through the real CLI, because
 * the stack trace was the product.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI = join(process.cwd(), 'dist', 'bin', 'cli.js');

function addTool(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync('node', [CLI, 'policy', 'add-tool', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, UAP_SELF_PROTECT_OFF: '1' },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('policy add-tool: a missing code file', () => {
  it('names the RESOLVED path, not the string that was typed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { code, out } = addTool(dir, ['-p', 'some-id', '-t', 'x', '-c', 'src/nope.py']);
    expect(code).toBe(1);
    expect(out).toContain(join(dir, 'src/nope.py'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('says the path is relative to the current directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { out } = addTool(dir, ['-p', 'some-id', '-t', 'x', '-c', 'src/nope.py']);
    expect(out).toMatch(/current directory/i);
    expect(out).toMatch(/project root|absolute path/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not print a stack trace', () => {
    // The whole point: a stack trace is not an answer.
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { out } = addTool(dir, ['-p', 'some-id', '-t', 'x', '-c', 'src/nope.py']);
    expect(out).not.toContain('at readFileSync');
    expect(out).not.toContain('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('policy add-tool: an unknown policy id', () => {
  /** A real, readable code file so the run gets past the file check. */
  function realCodeFile(): string {
    return join(process.cwd(), 'package.json');
  }

  it('names the DB it actually read, and says it is cwd-relative', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { code, out } = addTool(dir, [
      '-p', 'eb009986-0000-0000-0000-000000000000', '-t', 'x', '-c', realCodeFile(),
    ]);
    expect(code).toBe(1);
    expect(out).toContain(join(dir, 'agents', 'data', 'memory', 'policies.db'));
    expect(out).toMatch(/relative to the current directory/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('points at the project root and at `uap policy list`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { out } = addTool(dir, [
      '-p', 'eb009986-0000-0000-0000-000000000000', '-t', 'x', '-c', realCodeFile(),
    ]);
    expect(out).toMatch(/project root/i);
    expect(out).toContain('uap policy list');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not print a stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { out } = addTool(dir, [
      '-p', 'eb009986-0000-0000-0000-000000000000', '-t', 'x', '-c', realCodeFile(),
    ]);
    expect(out).not.toContain('at PolicyMemoryManager');
    expect(out).not.toContain('policy-memory.js:');
    rmSync(dir, { recursive: true, force: true });
  });

  it('still reports the underlying "not found", so the id is visible', () => {
    // Replacing the message entirely would hide WHICH id was missing.
    const dir = mkdtempSync(join(tmpdir(), 'uap-addtool-'));
    const { out } = addTool(dir, [
      '-p', 'eb009986-0000-0000-0000-000000000000', '-t', 'x', '-c', realCodeFile(),
    ]);
    expect(out).toContain('eb009986-0000-0000-0000-000000000000');
    rmSync(dir, { recursive: true, force: true });
  });
});
