/**
 * The guard reaching the actual write paths.
 *
 * Testing the helper alone is how a guard ships inert: five times this session
 * a mutant survived because the assertions never went through the call site.
 * These drive `runTool` — the real entry point every model write goes through
 * — and check the file ON DISK, so a guard that is never called cannot pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool } from '../../src/delivery/agentic-executor.js';

const EMPTY: ReadonlySet<string> = new Set();
const call = (root: string, name: string, args: Record<string, unknown>) =>
  runTool(root, name, args, 5000, EMPTY, true, false, EMPTY);

const MANIFEST = `[package]
name = "x"
version = "0.1.0"

[features]
default = ["pgrx"]
pgrx = ["dep:pgrx"]
`;

describe('a model cannot switch off its own compile gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-featguard-'));
    writeFileSync(join(dir, 'Cargo.toml'), MANIFEST);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const onDisk = () => readFileSync(join(dir, 'Cargo.toml'), 'utf8');

  it('write_file: refuses, and the manifest on disk is untouched', () => {
    const out = call(dir, 'write_file', {
      path: 'Cargo.toml',
      content: MANIFEST.replace('default = ["pgrx"]', 'default = []'),
    });
    expect(out).toMatch(/^ERROR:/);
    expect(out).toContain('pgrx');
    expect(onDisk(), 'a refused write must not land').toContain('default = ["pgrx"]');
  });

  it('edit_file: refuses the same downgrade through the edit path', () => {
    const out = call(dir, 'edit_file', {
      path: 'Cargo.toml',
      old_string: 'default = ["pgrx"]',
      new_string: 'default = []',
    });
    expect(out).toMatch(/^ERROR:/);
    expect(onDisk()).toContain('default = ["pgrx"]');
  });

  it('edit_range: refuses it through the line-anchored path too', () => {
    const lineNo = MANIFEST.split('\n').findIndex((l) => l.startsWith('default =')) + 1;
    const out = call(dir, 'edit_range', {
      path: 'Cargo.toml',
      start_line: lineNo,
      end_line: lineNo,
      replacement: 'default = []',
    });
    expect(out).toMatch(/^ERROR:/);
    expect(onDisk()).toContain('default = ["pgrx"]');
  });

  it('still lets a real fix through — adding a feature writes normally', () => {
    const out = call(dir, 'write_file', {
      path: 'Cargo.toml',
      content: MANIFEST.replace('default = ["pgrx"]', 'default = ["pgrx", "serde"]'),
    });
    expect(out).not.toMatch(/^ERROR:/);
    expect(onDisk()).toContain('"serde"');
  });

  it('still lets unrelated manifest edits through', () => {
    const out = call(dir, 'edit_file', {
      path: 'Cargo.toml',
      old_string: 'version = "0.1.0"',
      new_string: 'version = "0.2.0"',
    });
    expect(out).not.toMatch(/^ERROR:/);
    expect(onDisk()).toContain('0.2.0');
  });

  it('leaves a brand-new Cargo.toml alone — there is no prior list to shrink', () => {
    const out = call(dir, 'write_file', { path: 'sub/Cargo.toml', content: MANIFEST });
    expect(out).not.toMatch(/^ERROR:/);
  });
});
