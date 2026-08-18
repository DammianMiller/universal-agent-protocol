/**
 * A policy can ship installed but DISABLED.
 *
 * Every policy used to arrive active (`isActive: existing ? … : true`), so
 * offering one and imposing it were the same act. rtk-wrap forced the
 * distinction: rtk saves 60–90% of what command output costs in tokens, but
 * routing every git call through it means machine-readable output comes back
 * rewritten. Measured against real git in this repo — `worktree list
 * --porcelain` returns 46 entries directly and 0 through rtk, and an agent
 * parsing that concludes there are no worktrees. Worth having available; not
 * worth defaulting on.
 *
 * The second test is the one that matters most: declaring a policy opt-in is a
 * change to its DEFAULT, and a default must never reach back and undo a choice
 * someone made deliberately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PolicyMemoryManager } from '../src/policies/policy-memory.js';

const OPT_IN = `# test-opt-in-policy

**Category**: custom
**Level**: RECOMMENDED
**Default**: off
**Enforcement Stage**: pre-exec
**Tags**: test

## Rule

Does nothing.
`;

const ORDINARY = `# test-ordinary-policy

**Category**: custom
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: test

## Rule

Does nothing.
`;

const RTK_POLICY = join(
  __dirname,
  '..',
  'src',
  'policies',
  'schemas',
  'policies',
  'rtk-wrap.md'
);

let dir: string;
let db: string;
let mgr: PolicyMemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-policy-default-'));
  db = join(dir, 'policies.db');
  mgr = new PolicyMemoryManager(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function isActive(name: string): Promise<boolean | undefined> {
  const all = await mgr.getAllPoliciesUnfiltered();
  return all.find((p) => p.name === name)?.isActive;
}

describe('a policy declaring **Default**: off', () => {
  it('installs inactive', async () => {
    await mgr.storeRawPolicy(OPT_IN);
    expect(await isActive('test-opt-in-policy')).toBe(false);
  });

  it('does not switch off a policy the operator had enabled', async () => {
    const id = await mgr.storeRawPolicy(OPT_IN);
    await mgr.togglePolicy(id, true);
    expect(await isActive('test-opt-in-policy')).toBe(true);

    await mgr.storeRawPolicy(OPT_IN); // re-install, as `uap policy install` does
    expect(await isActive('test-opt-in-policy')).toBe(true);
  });

  it('accepts the "disabled" spelling', async () => {
    await mgr.storeRawPolicy(OPT_IN.replace('**Default**: off', '**Default**: disabled'));
    expect(await isActive('test-opt-in-policy')).toBe(false);
  });

  it('treats an explicit "on" as on', async () => {
    await mgr.storeRawPolicy(OPT_IN.replace('**Default**: off', '**Default**: on'));
    expect(await isActive('test-opt-in-policy')).toBe(true);
  });
});

describe('policies without the marker are unaffected', () => {
  it('still install active', async () => {
    await mgr.storeRawPolicy(ORDINARY);
    expect(await isActive('test-ordinary-policy')).toBe(true);
  });
});

describe('rtk-wrap ships opt-in', () => {
  it('declares Default: off and is no longer REQUIRED', () => {
    const md = readFileSync(RTK_POLICY, 'utf-8');
    expect(md).toMatch(/\*\*Default\*\*:\s*off/i);
    expect(md).not.toMatch(/\*\*Level\*\*:\s*REQUIRED/i);
  });

  it('installs inactive', async () => {
    await mgr.storeRawPolicy(readFileSync(RTK_POLICY, 'utf-8'));
    expect(await isActive('rtk-wrap')).toBe(false);
  });

  it('no longer states the wrapper is mandatory', () => {
    const rule = readFileSync(RTK_POLICY, 'utf-8').split('## Why')[0];
    expect(rule).not.toMatch(/\bMUST be invoked\b/);
  });
});
