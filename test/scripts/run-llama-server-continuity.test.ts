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
      // HOME is required: the script derives LLAMA_SLOT_SAVE_PATH's default
      // from ${HOME} and runs under `set -u`. A real systemd service always
      // has HOME; the test supplies a writable one for determinism.
      HOME: '/tmp',
      LLAMA_BIN: '/bin/echo',
      LLAMA_MODEL: '/etc/hostname',
      LLAMA_CHAT_TEMPLATE_FILE: 'embedded',
      LLAMA_ENABLE_SPEC_DECODING: 'false',
      ...env,
    },
    encoding: 'utf-8',
    // Discard stderr. LLAMA_MODEL is the dummy '/etc/hostname', which has no
    // companion projector, so the script correctly logs "vision: no mmproj
    // projector found for hostname — serving text-only" on every one of these
    // runs. Inheriting that printed seven alarming vision-is-broken lines into
    // the suite output and sent a reader hunting a production fault that does
    // not exist. These tests assert on stdout (the assembled argv) only.
    stdio: ['ignore', 'pipe', 'ignore'],
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

  // Slot save/restore default (UAP PR #179 + #180): the proxy's
  // cross-session slot save/restore needs the server launched with
  // --slot-save-path. This wrapper enables it by default.
  it('emits --slot-save-path at an explicit LLAMA_SLOT_SAVE_PATH', () => {
    const out = runScript({ LLAMA_SLOT_SAVE_PATH: '/tmp/uap-slot-test-explicit' });
    expect(out).toContain('--slot-save-path /tmp/uap-slot-test-explicit');
  });

  it('disables --slot-save-path when LLAMA_SLOT_SAVE_PATH is explicitly empty', () => {
    // Single-dash default expansion: set-but-empty stays empty (disabled).
    const out = runScript({ LLAMA_SLOT_SAVE_PATH: '' });
    expect(out).not.toContain('--slot-save-path');
  });

  it('defaults --slot-save-path under $HOME/.cache/uap when LLAMA_SLOT_SAVE_PATH is unset', () => {
    // runScript sets HOME=/tmp, so the unset default resolves there.
    const out = runScript({});
    expect(out).toContain('--slot-save-path /tmp/.cache/uap/llama-slots');
  });
});
