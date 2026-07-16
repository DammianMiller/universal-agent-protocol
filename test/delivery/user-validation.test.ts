import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildUserPathsNote,
  createUserValidationRunner,
  getTrustedReportHash,
  jsonContains,
  resetTrustedReportHash,
  resolveUserValidationMode,
  runUserValidation,
  synthesizeUserValidationRung,
  USER_VALIDATION_RUNG_ID,
  VALIDATION_REPORT_FILE,
} from '../../src/delivery/user-validation.js';
import { USER_PATHS_FILE, type UserPathsManifest } from '../../src/delivery/user-paths.js';
import { runTieredLadder, type GateRung } from '../../src/delivery/verifier-ladder.js';

// Hermetic env: ambient UAP_USER_VALIDATION (e.g. an operator downgrade, or
// deliver's own subprocess env when this repo is itself a deliver target)
// must not flip mode-resolution assertions.
function hermeticEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('UAP_USER_VALIDATION' in extra)) delete e.UAP_USER_VALIDATION;
  return e;
}

function writeManifest(dir: string, manifest: UserPathsManifest): void {
  mkdirSync(join(dir, '.uap'), { recursive: true });
  writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify(manifest, null, 2));
}

describe('resolveUserValidationMode', () => {
  it('defaults to block; config values win; env downgrades block to advisory only', () => {
    expect(resolveUserValidationMode(undefined, hermeticEnv())).toBe('block');
    expect(resolveUserValidationMode('advisory', hermeticEnv())).toBe('advisory');
    expect(resolveUserValidationMode('off', hermeticEnv())).toBe('off');
    expect(resolveUserValidationMode(false, hermeticEnv())).toBe('off');
    expect(resolveUserValidationMode(undefined, hermeticEnv({ UAP_USER_VALIDATION: '0' }))).toBe('advisory');
    // env never resurrects an explicit off, and never downgrades below advisory
    expect(resolveUserValidationMode('off', hermeticEnv({ UAP_USER_VALIDATION: '0' }))).toBe('off');
    expect(resolveUserValidationMode('advisory', hermeticEnv({ UAP_USER_VALIDATION: '0' }))).toBe('advisory');
  });
});

describe('jsonContains', () => {
  it('deep subset matching', () => {
    expect(jsonContains({ a: 1, b: { c: 'x', d: 2 } }, { b: { c: 'x' } })).toBe(true);
    expect(jsonContains({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonContains([{ id: 1 }, { id: 2, name: 'x' }], { name: 'x' })).toBe(true);
    expect(jsonContains({ list: [1, 2] }, { list: [2] })).toBe(true);
    expect(jsonContains(null, { a: 1 })).toBe(false);
  });
});

describe('synthesizeUserValidationRung', () => {
  it('maps mode to rung requiredness; off means no rung', () => {
    expect(synthesizeUserValidationRung('off')).toBeNull();
    expect(synthesizeUserValidationRung('block')?.required).toBe(true);
    expect(synthesizeUserValidationRung('advisory')?.required).toBe(false);
    expect(synthesizeUserValidationRung('block')?.tier).toBe('final');
  });
});

describe('runUserValidation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-uservalidation-'));
    resetTrustedReportHash();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('verdict na when no manifest exists — and writes the report saying so', () => {
    return runUserValidation(dir).then((report) => {
      expect(report.verdict).toBe('na');
      expect(report.naReason).toContain('no');
      const onDisk = JSON.parse(readFileSync(join(dir, VALIDATION_REPORT_FILE), 'utf8'));
      expect(onDisk.verdict).toBe('na');
      expect(getTrustedReportHash()).toBeTruthy();
    });
  });

  it('cli paths run the real binary: pass and fail observed from actual exits', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [
        {
          id: 'ok',
          rule: 'node evaluates',
          client: 'cli',
          steps: [
            { run: { argv: [process.execPath, '-e', 'console.log("hello-user"); process.exit(0)'] } },
            { expect_exit: 0 },
            { expect_stdout_matches: 'hello-user' },
          ],
        },
        {
          id: 'bad',
          rule: 'exit code surfaces',
          client: 'cli',
          steps: [
            { run: { argv: [process.execPath, '-e', 'process.exit(3)'] } },
            { expect_exit: 0 },
          ],
        },
      ],
    });
    const report = await runUserValidation(dir);
    expect(report.verdict).toBe('fail');
    expect(report.results.find((r) => r.id === 'ok')?.status).toBe('pass');
    const bad = report.results.find((r) => r.id === 'bad');
    expect(bad?.status).toBe('fail');
    expect(bad?.steps.find((s) => !s.ok)?.observed).toContain('exit=3');
  });

  it('non-final epic downgrades a whole-mission FAIL to NA (deferred, not a defect)', async () => {
    // A decomposed epic mission cannot pass whole-mission journeys until the
    // FINAL epic assembles the app; gating an early epic on the finished app
    // freezes phaseIndex at 0. UAP_EPIC_NONFINAL=1 (set by the epic controller
    // for non-final epics) reports NA instead of FAIL so the epic can converge.
    writeManifest(dir, {
      version: 1,
      paths: [
        { id: 'bad', rule: 'exit surfaces', client: 'cli',
          steps: [{ run: { argv: [process.execPath, '-e', 'process.exit(3)'] } }, { expect_exit: 0 }] },
      ],
    });
    const prev = process.env.UAP_EPIC_NONFINAL;
    try {
      process.env.UAP_EPIC_NONFINAL = '1';
      const report = await runUserValidation(dir);
      expect(report.verdict).toBe('na'); // downgraded from fail
      expect(report.results.find((r) => r.id === 'bad')?.status).toBe('fail'); // the path still records the real failure
      expect(report.naReason).toContain('non-final epic');
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_NONFINAL;
      else process.env.UAP_EPIC_NONFINAL = prev;
    }
  });

  it('invalid manifest is a FAIL (not silent na)', async () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify({ version: 1, paths: [{ id: 'x' }] }));
    const report = await runUserValidation(dir);
    expect(report.verdict).toBe('fail');
  });

  it('http path without a server entry fails with an actionable message', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [
        { id: 'api', rule: 'r', client: 'http', steps: [{ request: { method: 'GET', path: '/x' } }, { expect_status: 200 }] },
      ],
    });
    const report = await runUserValidation(dir);
    expect(report.verdict).toBe('fail');
    expect(report.results[0].steps[0].observed).toContain('server');
  });

  it('browser unavailable ⇒ browser paths skipped, verdict na when nothing else ran', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [
        { id: 'ui', rule: 'r', client: 'browser', entry: 'index.html', steps: [{ goto: '/' }, { expect_no_console_errors: true }] },
      ],
    });
    const report = await runUserValidation(dir, { browserLoader: async () => null });
    expect(report.verdict).toBe('na');
    expect(report.results[0].status).toBe('skipped');
    expect(report.browserAvailable).toBe(false);
  });
});

describe('buildUserPathsNote (report trust)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-uvnote-'));
    resetTrustedReportHash();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no report ⇒ no note', () => {
    expect(buildUserPathsNote(dir)).toBeNull();
  });

  it('runner-written report ⇒ trusted note reflecting the verdict', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [{ id: 'ok', rule: 'node runs', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', ''] } }, { expect_exit: 0 }] }],
    });
    await runUserValidation(dir);
    const note = buildUserPathsNote(dir);
    expect(note?.trusted).toBe(true);
    expect(note?.note).toContain('ALL PASSED');
  });

  it('failed verdict names the failing paths', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [{ id: 'boom', rule: 'must exit 0', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', 'process.exit(1)'] } }, { expect_exit: 0 }] }],
    });
    await runUserValidation(dir);
    const note = buildUserPathsNote(dir);
    expect(note?.trusted).toBe(true);
    expect(note?.note).toContain('FAILED');
    expect(note?.note).toContain('boom');
  });

  it('hand-edited (fabricated) report ⇒ untrusted note', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [{ id: 'boom', rule: 'r', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', 'process.exit(1)'] } }, { expect_exit: 0 }] }],
    });
    await runUserValidation(dir);
    // Model fakes a green report after the sanctioned run:
    const file = join(dir, VALIDATION_REPORT_FILE);
    const forged = JSON.parse(readFileSync(file, 'utf8'));
    forged.verdict = 'pass';
    forged.results = [];
    writeFileSync(file, JSON.stringify(forged, null, 2) + '\n');
    const note = buildUserPathsNote(dir);
    expect(note?.trusted).toBe(false);
    expect(note?.note).toContain('NOT produced by the sanctioned runner');
  });
});

describe('final tier + createUserValidationRunner in the ladder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-uvladder-'));
    resetTrustedReportHash();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const passingCliManifest: UserPathsManifest = {
    version: 1,
    paths: [{ id: 'ok', rule: 'r', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', ''] } }, { expect_exit: 0 }] }],
  };

  function fastRung(pass: boolean): GateRung {
    return {
      id: 'fake-fast',
      name: 'fake fast rung',
      command: process.execPath,
      args: ['-e', pass ? '' : 'process.exit(1)'],
      required: true,
      timeoutMs: 20_000,
    };
  }

  it('final tier is in scope at the default ceiling and runs after green tiers', async () => {
    writeManifest(dir, passingCliManifest);
    const rungs = [fastRung(true), synthesizeUserValidationRung('block')!];
    const result = await runTieredLadder(rungs, dir, {
      userValidationRunner: createUserValidationRunner(),
    });
    expect(result.passed).toBe(true);
    const uv = result.results.find((r) => r.id === USER_VALIDATION_RUNG_ID);
    expect(uv?.passed).toBe(true);
    expect(uv?.skipped).toBeFalsy();
  });

  it('final tier does NOT run when a cheaper tier failed (no wasted browser cost)', async () => {
    writeManifest(dir, passingCliManifest);
    const rungs = [fastRung(false), synthesizeUserValidationRung('block')!];
    const result = await runTieredLadder(rungs, dir, {
      userValidationRunner: createUserValidationRunner(),
    });
    expect(result.passed).toBe(false);
    const uv = result.results.find((r) => r.id === USER_VALIDATION_RUNG_ID);
    expect(uv?.skipped).toBe(true);
  });

  it('block mode: failing user paths fail the ladder; advisory does not', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [{ id: 'boom', rule: 'r', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', 'process.exit(1)'] } }, { expect_exit: 0 }] }],
    });
    const blocked = await runTieredLadder([fastRung(true), synthesizeUserValidationRung('block')!], dir, {
      userValidationRunner: createUserValidationRunner(),
    });
    expect(blocked.passed).toBe(false);
    expect(blocked.feedback).toContain('FAIL boom');
    expect(blocked.feedback).toContain('does not work for a real user');

    const advisory = await runTieredLadder([fastRung(true), synthesizeUserValidationRung('advisory')!], dir, {
      userValidationRunner: createUserValidationRunner(),
    });
    expect(advisory.passed).toBe(true);
  });

  it('na (no manifest) is skipped-not-failed even in block mode', async () => {
    const result = await runTieredLadder([fastRung(true), synthesizeUserValidationRung('block')!], dir, {
      userValidationRunner: createUserValidationRunner(),
    });
    expect(result.passed).toBe(true);
    const uv = result.results.find((r) => r.id === USER_VALIDATION_RUNG_ID);
    expect(uv?.skipped).toBe(true);
  });
});
