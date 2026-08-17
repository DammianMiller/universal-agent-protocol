/**
 * A bare `require()` in this codebase is a runtime landmine that every gate
 * waves through.
 *
 * `package.json` sets `"type": "module"` and the build is plain `tsc`, so
 * `dist/**` is real ESM where `require` is not a binding. But `@types/node`
 * declares it globally, so `tsc --noEmit` and `npm run build` pass; and
 * vite-node injects one, so the whole vitest suite passes. The failure appears
 * only when a user runs the shipped CLI.
 *
 * That is not hypothetical. `schema-diff.ts` shipped `baseResolves()` using a
 * bare require: in `dist` it threw ReferenceError, the function's own catch
 * swallowed it, and it returned false unconditionally — silently disabling a
 * security check that had just been added to close a gate bypass. Verified
 * against the built artifact: the CLI reported "HEAD~1 is not a commit here"
 * for a repo where it was, and recorded a pass.
 *
 * The two legitimate uses shim it first (`createRequire(import.meta.url)`).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

const repoRoot = join(__dirname, '..');

describe('ESM safety', () => {
  it('no source file calls a bare require()', () => {
    let out = '';
    try {
      // -n for line numbers; a non-zero exit just means "no matches".
      out = execFileSync(
        'grep',
        ['-rn', '--include=*.ts', '-E', String.raw`(^|[^.\w])require\s*\(`, 'src'],
        { cwd: repoRoot, encoding: 'utf-8' }
      );
    } catch {
      out = '';
    }

    const offenders = out
      .split('\n')
      .filter(Boolean)
      // A file that builds its own `require` via createRequire is fine.
      .filter((line) => !/createRequire/.test(line))
      // Type positions (`typeof import`) and comments are not calls.
      .filter((line) => !/^\s*\S+:\d+:\s*(\*|\/\/)/.test(line));

    const shimmed = offenders.filter((line) => {
      const file = line.split(':')[0];
      const src = execFileSync('cat', [file], { cwd: repoRoot, encoding: 'utf-8' });
      return src.includes('createRequire(import.meta.url)');
    });

    expect(offenders.filter((l) => !shimmed.includes(l))).toEqual([]);
  });
});
