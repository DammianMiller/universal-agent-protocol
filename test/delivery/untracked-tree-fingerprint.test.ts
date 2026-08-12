/**
 * Content edits to UNTRACKED files must register in the tree fingerprint.
 *
 * `git status --porcelain` prints `?? path` for an untracked file and says
 * nothing about its contents, and `git diff HEAD --stat` only covers TRACKED
 * files. So in a repo that HAS commits but whose source is not yet added, a
 * turn that rewrites a file changes neither half of the fingerprint — the
 * anti-no-op rail reads "nothing happened" while the model is working, and the
 * no-progress breaker reads "tree untouched" on every productive turn.
 *
 * Measured on a real pgrx crate sitting untracked inside its parent repo: a
 * run stagnated 6 turns out of 7 with the tree changing underneath it.
 *
 * A stat fallback already existed for UNBORN-HEAD repos, where `git diff HEAD`
 * throws. That is the same blindness, but it was only ever wired into the
 * throw path — when HEAD exists, the diff succeeds and the fallback never
 * runs. These tests pin the general case.
 *
 * Size+mtime, not a content hash: a false "changed" only lets a run continue,
 * while a false "unchanged" aborts a run that is working. The cheap signal
 * errs in the safe direction, and byte-identical rewrites are already refused
 * upstream by the NO-OP write guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}

function ladderResult(score: number, passed: boolean): LadderResult {
  return {
    passed,
    score,
    feedback: 'gate feedback',
    results: [
      { id: 'test', name: 'test', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, output: '' },
    ],
  } as unknown as LadderResult;
}

describe('untracked source: a content edit is a real change', () => {
  let dir: string;
  const SRC = 'src/lib.rs';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-untracked-fp-'));
    // A repo WITH a commit — so `git diff HEAD` succeeds and the unborn-HEAD
    // fallback is NOT what is under test here.
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    execSync('git add -A && git commit -qm seed', { cwd: dir, stdio: 'ignore' });
    // ...whose source tree is untracked, the shape of a crate dropped into an
    // existing repo before anyone ran `git add`.
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, SRC), 'fn broken() {}\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs one turn whose executor performs `mutate`, and reports whether the rail saw a change. */
  async function runWith(mutate: () => void, instruction = 'fix the crate'): Promise<boolean> {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => {
        mutate();
        return 'mutated via tools; no file blocks';
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    return (await loop.deliver(instruction)).success;
  }

  it('sees a rewrite of an existing untracked file', async () => {
    // The regression: no new paths, only different bytes at the same path.
    const seen = await runWith(() => writeFileSync(join(dir, SRC), 'fn fixed() { let x = 1; }\n'));
    expect(seen, 'editing untracked source must count as work').toBe(true);
  });

  it('sees an append to an existing untracked file', async () => {
    const seen = await runWith(() => {
      const cur = readFileSync(join(dir, SRC), 'utf8');
      writeFileSync(join(dir, SRC), `${cur}fn added() {}\n`);
    });
    expect(seen).toBe(true);
  });

  it('sees an edit that leaves the file exactly the same SIZE', async () => {
    // Size alone is not enough: renaming a symbol usually preserves length.
    // Without mtime a size-only fingerprint reports "unchanged" here, which is
    // the same blindness one layer down.
    const same = 'fn brokeN() {}\n';
    expect(same.length, 'fixture must be size-preserving to be worth anything').toBe(
      readFileSync(join(dir, SRC), 'utf8').length
    );
    const seen = await runWith(() => writeFileSync(join(dir, SRC), same));
    expect(seen).toBe(true);
  });

  it('still withholds when the turn writes nothing at all', async () => {
    // Without this the suite would pass on a fingerprint that always reports
    // "changed" — which is not a signal, it is a stuck needle.
    const seen = await runWith(() => {});
    expect(seen, 'fail-closed on a genuinely idle turn').toBe(false);
  });

  it('still ignores harness-owned .uap/ bookkeeping', async () => {
    const seen = await runWith(() => {
      mkdirSync(join(dir, '.uap'), { recursive: true });
      writeFileSync(join(dir, '.uap', 'state.json'), `{"updatedAt":"now"}\n`);
    });
    expect(seen, 'our own state is never mission output').toBe(false);
  });

  it('still registers a newly created untracked file', async () => {
    // This already worked — `?? path` appears where it did not before. Pinned
    // so a fix aimed at edits cannot cost us the signal we already had.
    const seen = await runWith(() => writeFileSync(join(dir, 'src', 'extra.rs'), 'fn c() {}\n'));
    expect(seen).toBe(true);
  });

  it('still registers a deleted untracked file', async () => {
    const seen = await runWith(() => rmSync(join(dir, SRC)));
    expect(seen).toBe(true);
  });

  it('sees an edit to a TRACKED file too — the diff half still works', async () => {
    const seen = await runWith(() => writeFileSync(join(dir, 'README.md'), 'seed\nchanged\n'));
    expect(seen).toBe(true);
  });
});

describe('unborn HEAD (a repo with no commits) — same blindness, other branch', () => {
  let dir: string;
  const SRC = 'src/lib.rs';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-unborn-fp-'));
    // No commit at all, so `git diff HEAD` throws and the stat fallback runs.
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, SRC), 'fn broken() {}\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sees a content edit to a file that already existed', async () => {
    // The existing unborn-HEAD coverage only ever CREATED a file, which the
    // `?? path` listing catches by itself — so the stat fallback it was
    // written for was never actually exercised. Deleting that fallback left
    // the whole suite green until this case existed.
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), alwaysVerify: true },
      async () => {
        writeFileSync(join(dir, SRC), 'fn fixed() { let x = 1; }\n');
        return 'edited an existing file; no new paths';
      },
      {
        applier: async () => ({ filesWritten: [], rejected: [] }),
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    expect((await loop.deliver('fix it')).success).toBe(true);
  });
});
