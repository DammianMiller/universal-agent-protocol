/**
 * The deliver agent must not be able to read, list, or write its OWN machinery.
 *
 * Observed live (run-20260713T130902-c4669e): a routed deliver spent 5 of its 10
 * tool calls recursing into `.uap/deliver-runs/<its own run>/state.json`,
 * `.uap/autoroute.log` and the lock files — half of a tight budget
 * (`--max-turns 5 --ceiling 10`) gone, so it could never converge on the actual
 * deliverable. One call even errored (`read_file .uap/deliver-runs` → EISDIR),
 * burning another turn.
 *
 * agentic-executor's scope note asked for exactly this guard: "not for production
 * without re-adding a protected-path guard".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool } from '../../src/delivery/agentic-executor.js';

const EMPTY = new Set<string>();
const call = (root: string, name: string, args: Record<string, unknown>): string =>
  runTool(root, name, args, 5000, EMPTY, true, false, EMPTY);

describe('agentic executor: UAP/agent-internal paths are off-limits', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-guard-'));
    // The agent's own machinery — exactly what the live run went spelunking in.
    mkdirSync(join(root, '.uap', 'deliver-runs', 'run-abc'), { recursive: true });
    writeFileSync(join(root, '.uap', 'deliver-runs', 'run-abc', 'state.json'), '{"status":"running"}');
    writeFileSync(join(root, '.uap', 'autoroute.log'), 'spawned deliver');
    writeFileSync(join(root, '.uap', 'user-paths.json'), '{"version":1,"paths":[]}');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    // The actual deliverable.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('read_file refuses the run state the agent was recursing into', () => {
    const out = call(root, 'read_file', { path: '.uap/deliver-runs/run-abc/state.json' });
    expect(out).toMatch(/internal state/i);
    expect(out).not.toContain('running'); // the content never reaches the model
  });

  it('read_file refuses .uap logs and run state', () => {
    expect(call(root, 'read_file', { path: '.uap/autoroute.log' })).toMatch(/internal state/i);
    expect(call(root, 'read_file', { path: '.uap/deliver.lock' })).toMatch(/internal state/i);
  });

  it('but ALLOWS .uap/user-paths.json — it is the CONTRACT, not internal state', () => {
    // The user-validation gate's failure text points the agent at this file
    // ("the manifest is .uap/user-paths.json"). Refusing the read left it
    // guessing which selectors the journeys assert — a deliver churned 2h44m
    // flat at 50% of gates because of exactly this. See gate-readable.test.ts.
    const out = call(root, 'read_file', { path: '.uap/user-paths.json' });
    expect(out).not.toMatch(/internal state/i);
    expect(out).toContain('paths');
  });

  it('list_dir refuses .uap/ (the EISDIR turn-waster)', () => {
    expect(call(root, 'list_dir', { path: '.uap/deliver-runs' })).toMatch(/internal state/i);
  });

  it('write_file refuses .uap/ (the agent cannot rewrite its own state)', () => {
    const out = call(root, 'write_file', { path: '.uap/deliver-runs/run-abc/state.json', content: '{"status":"delivered"}' });
    expect(out).toMatch(/internal state/i);
    // and it really did not write
    expect(existsSync(join(root, '.uap', 'deliver-runs', 'run-abc', 'state.json'))).toBe(true);
  });

  it('.git and node_modules are off-limits too', () => {
    expect(call(root, 'list_dir', { path: '.git' })).toMatch(/internal state/i);
    expect(call(root, 'list_dir', { path: 'node_modules' })).toMatch(/internal state/i);
  });

  it('a root listing HIDES the internal dirs entirely (no temptation)', () => {
    const out = call(root, 'list_dir', { path: '.' });
    expect(out).toContain('src/');       // the deliverable is visible
    expect(out).not.toContain('.uap');   // its own machinery is not
    expect(out).not.toContain('.git');
    expect(out).not.toContain('node_modules');
  });

  it('the actual deliverable is still fully readable/writable', () => {
    expect(call(root, 'read_file', { path: 'src/app.ts' })).toContain('export const x');
    expect(call(root, 'list_dir', { path: 'src' })).toContain('app.ts');
    expect(call(root, 'write_file', { path: 'src/new.ts', content: 'export const y = 2;' })).not.toMatch(/internal state/i);
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(true);
  });

  it('a file merely NAMED like an internal dir is not blocked (prefix, not substring)', () => {
    writeFileSync(join(root, 'src', 'uap-notes.md'), 'hi');
    expect(call(root, 'read_file', { path: 'src/uap-notes.md' })).toContain('hi');
  });
});
