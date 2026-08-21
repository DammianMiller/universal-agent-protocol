/**
 * Trivial-mission guard: under the escalate posture deliver refuses to be the
 * path for a one-line edit and tells the agent to make it directly.
 *
 * Motivating run (cognition-engine 2026-08-21): "fix: remove duplicate mod
 * build_serialized_batch_tests block at line 640 in src/rust-pg-ext/src/pgwire/
 * mod.rs that breaks compilation" — two deliver runs, 50 minutes, not landed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classifyTrivialMission, shouldRefuseTrivialMission } from '../../src/delivery/trivial-mission.js';
import { buildDeliverCliArgs } from '../../src/mcp-router/tools/deliver.js';

const INCIDENT =
  'fix: remove duplicate mod build_serialized_batch_tests block at line 640 in src/rust-pg-ext/src/pgwire/mod.rs that breaks compilation';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uap-trivial-'));
  delete process.env.UAP_DELIVER_TRIVIAL_GUARD;
  delete process.env.UAP_ENFORCE_DELIVERY;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const escalate = () => writeFileSync(join(root, '.uap.json'), JSON.stringify({ delivery: { enforcement: 'escalate' } }));

describe('classifyTrivialMission', () => {
  it('recognises the incident mission as a small single-file edit', () => {
    const v = classifyTrivialMission(INCIDENT);
    expect(v.trivial).toBe(true);
    expect(v.files).toEqual(['src/rust-pg-ext/src/pgwire/mod.rs']);
  });
  it('does not flag real work', () => {
    expect(classifyTrivialMission('implement a token-bucket rate limiter and wire it into the auth middleware with tests').trivial).toBe(false);
    expect(classifyTrivialMission('remove the legacy parser module and migrate callers in src/a.ts and src/b.ts').trivial).toBe(false);
    expect(classifyTrivialMission('delete the unused import in src/x.ts ' + 'and then '.repeat(60)).trivial).toBe(false);
    expect(classifyTrivialMission('build the signal processing engine').trivial).toBe(false);
    // breadth signals: not one-liners even when they start with a trivial verb
    for (const m of [
      'rename the User struct to Account and update every call site in the crate',
      'delete the deprecated v1 handlers and their tests, then fix the compile errors',
      'remove all usages of lodash from the codebase',
      'remove the unused import everywhere it appears',
      'drop support for Node 16: update CI, package.json engines, and the README',
      'fix the typo in the error message and add a regression test',
    ]) expect(classifyTrivialMission(m).trivial, m).toBe(false);
    expect(classifyTrivialMission('').trivial).toBe(false);
  });
});

describe('shouldRefuseTrivialMission', () => {
  it('refuses only under the escalate posture', () => {
    expect(shouldRefuseTrivialMission(root, INCIDENT).refuse).toBe(false); // gated default: deliver is the sanctioned route
    escalate();
    const d = shouldRefuseTrivialMission(root, INCIDENT);
    expect(d.refuse).toBe(true);
    expect(d.message).toMatch(/NOT RUN/);
    expect(d.message).toMatch(/pgwire\/mod\.rs/);
    expect(d.message).toMatch(/force/);
  });
  it('never refuses with --force, with red-gate evidence, or when switched off', () => {
    escalate();
    expect(shouldRefuseTrivialMission(root, INCIDENT, { force: true }).refuse).toBe(false);
    mkdirSync(join(root, '.uap'));
    writeFileSync(join(root, '.uap', 'escalation-state.json'), JSON.stringify({ failures: 2, last_failure: { ts: Math.floor(Date.now() / 1000), detail: 'x' } }));
    expect(shouldRefuseTrivialMission(root, INCIDENT).refuse).toBe(false);
    writeFileSync(join(root, '.uap', 'escalation-state.json'), JSON.stringify({ failures: 2, last_failure: { ts: Math.floor(Date.now() / 1000) - 8 * 3600, detail: 'old' } }));
    expect(shouldRefuseTrivialMission(root, INCIDENT).refuse).toBe(true); // stale evidence does not count
    process.env.UAP_DELIVER_TRIVIAL_GUARD = 'off';
    expect(shouldRefuseTrivialMission(root, INCIDENT).refuse).toBe(false);
  });
  it('reads posture and evidence from the MAIN checkout when invoked from a worktree', () => {
    escalate();
    const wt = join(root, '.worktrees', '007-x');
    mkdirSync(wt, { recursive: true });
    expect(shouldRefuseTrivialMission(wt, INCIDENT).refuse).toBe(true); // posture found at main
    mkdirSync(join(root, '.uap'));
    writeFileSync(join(root, '.uap', 'escalation-state.json'), JSON.stringify({ failures: 2, last_failure: { ts: Math.floor(Date.now() / 1000), detail: 'x' } }));
    expect(shouldRefuseTrivialMission(wt, INCIDENT).refuse).toBe(false); // evidence found at main
  });

  it('lets a genuinely large mission through under escalate', () => {
    escalate();
    expect(shouldRefuseTrivialMission(root, 'implement the pgwire binary protocol serializer with Arrow columns and tests').refuse).toBe(false);
  });
});

describe('MCP deliver tool plumbing', () => {
  it('forwards force:true as --force', () => {
    const args = buildDeliverCliArgs('uap', '/p', { instruction: 'x', force: true } as never);
    expect(args).toContain('--force');
    expect(buildDeliverCliArgs('uap', '/p', { instruction: 'x' } as never)).not.toContain('--force');
  });
});
