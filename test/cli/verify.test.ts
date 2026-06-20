import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runVerify } from '../../src/cli/verify.js';

function writeWebGame(dir: string, gameJs: string): void {
  mkdirSync(join(dir, 'js'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!DOCTYPE html><html><body><canvas id="c"></canvas><script src="js/game.js"></script></body></html>'
  );
  writeFileSync(join(dir, 'js/game.js'), gameJs);
}

describe('runVerify', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('VERIFIES a working vanilla-JS web project (runtime-only)', async () => {
    writeWebGame(dir, "document.getElementById('c').getContext('2d').fillRect(0,0,1,1);");
    const r = await runVerify({ dir, runtimeOnly: true });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/VERIFIED/);
  });

  it('does NOT verify a web project that crashes on load (TDZ)', async () => {
    writeWebGame(dir, '(function(){ function r(){ return s.x; } r(); let s = {x:1}; })();');
    const r = await runVerify({ dir, runtimeOnly: true });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/NOT VERIFIED/);
    expect(r.report).toMatch(/before initialization|is not defined/);
  });

  it('fail-closed: empty project with --strict is a failure', async () => {
    const r = await runVerify({ dir, runtimeOnly: true, strict: true });
    expect(r.empty).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/UNVERIFIED/);
  });

  it('non-strict empty project is an honest no-op pass (exit 0)', async () => {
    const r = await runVerify({ dir, runtimeOnly: true });
    expect(r.empty).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/SKIP/);
  });

  it('--runtime-only selects only the execution rung (not build/test)', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ main: 'index.js', scripts: { build: 'true', test: 'true' } })
    );
    writeFileSync(join(dir, 'index.js'), 'module.exports = 1;');
    const r = await runVerify({ dir, runtimeOnly: true });
    expect(r.rungs.every((g) => g.id === 'execution')).toBe(true);
    expect(r.rungs.length).toBe(1);
  });

  it('acceptance is ADVISORY by default and BLOCKS only under --strict', async () => {
    writeWebGame(dir, "document.getElementById('c').getContext('2d').fillRect(0,0,1,1);");
    const failingJudge = async () =>
      '{"criteria":[{"requirement":"has a boss","met":false,"reason":"no boss"}],"pass":false}';

    const advisory = await runVerify({
      dir,
      runtimeOnly: true,
      acceptanceSpec: 'game with a boss',
      acceptanceExecutor: failingJudge,
    });
    expect(advisory.acceptance?.passed).toBe(false);
    expect(advisory.exitCode).toBe(0); // advisory — runtime passed, acceptance doesn't block
    expect(advisory.report).toMatch(/ACCEPTANCE ✗/);

    const strict = await runVerify({
      dir,
      runtimeOnly: true,
      strict: true,
      acceptanceSpec: 'game with a boss',
      acceptanceExecutor: failingJudge,
    });
    expect(strict.exitCode).toBe(1); // --strict → acceptance failure blocks
    expect(strict.passed).toBe(false);
  });

  it('--gates filters the rung set by id', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ main: 'index.js', scripts: { build: 'true', test: 'true' } })
    );
    writeFileSync(join(dir, 'index.js'), 'module.exports = 1;');
    const r = await runVerify({ dir, gates: 'build' });
    expect(r.rungs.map((g) => g.id)).toEqual(['build']);
  });
});
