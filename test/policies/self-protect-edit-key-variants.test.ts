/**
 * enforcement-self-protect: Edit ops must resolve the target file under every
 * harness's key convention.
 *
 * The extraction read only file_path/path/target. opencode sends camelCase
 * `filePath`, so an agent edit aimed at a protected control file landed on the
 * fail-open "no file path in args" branch and was ALLOWED — observed live: a
 * looping client repeatedly attempted to strip a policy flag from .uap.json,
 * and the gate's SEC_SENSITIVE net armed but this enforcer blinked first.
 *
 * These tests pin the widened key list: every convention that names a file must
 * reach the protected-path check, and none of them may over-block a normal
 * file.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_self_protect.py');

type Verdict = { exit: number; allowed: boolean; reason: string };

/**
 * Run an Edit adjudication with a raw args object, exactly as the policy gate
 * does. UAP_SELF_PROTECT_OFF is cleared so the operator override cannot
 * silently turn a refusal into an allow and make the test lie.
 */
function runEdit(args: Record<string, string>): Verdict {
  const r = spawnSync('python3', [ENFORCER, '--operation', 'edit', '--args', JSON.stringify(args)], {
    encoding: 'utf8',
    env: { ...process.env, UAP_SELF_PROTECT_OFF: '' },
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

function expectBlocked(v: Verdict) {
  expect(v.allowed).toBe(false);
  expect(v.exit).toBe(2);
  expect(v.reason).toMatch(/BLOCKED/);
}

describe('self-protect resolves Edit targets across harness key conventions', () => {
  const protectedFile = join(process.cwd(), '.uap.json');
  const normalFile = join(process.cwd(), 'README.md');
  const payload = (filePath: string) => ({ filePath, oldString: 'x', newString: 'y' });

  it('blocks a protected-file edit named with opencode camelCase filePath', () => {
    // Regression: this exact shape previously allowed with "no file path in args".
    expectBlocked(runEdit(payload(protectedFile)));
  });

  it('blocks a protected-file edit named with claude snake_case file_path', () => {
    expectBlocked(runEdit({ file_path: protectedFile, old_string: 'x', new_string: 'y' }));
  });

  it('blocks a protected-file edit named with the generic path and target keys', () => {
    expectBlocked(runEdit({ path: protectedFile, old: 'x', new: 'y' }));
    expectBlocked(runEdit({ target: protectedFile, old: 'x', new: 'y' }));
  });

  it('still allows a normal-file edit named with camelCase filePath', () => {
    const v = runEdit(payload(normalFile));
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('not an enforcement-control file');
  });

  it('still fails open when no convention names a file', () => {
    const v = runEdit({ oldString: 'x', newString: 'y' });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('no file path in args');
  });
});
