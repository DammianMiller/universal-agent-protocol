/**
 * `.policy-tools/` holds MATERIALISED copies of the enforcers in
 * `src/policies/enforcers/`. They are generated, and their filenames embed a
 * UUID drawn from each machine's local `policies.db` — so the same enforcer is
 * `217a4baf-…_memory_before_plan.py` here and `fae29f42-…_memory_before_plan.py`
 * on the next checkout. Nothing about them is portable.
 *
 * The directory has always been listed in .gitignore, but 16 files inside it
 * were tracked anyway (added before the ignore rule, so the rule never applied
 * to them). That combination is the worst of both: git kept serving a copy that
 * no other machine could use, and — because the installer silently failed to
 * re-materialise for over a week — that copy went stale without anyone noticing.
 * `_common.py` was 106 lines behind its own source when this was found.
 *
 * Untracking them makes the drift impossible rather than merely fixed: there is
 * no second copy left to disagree with the source.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

function tracked(pathspec: string): string[] {
  const out = execFileSync('git', ['ls-files', pathspec], { cwd: ROOT, encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

describe('.policy-tools/ is generated, not versioned', () => {
  it('tracks no files, so a materialised copy can never go stale in git', () => {
    expect(tracked('.policy-tools')).toEqual([]);
  });

  it('is still ignored, so a stray `git add` does not silently re-track one', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf-8');
    expect(ignore).toMatch(/^\.policy-tools\/?$/m);
  });

  it('keeps the real enforcers in source control', () => {
    // The point is not to stop versioning enforcers — it is to version them in
    // exactly one place. If this ever empties, the untracking above went too far.
    const sources = tracked('src/policies/enforcers').filter((f) => f.endsWith('.py'));
    expect(sources.length).toBeGreaterThan(20);
    expect(sources).toContain('src/policies/enforcers/_common.py');
  });
});

describe('nothing in the test suite reads the generated directory', () => {
  it('no test resolves a path into .policy-tools/', () => {
    // Six fixtures used to copy their enforcer out of `.policy-tools/`, two of
    // them hardcoding a UUID filename that is minted per machine. They passed in
    // CI only because those generated files were tracked by accident — untracking
    // them turned CI red, which is the dependency showing itself.
    //
    // A test that reads a materialised copy is not testing the code under
    // review; it is testing whatever the installer last wrote on that box.
    const offenders = tracked('test')
      .filter((f) => /\.(ts|js|py|sh)$/.test(f))
      .filter((f) => {
        const src = readFileSync(join(ROOT, f), 'utf-8');
        // This file names the directory throughout, in prose and in assertions.
        if (f.endsWith('policy-tools-untracked.test.ts')) return false;
        // A fixture may CREATE .policy-tools inside its own temp project; what
        // must not happen is resolving a path against the repo's own copy.
        return /\.\.\/\.policy-tools|join\(\s*REPO\s*,\s*'\.policy-tools'/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});

describe('deleted policies leave nothing behind in git', () => {
  it('validate-plan-before-build is gone from every tracked location', () => {
    // It was replaced by validate-plan-on-change. test/policy-hygiene.test.ts
    // already asserts the source files are gone — but the MATERIALISED copy
    // survived in git and on disk, still registered as an executable tool, and
    // went on enforcing a policy the repo had deliberately removed.
    expect(tracked('.').filter((f) => f.includes('validate_plan_before_build'))).toEqual([]);
    expect(existsSync(join(ROOT, 'src/policies/enforcers/validate_plan_on_change.py'))).toBe(true);
  });
});
