import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = join(dirname(__filename), '..', '..');
const script = join(rootDir, 'scripts', 'run-llama-server-continuity.sh');

function runScript(env: Record<string, string>): string {
  return execFileSync('bash', [script], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LLAMA_BIN: '/bin/echo',
      LLAMA_MODEL: '/etc/hostname',
      LLAMA_CHAT_TEMPLATE_FILE: 'embedded',
      LLAMA_ENABLE_SPEC_DECODING: 'false',
      ...env,
    },
    encoding: 'utf-8',
  });
}

describe('run-llama-server-continuity.sh env-driven flags', () => {
  it('uses LLAMA_REPEAT_PENALTY env var and defaults to 1.05 when unset', () => {
    const defaultOut = runScript({});
    expect(defaultOut).toContain('--repeat-penalty 1.05');

    const customOut = runScript({ LLAMA_REPEAT_PENALTY: '1.0' });
    expect(customOut).toContain('--repeat-penalty 1.0');
    expect(customOut).not.toContain('--repeat-penalty 1.05');
  });

  it('omits --cache-reuse when LLAMA_CACHE_REUSE is empty and emits it when set', () => {
    const noReuse = runScript({});
    expect(noReuse).not.toContain('--cache-reuse');

    const reuse = runScript({ LLAMA_CACHE_REUSE: '256' });
    expect(reuse).toContain('--cache-reuse 256');
  });
});
