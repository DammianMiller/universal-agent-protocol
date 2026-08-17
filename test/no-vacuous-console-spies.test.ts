/**
 * A spy installed at module scope does not survive `vi.restoreAllMocks()`.
 *
 * test/cli/init.test.ts had this shape:
 *
 *   const mockConsoleError = vi.fn();
 *   vi.spyOn(console, 'error').mockImplementation(mockConsoleError);  // once
 *   afterEach(() => { vi.restoreAllMocks(); });                       // every test
 *   it(...) { await initCommand(...); expect(mockConsoleError).not.toHaveBeenCalled(); }
 *
 * After the first test the spy is gone, so nothing ever reaches the mock again
 * and every later assertion on it is unable to fail. Five of six were dead. The
 * `/custom/path` case proved it: it logged `ENOENT ... /custom/path/.uap.json`
 * to the real stderr on every run and passed regardless — while the ONE test
 * that still had a live spy, the first in the file, went red whenever anything
 * in a loaded environment logged. That is what presented as flakiness.
 *
 * The failure is silent by construction: a vacuous assertion is indistinguishable
 * from a passing one. Nothing else catches it, so this does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';

const REPO = join(__dirname, '..');

/** Every tracked test file. */
function testFiles(): string[] {
  return execFileSync('git', ['ls-files', 'test/**/*.test.ts', 'test/*.test.ts'], {
    cwd: REPO,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
}

describe('console spies must outlive restoreAllMocks', () => {
  it('no test file installs a spy at module scope and then restores mocks per test', () => {
    const offenders: string[] = [];

    for (const rel of testFiles()) {
      const src = readFileSync(join(REPO, rel), 'utf-8');
      if (!/vi\.restoreAllMocks\(\)/.test(src)) continue;

      // Module scope = column 0. A spy inside beforeEach/beforeAll is indented
      // and is re-installed per test, which is the correct arrangement.
      const moduleScopeSpy = /^vi\.spyOn\(/m.test(src);
      if (moduleScopeSpy) offenders.push(rel);
    }

    expect(
      offenders,
      'These install a spy once at module scope and call vi.restoreAllMocks() ' +
        'per test, so the spy dies after the first test and any assertion on it ' +
        'silently stops being able to fail. Move the spy into beforeEach:\n  ' +
        offenders.map((o) => relative(REPO, join(REPO, o))).join('\n  ')
    ).toEqual([]);
  });
});
