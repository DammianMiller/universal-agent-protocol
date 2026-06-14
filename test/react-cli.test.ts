/**
 * Contract tests for the `uap react` CLI core (runReact): JSON in -> JSON out.
 * The harness adapters pipe a payload to `uap react` and consume this result.
 */
import { describe, it, expect } from 'vitest';
import { runReact } from '../src/cli/react';

describe('uap react CLI core (runReact)', () => {
  it('parses a JSON payload and returns a JSON ReactorResult', () => {
    const out = runReact(
      JSON.stringify({
        event: 'user-prompt',
        promptText: 'add JWT auth and fix the security vulnerability in login',
        changedFiles: ['src/auth/login.ts'],
      })
    );
    const parsed = JSON.parse(out);
    expect(typeof parsed.inject).toBe('string');
    expect(typeof parsed.block).toBe('boolean');
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(Array.isArray(parsed.surfacedKeys)).toBe(true);
    expect(typeof parsed.confidence).toBe('number');
  });

  it('stays silent (empty inject) for an empty prompt', () => {
    const parsed = JSON.parse(runReact(JSON.stringify({ event: 'user-prompt', promptText: '' })));
    expect(parsed.inject).toBe('');
    expect(parsed.actions).toHaveLength(0);
  });

  it('forwards ReactorOptions (auto-spawn config) through to the resolver', () => {
    const parsed = JSON.parse(
      runReact(JSON.stringify({ event: 'user-prompt', promptText: 'security audit' }), {
        autoSpawnThreshold: 0,
        autoSpawnTaskTypes: ['security'],
      })
    );
    expect(parsed).toHaveProperty('actions');
    expect(Array.isArray(parsed.actions)).toBe(true);
  });

  it('throws on a malformed JSON payload', () => {
    expect(() => runReact('not-json')).toThrow();
  });
});
