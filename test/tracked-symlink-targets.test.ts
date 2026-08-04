/**
 * A tracked symlink must point at a tracked file.
 *
 * `.claude/hooks/` and three other platform dirs symlink 9 hooks each into
 * `.factory/hooks/`, which is the canonical store. Untracking `.factory/hooks/`
 * as if it were install output left every one of those tracked symlinks
 * dangling in a fresh checkout — the working tree still had the targets, so it
 * passed locally and failed in CI with 17 broken hook tests.
 *
 * This is the check that would have caught it before the push: it compares the
 * INDEX against itself rather than the working tree, so a file that merely
 * happens to exist on disk cannot mask a missing one.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { dirname, join, relative, resolve } from 'path';

const ROOT = process.cwd();

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/** Paths git records as symlinks (mode 120000), with their link text. */
function trackedSymlinks(): Array<{ path: string; target: string }> {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);

  const links: Array<{ path: string; target: string }> = [];
  for (const entry of out) {
    // "<mode> <sha> <stage>\t<path>"
    const [meta, path] = entry.split('\t');
    if (!path || !meta.startsWith('120000')) continue;
    const sha = meta.split(/\s+/)[1];
    const target = execFileSync('git', ['cat-file', 'blob', sha], {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim();
    links.push({ path, target });
  }
  return links;
}

describe('tracked symlinks resolve to tracked files', () => {
  it('every tracked symlink points at something else that is tracked', () => {
    const trackedSet = new Set(tracked());
    const broken: string[] = [];

    for (const { path, target } of trackedSymlinks()) {
      // Link text is relative to the symlink's own directory.
      const resolved = resolve(dirname(join(ROOT, path)), target);
      const rel = relative(ROOT, resolved);

      // Links pointing outside the repo are somebody else's problem.
      if (rel.startsWith('..')) continue;
      if (!trackedSet.has(rel)) broken.push(`${path} -> ${rel} (target not tracked)`);
    }

    expect(broken, `dangling in a fresh checkout:\n${broken.join('\n')}`).toEqual([]);
  });

  it('the canonical factory hooks are tracked, since other platforms link to them', () => {
    // Guards the specific mistake: .factory/hooks/ looks like a per-platform
    // copy and is not — it is the target of tracked links in .claude/hooks/.
    const trackedSet = new Set(tracked());
    expect(trackedSet.has('.factory/hooks/pre-tool-use-bash.sh')).toBe(true);
    expect(trackedSet.has('.factory/hooks/pre-tool-use-edit-write.sh')).toBe(true);
  });
});
