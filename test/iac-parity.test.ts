/**
 * Tests for the iac-parity enforcer's over-matching fix.
 * It must gate only live-state MUTATING shell commands (kubectl apply, helm
 * install, …) — NOT file edits or content/heredocs that merely name infra
 * tools, and NOT a tool word + verb word that co-occur across lines.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENF = join(
  __dirname,
  '../.policy-tools/47a7a4c5-8651-40b3-a77a-b3a08355aee2_iac_parity.py'
);

function allowed(op: string, args: Record<string, unknown>): boolean {
  const r = spawnSync(
    'python3',
    [ENF, '--operation', op, '--args', JSON.stringify(args)],
    { encoding: 'utf-8' }
  );
  return JSON.parse(r.stdout || '{}').allowed === true;
}

describe('iac-parity enforcer: over-matching fix', () => {
  it('does NOT gate file edits (Write/Edit) even when content names infra tools', () => {
    // The whole reason for the fix: a Write whose body contains "helm" + a verb
    // like "install"/"create"/"set" used to be blocked.
    expect(
      allowed('Write', {
        file_path: 'x.py',
        content: 'WRAPPED = ("helm", "kubectl"); subs = ["install", "create", "set"]',
      })
    ).toBe(true);
  });

  it('does NOT match a tool word and verb word on different lines (heredoc)', () => {
    expect(
      allowed('Bash', { command: 'cat <<EOF\nhelm chart values\nplease install it\nEOF' })
    ).toBe(true);
  });

  it('does NOT match across a shell separator', () => {
    expect(allowed('Bash', { command: 'echo helm && echo install' })).toBe(true);
  });

  it('allows non-mutating IaC reads', () => {
    expect(allowed('Bash', { command: 'kubectl get pods' })).toBe(true);
    expect(allowed('Bash', { command: 'helm list' })).toBe(true);
  });

  it('still BLOCKS a real mutating command with no IaC diff', () => {
    // Relies on the worktree having no infra/ changes staged (true in CI).
    expect(allowed('Bash', { command: 'kubectl apply -f deploy.yaml' })).toBe(false);
    expect(allowed('Bash', { command: 'helm upgrade web ./chart' })).toBe(false);
  });
});
