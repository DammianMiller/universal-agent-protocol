/**
 * CLI-entry fallback of src/delivery/plan-check.ts — the argv-token path.
 *
 * The CLI block must fire for an invocation whose argv[1] cannot realpath-match
 * the module (renamed/symlinked copy, relative argv[1] from a foreign cwd — the
 * case where the deliver loop's plan-check spawn silently no-oped), and it
 * must key on the REQUIRED flag `--plan-id` ONLY. A bare `--mode` token must
 * NOT fire it: `--mode` is generic, this module is imported at startup by the
 * deliver pipeline (decompose.ts), and a process whose argv merely contains
 * the token — e.g. a deliver instruction quoting the flag — would otherwise be
 * hijacked into the exit(1) "Missing plan-id" path at import time.
 *
 * Probes run the BUILT module (dist/) in a subprocess with a faked argv,
 * because the CLI block executes at import time — mutating process.argv
 * in-process would kill the vitest worker. Skipped when dist is absent
 * (CI builds before testing; a bare `npm test` on an unbuilt checkout skips).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'delivery',
  'plan-check.js'
);
const haveBuild = existsSync(MODULE);

/** Run the built module with argv[1] pointing at a path that can never match
 * (the renamed-copy / foreign-cwd case) plus the given CLI tokens. */
function probe(tokens: string[]): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), 'uap-plancheck-cli-'));
  try {
    const wrapper = join(dir, 'probe.mjs');
    const argv = [process.execPath, '/definitely/not/the/module.js', ...tokens]
      .map((t) => JSON.stringify(t))
      .join(', ');
    writeFileSync(
      wrapper,
      `process.argv = [${argv}];\nawait import(${JSON.stringify(MODULE)});\n`
    );
    return spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('plan-check CLI entry — argv tokens, not argv[1]', () => {
  it.skipIf(!haveBuild)(
    'fires the CLI block on --plan-id even when argv[1] cannot match (renamed copy / foreign cwd)',
    () => {
      const r = probe(['--plan-id', 'probe-ok', '--mode', 'dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Plan probe-ok completed (dry-run: no phases executed)');
    }
  );

  it.skipIf(!haveBuild)(
    'does NOT fire for a bare --mode token — an importing process carrying the generic flag survives',
    () => {
      const r = probe(['--mode', 'dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  );

  it.skipIf(!haveBuild)('a library import carrying neither token runs nothing (silent, exit 0)', () => {
    const r = probe([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
