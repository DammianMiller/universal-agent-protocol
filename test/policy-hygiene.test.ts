/**
 * Policy hygiene: the dead validate-plan-before-build policy is removed (its
 * schema + enforcer deleted, recommendations repointed to validate-plan-on-change),
 * and local-build-before-push resolves the worktree branch like expert-review.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SCENARIOS } from '../src/config/policy-recommendations.js';

const ROOT = process.cwd();

describe('validate-plan-before-build removal', () => {
  it('its schema and enforcer files are gone', () => {
    expect(existsSync(join(ROOT, 'src/policies/schemas/policies/validate-plan-before-build.md'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/policies/enforcers/validate_plan_before_build.py'))).toBe(false);
  });

  it('replaced by validate-plan-on-change, which does exist', () => {
    expect(existsSync(join(ROOT, 'src/policies/schemas/policies/validate-plan-on-change.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'src/policies/enforcers/validate_plan_on_change.py'))).toBe(true);
  });

  it('no recommendation still points at the dead policy', () => {
    const slugs = SCENARIOS.flatMap((s) => (s.extra ?? []).map((e) => e.slug));
    expect(slugs).not.toContain('validate-plan-before-build');
    expect(slugs).toContain('validate-plan-on-change');
  });
});

describe('local-build-before-push worktree resolution', () => {
  const ENFORCER = join(ROOT, 'src', 'policies', 'enforcers', 'local_build_before_push.py');

  it('resolves changed files from the working tree (uses worktree_root)', () => {
    // Structural guarantee: the enforcer imports worktree_root, not repo_root —
    // so the changed-files diff targets the worktree being pushed, not the pinned
    // main checkout (mirrors the expert-review fix).
    const src = readFileSync(ENFORCER, 'utf-8');
    expect(src).toContain('worktree_root');
    expect(src).not.toMatch(/=\s*repo_root\(\)/);
  });

  it('allows a push with no buildable C++ changes', () => {
    const r = spawnSync(
      'python3',
      [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command: 'git push origin HEAD' })],
      { env: { ...process.env, UAP_WORKTREE_ROOT: ROOT }, encoding: 'utf8' }
    );
    // No apps/api C++ changes in this repo → the gate is not required (exit 0).
    expect(r.status).toBe(0);
  });
});
