/**
 * The deliver-routing ADVICE and the delivery-enforcement GATE must agree.
 *
 * These are two independent surfaces — prose in reactor.ts, policy in
 * delivery_enforcement.py — and nothing tied them together. They drifted: the
 * advice told every agent that "direct Edit/Write on source files is gated and
 * will be blocked" while the gate was quietly allowing trivial edits,
 * deletions, renames, and docs/tests/scripts.
 *
 * That drift is not cosmetic. Read as "deliver is the only way to touch code",
 * it pushes ungated work through a convergence loop — and on 2026-08-09 a
 * three-file DELETION routed that way ended with the loop inventing an
 * unrequested dependency that broke the build.
 *
 * So assert the claims against the real enforcer rather than against a copy of
 * its rules. If someone retunes the threshold or widens the gate, this fails.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const SOURCE_FILE = 'src/cli/deliver.ts';

function verdict(op: string, args: Record<string, unknown>): boolean | null {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify(args)], {
    encoding: 'utf8',
    env: { ...process.env, UAP_REPO_ROOT: process.cwd(), UAP_DELIVER_ACTIVE: '', UAP_DELIVER_BYPASS: '' },
  });
  try {
    return (JSON.parse(r.stdout || '{}') as { allowed?: boolean }).allowed ?? null;
  } catch {
    return null;
  }
}

describe.skipIf(!existsSync(ENFORCER))('advice ↔ gate agreement', () => {
  it('a SMALL surgical edit really is allowed, as the advice says', () => {
    const small = 'x'.repeat(50);
    expect(verdict('Edit', { file_path: SOURCE_FILE, old_string: small, new_string: small })).toBe(true);
  });

  it('a SUBSTANTIVE edit really is gated, as the advice says', () => {
    const big = 'y'.repeat(400);
    expect(verdict('Edit', { file_path: SOURCE_FILE, old_string: big, new_string: big })).toBe(false);
  });

  it('a whole-file write really is gated', () => {
    expect(verdict('Write', { file_path: SOURCE_FILE, content: 'x' })).toBe(false);
  });

  it('DELETING a source file really is not gated — the live incident', () => {
    // Routing this through deliver is what produced the broken Cargo.toml.
    expect(verdict('Bash', { command: 'rm src/dead_module.rs' })).toBe(true);
  });

  it('renaming a source file really is not gated', () => {
    expect(verdict('Bash', { command: 'git mv src/a.rs src/b.rs' })).toBe(true);
  });

  it('docs and tests really are not gated', () => {
    expect(verdict('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })).toBe(true);
    expect(verdict('Edit', { file_path: 'test/foo.test.ts', old_string: 'a', new_string: 'b' })).toBe(true);
  });

  it('the threshold the advice quotes is the one the gate uses', () => {
    // The advice says "roughly under 240 changed characters". Bracket it: a
    // change comfortably under passes, one comfortably over does not.
    const under = 'a'.repeat(100); // 200 chars changed
    const over = 'b'.repeat(200); // 400 chars changed
    expect(verdict('Edit', { file_path: SOURCE_FILE, old_string: under, new_string: under })).toBe(true);
    expect(verdict('Edit', { file_path: SOURCE_FILE, old_string: over, new_string: over })).toBe(false);
  });
});
