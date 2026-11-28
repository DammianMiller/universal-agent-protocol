import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHomePath, fileState } from '../../src/inference/model-files.js';

/**
 * `~`-relative registry paths: a model-registry (or capacity pin, or llama
 * profile) committed to a shared repo must not ship a machine's username.
 * The loader keeps the literal string; every fs touch expands it against
 * the operator's own home — identical behavior on the machine that wrote
 * the registry, portable everywhere else.
 */

describe('expandHomePath', () => {
  it('maps `~` and `~/…` onto the operator home', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/models/x.gguf')).toBe(join(homedir(), 'models/x.gguf'));
  });

  it('passes everything else through untouched', () => {
    // Absolute paths (the pre-`~` registry form and CLI args) and bare
    // relative paths must behave exactly as before.
    expect(expandHomePath('/opt/x.gguf')).toBe('/opt/x.gguf');
    expect(expandHomePath('logs/x.jsonl')).toBe('logs/x.jsonl');
    // Only a LEADING ~ expands — a ~ buried in the middle is data, not home.
    expect(expandHomePath('/var/data/~snapshot')).toBe('/var/data/~snapshot');
  });
});

describe('fileState with a `~`-relative manifest path', () => {
  it('checks the file under $HOME but reports the literal registry path', async () => {
    const dir = mkdtempSync(join(homedir(), '.uap-expand-home-test-'));
    try {
      const tildeDir = `~${dir.slice(homedir().length)}`;
      writeFileSync(join(dir, 'present.gguf'), 'abc');
      const manifest = { path: `${tildeDir}/present.gguf`, bytes: 3 };
      const state = await fileState(manifest, {});
      expect(state).toEqual({ status: 'ok', path: `${tildeDir}/present.gguf`, bytes: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing `~`-relative file without rewriting the literal path', async () => {
    const state = await fileState({ path: '~/definitely-not-here-uap-test.gguf' }, {});
    expect(state).toEqual({ status: 'missing', path: '~/definitely-not-here-uap-test.gguf' });
  });
});
