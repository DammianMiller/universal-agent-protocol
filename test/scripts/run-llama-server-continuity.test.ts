import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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

  // Without --alias, llama-server advertises the GGUF PATH as its only model
  // id. Every client config names the model in a human way, so every request
  // missed and the proxy rewrote the model on each one (MODEL REWRITE, 6 in a
  // 3h window on 2026-08-25) while /v1/models returned a path no config would
  // ever contain.
  // The script validates that LLAMA_MODEL exists, so alias-derivation cases
  // need a real file whose NAME carries the shape under test.
  // /tmp is RAM-backed on this host, so these get cleaned up rather than left.
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function modelNamed(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'llama-alias-'));
    tempDirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, '');
    return path;
  }

  it('advertises a model alias, defaulting to the GGUF basename', () => {
    const out = runScript({ LLAMA_MODEL: modelNamed('Qwen3.8-27B-UD-IQ4_XS.gguf') });
    expect(out).toContain('--alias Qwen3.8-27B-UD-IQ4_XS');
    // a name, not a path — the whole point
    expect(out).not.toMatch(/--alias \//);
  });

  it('honours an explicit LLAMA_ALIAS over the derived default', () => {
    const out = runScript({
      LLAMA_MODEL: modelNamed('Qwen3.8-27B-UD-IQ4_XS.gguf'),
      LLAMA_ALIAS: 'Qwen3.8-27B',
    });
    // Assert on the alias FLAG, not on the whole argv: IQ4_XS legitimately
    // appears in --model, so a bare not-toContain would fail on the filename.
    expect(out).toMatch(/--alias Qwen3\.8-27B\s/);
    expect(out).not.toMatch(/--alias \S*IQ4_XS/);
  });

  it('passes a comma-separated alias list through intact', () => {
    // Aliases are how a client config survives a model swap: list the old id
    // alongside the new one and both keep resolving.
    const out = runScript({ LLAMA_ALIAS: 'Qwen3.8-27B,qwen36-35b-a3b-iq4xs' });
    expect(out).toContain('--alias Qwen3.8-27B,qwen36-35b-a3b-iq4xs');
  });

  it('omits the flag entirely when LLAMA_ALIAS is set but empty', () => {
    // Single-dash expansion, matching LLAMA_SLOT_SAVE_PATH. The opt-out matters
    // because a second --alias does not override the first — llama.cpp unions
    // them — so LLAMA_EXTRA_ARGS is not an escape hatch for this flag.
    const out = runScript({ LLAMA_ALIAS: '' });
    expect(out).not.toContain('--alias');
  });

  it('strips only a .gguf suffix when deriving the default', () => {
    const out = runScript({ LLAMA_MODEL: modelNamed('plain-name') });
    expect(out).toContain('--alias plain-name');
  });
});
