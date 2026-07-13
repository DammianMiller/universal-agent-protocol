/**
 * enforcement-self-protect must anchor its "/policies/" (and sibling) markers to
 * a real path SEGMENT — not any path that merely contains the substring. A
 * worktree named `*-policies` or a file like `policy-select.ts` must NOT be
 * treated as enforcement-control code, while genuine src/policies/.policy-tools/
 * .uap files still are.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_self_protect.py');
const REPO = '/tmp/uap-selfprotect-fakerepo';

/** exit 0 = allowed, 2 = blocked (protected). */
function editExit(relPath: string): number {
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Edit', '--args', JSON.stringify({ file_path: `${REPO}/${relPath}` })],
    { env: { ...process.env, UAP_REPO_ROOT: REPO, UAP_SELF_PROTECT_OFF: '' }, encoding: 'utf8' }
  );
  return r.status ?? -1;
}

describe('enforcement-self-protect marker anchoring', () => {
  it('ALLOWS paths that merely contain "policies" as a word fragment', () => {
    expect(editExit('.worktrees/331-setup-all-policies/src/cli/policy-select.ts')).toBe(0);
    expect(editExit('src/cli/policy-select.ts')).toBe(0);
    expect(editExit('docs/my-policies-notes.md')).toBe(0);
    expect(editExit('src/coordination/policies-helper.ts')).toBe(0);
  });

  it('ALLOWS the expert-review escape-hatch paths (review artifact + waiver)', () => {
    // These live UNDER a protected marker (.uap/, policies/) but are the
    // SEPARATE expert-review gate's escape hatches — writing them satisfies
    // expert-review-required and cannot weaken delivery enforcement. Without the
    // carve-out the two gates deadlock (expert-review demands an artifact that
    // self-protect forbids writing).
    expect(editExit('.uap/reviews/feature%2Fx.json')).toBe(0);
    expect(editExit('.uap/reviews/WAIVER')).toBe(0);
    expect(editExit('policies/waivers/2026-expert-review.md')).toBe(0);
  });

  it('still BLOCKS the genuine enforcement-control surface', () => {
    expect(editExit('src/policies/enforcers/foo.py')).toBe(2);
    expect(editExit('src/policies/schemas/policies/x.md')).toBe(2);
    expect(editExit('.worktrees/42-feat/src/policies/bar.py')).toBe(2); // worktree, but real src/policies
    expect(editExit('policies/custom.md')).toBe(2); // repo-root policies/ dir (non-waiver)
    expect(editExit('.policy-tools/x.py')).toBe(2);
    expect(editExit('.uap.json')).toBe(2);
    expect(editExit('.uap/user-paths.json')).toBe(2); // non-review .uap/ stays protected
    expect(editExit('.claude/hooks/uap-policy-gate.sh')).toBe(2);
  });
});
