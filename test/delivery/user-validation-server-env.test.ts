/**
 * Acceptance evidence for the startManifestServer env contract (mission
 * run-20260824T054426): manifest servers run project/model code, so the
 * spawned child must inherit a SECRET-STRIPPED environment — env built from
 * { ...sanitizedEnv(), ...srv.env } — with declared srv.env overrides still
 * applied on top.
 *
 * Performs the interaction end-to-end through the public runUserValidation
 * API: a real manifest server is spawned, it captures the environment it
 * actually inherited, and the assertions check the observable effect rather
 * than the call-site's shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { runUserValidation } from '../../src/delivery/user-validation.js';

/** Grab an unused TCP port (listen on 0, then release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

describe('startManifestServer env contract (sanitizedEnv at the spawn site)', () => {
  let root: string;
  let dump: string;
  const plantedSecret = 'UAP_TEST_API_KEY'; // matches SECRET_ENV_RE (API_KEY)
  const plantedBenign = 'UAP_TEST_BENIGN_VALUE';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-srv-env-'));
    mkdirSync(join(root, '.uap'), { recursive: true });
    dump = join(root, 'env-dump.json');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('strips secret-looking host vars, keeps benign ones, sets CI, and applies srv.env overrides', async () => {
    const port = await freePort();
    const prevSecret = process.env[plantedSecret];
    const prevBenign = process.env[plantedBenign];
    process.env[plantedSecret] = 'supersecret-value';
    process.env[plantedBenign] = 'kept-value';
    try {
      // The server writes the environment it INHERITED (i.e. what
      // startManifestServer's spawn actually passed) to a file, then serves
      // HTTP so the readiness poll and the http journey both succeed.
      const serverCode =
        `require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));` +
        `require('http').createServer((q, s) => { s.end('ok'); }).listen(${port});`;
      writeFileSync(
        join(root, '.uap', 'user-paths.json'),
        JSON.stringify({
          version: 1,
          server: {
            command: 'node',
            args: ['-e', serverCode],
            port,
            readyTimeoutMs: 20_000,
            env: { OVERRIDE_ME: 'declared' },
          },
          paths: [
            {
              id: 'server-responds',
              rule: 'manifest server responds on its declared port',
              client: 'http',
              steps: [
                { request: { path: '/' } },
                { expect_status: 200 },
              ],
            },
          ],
        })
      );

      const report = await runUserValidation(root, { timeoutMs: 20_000 });
      expect(report.verdict).toBe('pass');

      // If a racer took the port after freePort() released it, the node -e
      // child dies on EADDRINUSE and the journey is served by the built-in
      // static-server fallback — the env dump never appears. Fail HERE, with
      // a message naming the race, instead of an opaque ENOENT below.
      expect(
        existsSync(dump),
        'manifest server was not spawned (port race?) — built-in fallback served the journey'
      ).toBe(true);

      const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
      expect(childEnv[plantedSecret]).toBeUndefined(); // host secret stripped
      expect(childEnv[plantedBenign]).toBe('kept-value'); // benign env preserved
      expect(childEnv.CI).toBe('true'); // CI marker injected by sanitizedEnv
      expect(childEnv.OVERRIDE_ME).toBe('declared'); // srv.env override applied
    } finally {
      if (prevSecret === undefined) delete process.env[plantedSecret];
      else process.env[plantedSecret] = prevSecret;
      if (prevBenign === undefined) delete process.env[plantedBenign];
      else process.env[plantedBenign] = prevBenign;
    }
  }, 60_000);
});
