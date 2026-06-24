import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'workdir_scope.py');
const ROOT = process.cwd();

function run(
  op: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {}
): { exit: number; allowed: boolean; reason: string } {
  // Scrub the operator escape hatch from the inherited env so the test is
  // hermetic — otherwise an ambient UAP_WORKDIR_SCOPE_OFF=1 would disable the
  // enforcer and mask the "still blocks" assertions.
  const baseEnv = { ...process.env };
  delete baseEnv.UAP_WORKDIR_SCOPE_OFF;
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', op, '--args', JSON.stringify(args)],
    { env: { ...baseEnv, UAP_REPO_ROOT: ROOT, UAP_WORKTREE_ROOT: ROOT, ...env }, encoding: 'utf8' }
  );
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

describe('workdir-scope enforcer — /dev device nodes', () => {
  // Regression: `2>/dev/null` (and other /dev/* redirects) were flagged as
  // OUTSIDE the project, which blocked routine commands like `uap worktree ...`.
  it('allows a Bash command redirecting stderr to /dev/null', () => {
    const r = run('Bash', { command: 'uap worktree ensure --strict 2>/dev/null' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('allows redirects to /dev/stdout and /dev/stderr', () => {
    expect(run('Bash', { command: 'echo hi >/dev/stdout' }).allowed).toBe(true);
    expect(run('Bash', { command: 'echo hi 2>/dev/stderr' }).allowed).toBe(true);
  });

  it('allows a direct write op targeting /dev/null', () => {
    const r = run('Write', { file_path: '/dev/null' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('still BLOCKS a real out-of-scope absolute write target (exit 2)', () => {
    const r = run('Bash', { command: 'mkdir -p /etc/uap-escape-test' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/OUTSIDE the project/);
  });

  it('still allows in-scope relative writes', () => {
    const r = run('Bash', { command: 'mkdir -p ./scratch 2>/dev/null' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });
});
