/**
 * Tests for the operator toggle commands:
 *   uap orchestrator on|off|auto|status  (deliver.orchestrate)
 *   uap model routing on|off|status       (multiModel.enabled)
 * Both persist to .uap.json; exercised through the built CLI binary so the
 * command wiring (flags, subcommands, config writes) is covered end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CLI = join(__dirname, '..', 'dist', 'bin', 'cli.js');

function run(dir: string, ...args: string[]): void {
  execFileSync('node', [CLI, ...args], { cwd: dir });
}

describe('uap orchestrator toggle', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-toggle-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ multiModel: { enabled: true } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const readCfg = () => JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf8'));

  it('off persists deliver.orchestrate = "off"', () => {
    run(dir, 'orchestrator', 'off');
    expect(readCfg().deliver.orchestrate).toBe('off');
  });

  it('on persists deliver.orchestrate = "on"', () => {
    run(dir, 'orchestrator', 'on');
    expect(readCfg().deliver.orchestrate).toBe('on');
  });

  it('auto clears the explicit key (falls back to auto-on default)', () => {
    run(dir, 'orchestrator', 'off');
    run(dir, 'orchestrator', 'auto');
    expect(readCfg().deliver?.orchestrate).toBeUndefined();
  });
});

describe('uap model routing toggle', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-rtoggle-'));
    writeFileSync(
      join(dir, '.uap.json'),
      JSON.stringify({ multiModel: { enabled: true, roles: { planner: 'opus-4.8' } } })
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const readCfg = () => JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf8'));

  it('off sets multiModel.enabled = false', () => {
    run(dir, 'model', 'routing', 'off');
    expect(readCfg().multiModel.enabled).toBe(false);
  });

  it('on sets multiModel.enabled = true', () => {
    run(dir, 'model', 'routing', 'off');
    run(dir, 'model', 'routing', 'on');
    expect(readCfg().multiModel.enabled).toBe(true);
  });
});
