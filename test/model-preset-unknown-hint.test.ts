/**
 * Unknown model preset UX: `uap deliver` and `uap verify` hard-reject a
 * non-preset id. The message must still list the available presets AND hint
 * at 'local-auto': operators routinely pass a backend/registry name here
 * (observed 2026-10-24: `--model qwen3.8-flash-next`, a local backend name,
 * not a preset id), and the bare "Available:" list gave them nothing local
 * to switch to. Exercised through the built CLI binary so the fail()/throw
 * paths and exit codes are covered end-to-end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ModelPresets } from '../src/models/types.js';

const CLI = join(__dirname, '..', 'dist', 'bin', 'cli.js');
// A real local backend name, NOT a preset id — the exact shape that reached
// the operator in the wild.
const BOGUS = 'qwen3.8-flash-next';

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uap-preset-'));
  const git = (...args: string[]) => spawnSync('git', [...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'scratch project\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline');
  return dir;
}

describe('unknown model preset UX', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deliver exits 2 and hints at 'local-auto'", () => {
    dir = scratchRepo();
    const r = spawnSync('node', [CLI, 'deliver', '--model', BOGUS, '--max-turns', '1', 'noop'], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(2);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined).toContain(`Unknown model preset '${BOGUS}'`);
    expect(combined).toContain("'local-auto'");
    expect(combined).toContain('--endpoint <url>');
  });

  it("verify --acceptance fails and hints at 'local-auto'", () => {
    dir = scratchRepo();
    mkdirSync(join(dir, '.uap'));
    writeFileSync(join(dir, '.uap', 'acceptance.md'), 'Requirements:\n- does nothing\n');
    const r = spawnSync('node', [CLI, 'verify', '--acceptance', '.uap/acceptance.md', '--model', BOGUS], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(1);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined).toContain(`Unknown model preset '${BOGUS}'`);
    expect(combined).toContain("'local-auto'");
  });

  it('legacy local presets advertise their proxy-routed status', () => {
    for (const id of ['qwen35-a3b', 'qwen36-a3b'] as const) {
      const preset = ModelPresets[id];
      expect(preset.name).toContain('legacy label');
      expect(preset.endpoint).toBe('http://127.0.0.1:4000/v1');
      // The inert spellings, unchanged on purpose (see the SUPERSEDED notes).
      expect(preset.apiModel).toBe(id === 'qwen35-a3b' ? 'qwen35-a3b-iq4xs' : 'qwen36-35b-a3b-iq4xs');
    }
  });
});
