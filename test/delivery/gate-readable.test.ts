/**
 * The agent must be able to READ the gate it is judged against — and never rewrite it.
 *
 * `.uap-deliver/verify.sh` is the self-authored acceptance script: it IS the
 * specification. Blanket-blocking all of `.uap-deliver/` as "internal state" meant
 * the agent could not see the criteria it had to satisfy, and it looped trying —
 * 6 refused reads in one live mission with ERROR-LOOP firing 5 times, while the
 * spec it needed sat one refusal away.
 *
 * Reading it is the point. WRITING it is the agent rigging its own gate, and must
 * stay blocked: rewriting the gate is not passing it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool } from '../../src/delivery/agentic-executor.js';

const EMPTY = new Set<string>();
const call = (dir: string, name: string, args: Record<string, unknown>): string =>
  runTool(dir, name, args, 5_000, EMPTY, true, false, EMPTY);

describe('the acceptance gate is readable, never writable', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-gate-'));
    mkdirSync(join(dir, '.uap-deliver'), { recursive: true });
    writeFileSync(join(dir, '.uap-deliver', 'verify.sh'), '#!/bin/sh\ntest -f app.js\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('READS the gate — the agent can finally see what it must satisfy', () => {
    const out = call(dir, 'read_file', { path: '.uap-deliver/verify.sh' });
    expect(out).toContain('test -f app.js');
    expect(out).not.toMatch(/^ERROR/);
  });

  it('REFUSES to rewrite the gate — rigging it is not passing it', () => {
    const out = call(dir, 'write_file', { path: '.uap-deliver/verify.sh', content: 'exit 0' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/never modify it|Rewriting the gate/);
    // ...and the gate on disk is untouched.
    expect(readFileSync(join(dir, '.uap-deliver', 'verify.sh'), 'utf-8')).toContain('test -f app.js');
  });

  it('still blocks every OTHER internal path (the distraction guard stands)', () => {
    mkdirSync(join(dir, '.uap', 'deliver-runs'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'state.json'), '{}');
    expect(call(dir, 'read_file', { path: '.uap/state.json' })).toMatch(/internal state/);
    expect(call(dir, 'list_dir', { path: '.uap' })).toMatch(/internal state/);
    writeFileSync(join(dir, '.uap-deliver', 'other.txt'), 'x');
    expect(call(dir, 'read_file', { path: '.uap-deliver/other.txt' })).toMatch(/internal state/);
  });

  it('project source files are unaffected', () => {
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    expect(call(dir, 'read_file', { path: 'app.js' })).toContain('console.log(1)');
    expect(call(dir, 'write_file', { path: 'app.js', content: 'x' })).toMatch(/^OK/);
  });
});

/**
 * Same bug, second file: the user-validation gate's own failure text says
 * "the manifest is .uap/user-paths.json" and the guard then refused to let the
 * agent read it — so it could not know WHICH selectors the journeys assert.
 * Live cost (octopus_invaders_v3, 2026-07-22): a deliver churned 2h44m flat at
 * 50% of gates, rewriting one file repeatedly while guessing the contract.
 */
describe('the user-path manifest is readable, never writable', () => {
  let dir: string;
  const MANIFEST = JSON.stringify({
    version: 1,
    paths: [{ id: 'start', steps: [{ expect_visible: '#hud' }] }],
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-paths-'));
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'user-paths.json'), MANIFEST);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('READS the manifest — the agent can see which selectors the journeys assert', () => {
    const out = call(dir, 'read_file', { path: '.uap/user-paths.json' });
    expect(out).toContain('#hud');
    expect(out).not.toMatch(/^ERROR/);
  });

  it('REFUSES to rewrite the manifest — editing the contract is not satisfying it', () => {
    const out = call(dir, 'write_file', { path: '.uap/user-paths.json', content: '{"paths":[]}' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/never modify it|Rewriting the gate/);
    expect(readFileSync(join(dir, '.uap', 'user-paths.json'), 'utf-8')).toContain('#hud');
  });

  it('still blocks the REST of .uap/ — only the contract is carved out', () => {
    writeFileSync(join(dir, '.uap', 'deliver.lock'), '123|x');
    const out = call(dir, 'read_file', { path: '.uap/deliver.lock' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/internal state/);
  });
});
