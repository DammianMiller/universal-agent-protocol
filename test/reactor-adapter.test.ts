/**
 * Integration test for the UserPromptSubmit reactor adapter
 * (templates/hooks/uap-reactor-prompt.sh). Runs the shell adapter with a mock
 * harness payload, using a from-source `uap` (tsx) so it is build-independent.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

const ROOT = join(__dirname, '..');
const ADAPTER = join(ROOT, 'templates/hooks/uap-reactor-prompt.sh');

/**
 * Absolute path to the `tsx` binary, found the way node resolves modules.
 *
 * This must not be a literal `join(ROOT, 'node_modules/.bin/tsx')`. A git
 * worktree under `.worktrees/` has no `node_modules` of its own — imports
 * resolve by walking up to the main checkout — so that literal path does not
 * exist there. The adapter is built to fail safe (exit 0, emit nothing) when it
 * cannot run the binary, so the failure surfaced as `JSON.parse('')` throwing
 * "Unexpected end of JSON input", which reads like a reactor bug rather than a
 * missing toolchain. That blocked `scripts/version-bump.sh` — which runs the
 * full suite — from ever succeeding inside a worktree.
 */
function resolveBin(name: string, from: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const TSX = resolveBin('tsx', ROOT);
const UAP_BIN = `${TSX} ${join(ROOT, 'src/bin/cli.ts')}`;

function runAdapter(payload: string): string {
  return execFileSync('bash', [ADAPTER], {
    input: payload,
    env: { ...process.env, UAP_BIN },
    encoding: 'utf-8',
    timeout: 60000,
  }).trim();
}

describe('uap-reactor-prompt adapter (UserPromptSubmit)', () => {
  // Guard, not decoration. The adapter answers "cannot run" and "nothing to
  // say" identically — both are silence — so without this the trivial-prompt
  // case below would PASS on a broken toolchain, for entirely the wrong reason.
  it('resolves tsx (including from a worktree, whose deps live in the main checkout)', () => {
    expect(
      TSX,
      `tsx not found in any node_modules/.bin above ${ROOT} — run npm install`
    ).toBeDefined();
    expect(existsSync(TSX as string)).toBe(true);
  });

  it('emits additionalContext with recommendations for a substantive prompt', () => {
    const out = runAdapter(
      JSON.stringify({ prompt: 'add JWT auth and fix the security vulnerability in the login endpoint' })
    );
    const d = JSON.parse(out);
    expect(d.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(typeof d.hookSpecificOutput.additionalContext).toBe('string');
    expect(d.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  });

  it('stays silent (no output) for a trivial prompt', () => {
    expect(runAdapter(JSON.stringify({ prompt: 'hi' }))).toBe('');
  });
});
