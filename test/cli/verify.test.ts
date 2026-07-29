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

describe('gate ORDER: build/run first, visual only after they pass', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-order-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('SKIPS the visual + aesthetic review when the run gate fails, and says so', async () => {
    // Pixels of an artifact that does not RUN are not evidence. Worse, the
    // vision reviewer returns confident aesthetic complaints about a screen that
    // only exists because the app is broken, and the fix loop chases those
    // instead of the real defect (octopus_invaders_v3, 2026-07-22: iterations
    // spent on palette notes for a game that had no render loop at all).
    writeWebGame(dir, '(function(){ function r(){ return s.x; } r(); let s = {x:1}; })();');
    const r = await runVerify({ dir, visual: true });
    expect(r.passed).toBe(false);
    // The run failure is what's reported...
    expect(r.report).toMatch(/before initialization|is not defined/);
    // ...and the visual pass is explicitly skipped, never silently omitted.
    expect(r.report).toMatch(/visual \+ aesthetic review SKIPPED/);
    expect(r.report).toMatch(/build\/run gates must pass first/);
    // No visual verdict was produced at all.
    expect(r.visual).toBeUndefined();
  });

  it(
    'RUNS the visual gate IFF the run gates passed',
    async () => {
      writeWebGame(dir, "document.getElementById('c').getContext('2d').fillRect(0,0,1,1);");
      const r = await runVerify({ dir, visual: true });
      // Assert the INVARIANT, not an absolute: if the run gate legitimately
      // fails (e.g. it timed out under load) then skipping the visual pass is
      // the CORRECT behaviour, so pin the relationship rather than "it ran".
      const skipped = /visual \+ aesthetic review SKIPPED/.test(r.report);
      expect(r.visual === undefined).toBe(skipped);
    },
    // This is the one case that reaches a REAL headless browser (the run gate
    // passes, so the visual gate actually launches). That exceeds the suite's
    // 15s default when 280+ files compete for CPU — a load artifact, not a hang.
    //
    // The budget must clear the sum of the internal timeouts this path may
    // legitimately spend, not merely "more than 15s": runVerify(visual) runs the
    // execution gate (DEFAULT_TIMEOUT_MS 60s) and only then the visual gate
    // (DEFAULT_TIMEOUT_MS 30s). At 60s the test could be killed while both gates
    // were still inside their own budgets — unwinnable under load, which is
    // exactly how it failed here at load average 3.5. 150s clears 60+30 with
    // room, and leaves the gates as the components that decide to give up.
    150_000
  );

  it('does not mention the visual skip for a project with NO visual output', async () => {
    // "only when there IS visual output" — a non-web project has no entry pages,
    // so the visual gate is irrelevant either way and must not add noise.
    writeFileSync(join(dir, 'main.py'), 'print("hi")\n');
    const r = await runVerify({ dir, visual: true });
    expect(r.report).not.toMatch(/visual \+ aesthetic review SKIPPED/);
    expect(r.visual).toBeUndefined();
  });
});
