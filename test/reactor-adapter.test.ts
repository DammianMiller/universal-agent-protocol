/**
 * Integration test for the UserPromptSubmit reactor adapter
 * (templates/hooks/uap-reactor-prompt.sh). Runs the shell adapter with a mock
 * harness payload, using a from-source `uap` (tsx) so it is build-independent.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ADAPTER = join(ROOT, 'templates/hooks/uap-reactor-prompt.sh');
const UAP_BIN = `${join(ROOT, 'node_modules/.bin/tsx')} ${join(ROOT, 'src/bin/cli.ts')}`;

function runAdapter(payload: string): string {
  return execFileSync('bash', [ADAPTER], {
    input: payload,
    env: { ...process.env, UAP_BIN },
    encoding: 'utf-8',
    timeout: 60000,
  }).trim();
}

describe('uap-reactor-prompt adapter (UserPromptSubmit)', () => {
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
