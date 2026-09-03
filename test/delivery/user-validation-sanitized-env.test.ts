/**
 * The two spawn sites in user-validation.ts that run PROJECT/MODEL code must
 * receive a secret-stripped environment.
 *
 * sanitized-env.test.ts already covers sanitizedEnv() itself. What that cannot
 * catch is the regression this file exists for: a spawn site that simply never
 * calls it. `runCliPath` passed no `env` at all (so the child inherited the
 * full parent environment, credentials included) and `startManifestServer`
 * spread `...process.env` explicitly. Both are asserted here through the real
 * public entry point, so the check is behavioural -- a child process reports
 * what it can actually see -- rather than a grep over the source.
 *
 * Each test also asserts a benign variable SURVIVES. Without that control, a
 * bug that handed the child an empty environment would pass the secret
 * assertion while breaking every real user path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runUserValidation } from '../../src/delivery/user-validation.js';
import { USER_PATHS_FILE, type UserPathsManifest } from '../../src/delivery/user-paths.js';

const SECRET_VAR = 'UAP_TEST_OPENAI_API_KEY';
const SECRET_VALUE = 'sk-must-never-reach-a-child-process';

/**
 * Hardcoded ports collide with unrelated local services (2026-09-02: a host
 * service holding even ports 39470-39478 failed 'startManifestServer: a
 * declared server env var still reaches the child' with EADDRINUSE while CI
 * stayed green). Grab an ephemeral port per test instead.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('no port'))));
    });
  });
}

function writeManifest(dir: string, manifest: UserPathsManifest): void {
  mkdirSync(join(dir, '.uap'), { recursive: true });
  writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify(manifest, null, 2));
}

describe('user-validation spawns get a secret-stripped environment', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-sanitized-spawn-'));
    process.env[SECRET_VAR] = SECRET_VALUE;
  });

  afterEach(() => {
    delete process.env[SECRET_VAR];
    delete process.env.UAP_TEST_DECLARED_VAR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('runCliPath: the CLI step cannot see a credential, but keeps a benign var', async () => {
    writeManifest(dir, {
      version: 1,
      paths: [
        {
          id: 'cli-env',
          rule: 'cli steps run without credentials in scope',
          client: 'cli',
          steps: [
            {
              run: {
                argv: [
                  process.execPath,
                  '-e',
                  `console.log('SECRET=' + (process.env.${SECRET_VAR} ?? 'ABSENT') +` +
                    ` ' PATH=' + (process.env.PATH ? 'present' : 'missing'))`,
                ],
              },
            },
            { expect_exit: 0 },
            { expect_stdout_matches: 'SECRET=ABSENT PATH=present' },
          ],
        },
      ],
    } as never);

    const report = await runUserValidation(dir);
    const result = report.results.find((r) => r.id === 'cli-env');
    expect(result?.status, JSON.stringify(result?.steps)).toBe('pass');

    // Belt and braces: the value must not appear anywhere in the report either.
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
  });

  it('startManifestServer: the server cannot see a credential, but keeps a benign var', async () => {
    const port = await freePort();
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    writeManifest(dir, {
      version: 1,
      server: {
        command:
          `${process.execPath} -e require('http').createServer((q,r)=>r.end(` +
          `'secret='+(process.env.${SECRET_VAR}||'ABSENT')+` +
          `';path='+(process.env.PATH?'present':'missing'))).listen(${port})`,
        port,
        readyTimeoutMs: 10000,
      },
      paths: [
        {
          id: 'srv-env',
          rule: 'server runs without credentials in scope',
          client: 'http',
          steps: [
            { request: { method: 'GET', path: '/' } },
            { expect_status: 200 },
            { expect_body_matches: 'secret=ABSENT;path=present' },
          ],
        },
      ],
    } as never);

    const report = await runUserValidation(dir);
    const result = report.results.find((r) => r.id === 'srv-env');
    expect(result?.status, JSON.stringify(result?.steps)).toBe('pass');
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
  });

  it('startManifestServer: a declared server env var still reaches the child', async () => {
    // sanitizedEnv(srv.env) must merge the DECLARED vars last. If the argument
    // were dropped, or applied first, a manifest could no longer configure its
    // own server -- a silent break of every project that declares server env.
    const port = await freePort();
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    writeManifest(dir, {
      version: 1,
      server: {
        command:
          `${process.execPath} -e require('http').createServer((q,r)=>r.end(` +
          `'declared='+(process.env.UAP_TEST_DECLARED_VAR||'MISSING'))).listen(${port})`,
        port,
        readyTimeoutMs: 10000,
        env: { UAP_TEST_DECLARED_VAR: 'declared-value' },
      },
      paths: [
        {
          id: 'srv-declared',
          rule: 'declared server env survives sanitising',
          client: 'http',
          steps: [
            { request: { method: 'GET', path: '/' } },
            { expect_status: 200 },
            { expect_body_matches: 'declared=declared-value' },
          ],
        },
      ],
    } as never);

    const report = await runUserValidation(dir);
    const result = report.results.find((r) => r.id === 'srv-declared');
    expect(result?.status, JSON.stringify(result?.steps)).toBe('pass');
  });
});
