/**
 * Model-authored CLI journeys run on whatever box the mission runs on — and
 * the environment used to be able to manufacture UNSATISFIABLE gates:
 *
 * - Journeys assume `python`; boxes often ship only `python3`. The verbatim
 *   spawn ENOENT'd, the run step recorded `exit=null` as OK, and the failure
 *   surfaced one step later as `expect_exit: exit=null` — undiagnosable.
 *   Measured on py-parse-duration (2026-09-02): all three manifest journeys
 *   FAIL'd for 46 turns / 38 minutes on a workdir whose hidden verifier
 *   passed, while the agent flailed (wrapper scripts, conftest edits)
 *   instead of fixing anything real.
 * - A `pytest file.py -q` journey against a PLAIN-SCRIPT in-repo gate exits 5
 *   ("no tests collected") forever; the feedback never said why.
 *
 * These tests pin the accommodations: `python` → `python3` fallback on
 * ENOENT, spawn failures reported at the step where they happen with the
 * fix, and an explicit hint when pytest collects no tests.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runUserValidation } from '../../src/delivery/user-validation.js';
import { USER_PATHS_FILE, type UserPathsManifest } from '../../src/delivery/user-paths.js';

function writeManifest(dir: string, manifest: UserPathsManifest): void {
  mkdirSync(join(dir, '.uap'), { recursive: true });
  writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify(manifest, null, 2));
}

const HAS_PYTEST =
  spawnSync('python3', ['-m', 'pytest', '--version'], { encoding: 'utf8' }).status === 0;

describe('user-validation cli journeys vs the environment', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-journey-interp-'));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back python → python3 when the box has no `python` alias', async () => {
    // A PATH containing ONLY a python3 shim: `python` is guaranteed ENOENT,
    // so this exercises the fallback on every box, even ones with python.
    const bindir = join(dir, 'bin');
    mkdirSync(bindir);
    symlinkSync('/bin/python3', join(bindir, 'python3'));
    process.env.PATH = bindir;

    writeManifest(dir, {
      version: 1,
      paths: [
        {
          id: 'interp',
          rule: 'python journey runs via python3 when python is absent',
          client: 'cli',
          steps: [
            { run: { argv: ['python', '-c', 'print("ok")'] } },
            { expect_exit: 0 },
            { expect_stdout_matches: '^ok$' },
          ],
        },
      ],
    } as never);

    const report = await runUserValidation(dir);
    const result = report.results.find((r) => r.id === 'interp');
    expect(result?.status, JSON.stringify(result?.steps)).toBe('pass');
  });

  it('reports a spawn failure at the step where it happens — never as exit=null', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [
        {
          id: 'enoent',
          rule: 'missing interpreter is named, with the fix',
          client: 'cli',
          steps: [
            { run: { argv: ['uap-definitely-not-a-real-binary', '--version'] } },
            { expect_exit: 0 },
          ],
        },
      ],
    } as never);

    const report = await runUserValidation(dir);
    const result = report.results.find((r) => r.id === 'enoent');
    expect(result?.status).toBe('fail');
    const runStep = result?.steps[0];
    expect(runStep?.ok).toBe(false);
    expect(runStep?.observed).toContain('spawn failed');
    expect(runStep?.observed).toContain('uap-definitely-not-a-real-binary');
    expect(JSON.stringify(result?.steps)).not.toContain('exit=null');
  });

  it.skipIf(!HAS_PYTEST)(
    'explains pytest exit 5 against a plain-script gate instead of failing silently',
    async () => {
      // The real-gate suites ship script-style gates (python3 file.py, no
      // pytest tests). A model-authored `pytest file.py` journey can never
      // pass against one — the failure must SAY that.
      writeFileSync(join(dir, 'check.py'), 'print("ok")\n');
      writeManifest(dir, {
        version: 1,
        paths: [
          {
            id: 'pytest-assumption',
            rule: 'the provided in-repo test suite passes',
            client: 'cli',
            steps: [
              { run: { argv: ['python3', '-m', 'pytest', 'check.py', '-q'] } },
              { expect_exit: 0 },
            ],
          },
        ],
      } as never);

      const report = await runUserValidation(dir);
      const result = report.results.find((r) => r.id === 'pytest-assumption');
      expect(result?.status).toBe('fail');
      const expectStep = result?.steps.find((s) => s.step.includes('expect_exit'));
      expect(expectStep?.observed).toContain('plain script');
    },
  );
});
