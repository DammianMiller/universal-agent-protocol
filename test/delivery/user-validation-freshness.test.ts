import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkUserValidationFreshness,
  computeTreeStamp,
  resetTrustedReportHash,
  runUserValidation,
} from '../../src/delivery/user-validation.js';
import { USER_PATHS_FILE, type UserPathsManifest } from '../../src/delivery/user-paths.js';
import { runVerify } from '../../src/cli/verify.js';

const PASSING: UserPathsManifest = {
  version: 1,
  paths: [
    { id: 'ok', rule: 'node runs', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', ''] } }, { expect_exit: 0 }] },
  ],
};
const FAILING: UserPathsManifest = {
  version: 1,
  paths: [
    { id: 'boom', rule: 'must exit 0', client: 'cli', steps: [{ run: { argv: [process.execPath, '-e', 'process.exit(1)'] } }, { expect_exit: 0 }] },
  ],
};

function writeManifest(dir: string, manifest: UserPathsManifest): void {
  mkdirSync(join(dir, '.uap'), { recursive: true });
  writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify(manifest, null, 2));
}

function gitInit(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir, env });
}

describe('computeTreeStamp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-stamp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('git-backed: stable when unchanged, changes on any edit', () => {
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n');
    gitInit(dir);
    const a = computeTreeStamp(dir);
    expect(a).toMatch(/^git:/);
    expect(computeTreeStamp(dir)).toBe(a);
    writeFileSync(join(dir, 'app.js'), 'console.log(2)\n');
    expect(computeTreeStamp(dir)).not.toBe(a);
  });

  it('non-git fallback: mtime-based, changes when a source file is newer', async () => {
    writeFileSync(join(dir, 'app.js'), 'x\n');
    const a = computeTreeStamp(dir);
    expect(a).toMatch(/^mtime:/);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, 'app.js'), 'y\n');
    expect(computeTreeStamp(dir)).not.toBe(a);
  });
});

describe('checkUserValidationFreshness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-fresh-'));
    resetTrustedReportHash();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('na without a manifest; missing with a manifest but no report', () => {
    expect(checkUserValidationFreshness(dir).status).toBe('na');
    writeManifest(dir, PASSING);
    expect(checkUserValidationFreshness(dir).status).toBe('missing');
  });

  it('fresh-pass after a green run on an unchanged tree; stale after an edit', async () => {
    writeFileSync(join(dir, 'app.js'), 'x\n');
    writeManifest(dir, PASSING);
    gitInit(dir);
    await runUserValidation(dir);
    expect(checkUserValidationFreshness(dir).status).toBe('fresh-pass');
    writeFileSync(join(dir, 'app.js'), 'edited-after-validation\n');
    expect(checkUserValidationFreshness(dir).status).toBe('stale');
  });

  it('fresh-fail after a red run on an unchanged tree', async () => {
    writeFileSync(join(dir, 'app.js'), 'x\n');
    writeManifest(dir, FAILING);
    gitInit(dir);
    await runUserValidation(dir);
    expect(checkUserValidationFreshness(dir).status).toBe('fresh-fail');
  });
});

describe('runVerify --user-paths-auto (stop-hook mode)', () => {
  let dir: string;
  const savedEnv = process.env.UAP_USER_VALIDATION;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-uvauto-'));
    delete process.env.UAP_USER_VALIDATION; // hermetic: ambient downgrade must not flip assertions
    resetTrustedReportHash();
    // a project with one cheap gate so the ladder is non-empty
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }));
    writeFileSync(join(dir, 'app.js'), 'x\n');
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.UAP_USER_VALIDATION;
    else process.env.UAP_USER_VALIDATION = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('config off ⇒ gate never runs even when stale', async () => {
    writeManifest(dir, FAILING);
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ delivery: { userValidation: 'off' } }));
    const r = await runVerify({ dir, userPathsAuto: true, visual: false });
    expect(r.rungs.some((g) => g.id === 'user-validation')).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('stale/missing report ⇒ gate runs; failing paths exit 1 (the stop-hook blocking code)', async () => {
    writeManifest(dir, FAILING);
    const r = await runVerify({ dir, userPathsAuto: true, visual: false });
    expect(r.rungs.some((g) => g.id === 'user-validation')).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('fresh-pass report ⇒ gate skipped (no re-run cost), verify green', async () => {
    writeManifest(dir, PASSING);
    gitInit(dir);
    await runUserValidation(dir); // sanctioned green run on the current tree
    const r = await runVerify({ dir, userPathsAuto: true, visual: false });
    expect(r.rungs.some((g) => g.id === 'user-validation')).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('green run after edits ⇒ gate runs and passes; advisory config never blocks', async () => {
    writeManifest(dir, PASSING);
    const r = await runVerify({ dir, userPathsAuto: true, visual: false });
    expect(r.rungs.some((g) => g.id === 'user-validation')).toBe(true);
    expect(r.exitCode).toBe(0);

    writeManifest(dir, FAILING);
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ delivery: { userValidation: 'advisory' } }));
    const adv = await runVerify({ dir, userPathsAuto: true, visual: false });
    expect(adv.rungs.some((g) => g.id === 'user-validation')).toBe(true);
    expect(adv.exitCode).toBe(0); // advisory: reported, not blocking
  });
});
