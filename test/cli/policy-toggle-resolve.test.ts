/**
 * `uap policy disable <name>` must actually disable the policy.
 *
 * It did not. The commands are documented as taking `<id>`, and were written as
 * if that were the only possibility: `togglePolicy` filters on `{ id }`, so a
 * NAME matched zero rows — and enable/disable printed success regardless,
 * because nothing checked. A policy anyone believed they had turned off stayed
 * on, silently, indefinitely.
 *
 * Found live: the `validate-plan-before-build` zombie, deleted from source on
 * 2026-07-14 and still enforcing seventeen days later, shrugged off
 *
 *     $ uap policy disable validate-plan-before-build
 *     ⚠️  Policy 'validate-plan-before-build' disabled. It will no longer be enforced.
 *
 * with isActive still 1.
 *
 * These tests drive a REAL policy store on a throwaway DB, not a mock. A mock
 * would not have caught this: the fiction was in the reporting, not the write.
 * (process.chdir() is unavailable in vitest workers and the singleton resolves
 * its path from cwd, so the PolicyMemoryManager constructor seam is used.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PolicyMemoryManager } from '../../src/policies/policy-memory.js';
import { resolvePolicyRef, setPolicyActive } from '../../src/cli/policy.js';

let dir: string;
let store: PolicyMemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-polres-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  store = new PolicyMemoryManager(join(dir, 'db', 'policies.db'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A policy in the real store, with a human name that is not its id. */
async function seed(name: string): Promise<{ id: string }> {
  await store.storeRawPolicy(
    `# ${name}\n\n**Category**: workflow\n**Level**: OPTIONAL\n\n## Rule\n\nx\n`
  );
  const all = await store.getAllPoliciesUnfiltered();
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error(`seed failed for ${name}`);
  return { id: p.id };
}

async function activeState(name: string): Promise<boolean | undefined> {
  const all = await store.getAllPoliciesUnfiltered();
  return all.find((p) => p.name === name)?.isActive;
}

/** Capture console output around an action, and restore process.exitCode. */
async function capture(fn: () => Promise<void>): Promise<{ logs: string; errs: string; exit: number | undefined }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (s?: unknown) => { logs.push(String(s)); };
  console.error = (s?: unknown) => { errs.push(String(s)); };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exit = process.exitCode;
  process.exitCode = prevExit;
  return { logs: logs.join('\n'), errs: errs.join('\n'), exit };
}

describe('resolvePolicyRef', () => {
  it('resolves by id, by exact name, and by slug', async () => {
    const { id } = await seed('Validate Plan Before Build');
    expect((await resolvePolicyRef(id, store)).map((p) => p.id)).toEqual([id]);
    expect((await resolvePolicyRef('Validate Plan Before Build', store)).map((p) => p.id)).toEqual([id]);
    // The case that broke the installer too: stored H1 vs the slug people type.
    expect((await resolvePolicyRef('validate-plan-before-build', store)).map((p) => p.id)).toEqual([id]);
  });

  it('returns nothing for an unknown reference', async () => {
    await seed('Some Policy');
    expect(await resolvePolicyRef('no-such-policy', store)).toEqual([]);
  });

  it('finds INACTIVE policies too', async () => {
    // getAllPolicies() returns only active rows; resolving through it would
    // make `enable` unable to find the very policies it exists to switch on.
    const { id } = await seed('Sleeping Policy');
    await store.togglePolicy(id, false);
    expect((await resolvePolicyRef('sleeping-policy', store)).map((p) => p.id)).toEqual([id]);
  });
});

describe('uap policy disable/enable', () => {
  it('DISABLES a policy addressed by name', async () => {
    await seed('Validate Plan Before Build');
    expect(await activeState('Validate Plan Before Build')).toBe(true);

    const { logs, exit } = await capture(() =>
      setPolicyActive('validate-plan-before-build', false, store)
    );

    expect(await activeState('Validate Plan Before Build')).toBe(false);
    expect(exit ?? 0).toBe(0);
    expect(logs).toMatch(/Disabled:/);
  });

  it('ENABLES a policy addressed by name', async () => {
    const { id } = await seed('Sleeping Policy');
    await store.togglePolicy(id, false);

    await capture(() => setPolicyActive('sleeping-policy', true, store));

    expect(await activeState('Sleeping Policy')).toBe(true);
  });

  it('FAILS LOUDLY on an unknown policy instead of reporting success', async () => {
    // The heart of it: the old command printed "disabled. It will no longer be
    // enforced." for a name that matched nothing at all.
    await seed('Some Policy');
    const { logs, errs, exit } = await capture(() =>
      setPolicyActive('no-such-policy', false, store)
    );
    expect(exit).toBe(1);
    expect(errs).toMatch(/No policy matches/i);
    expect(logs).not.toMatch(/no longer be enforced|Disabled:/i);
  });

  it('reports failure if the write silently does not take effect', async () => {
    // The read-back is the point. A store whose toggle does nothing must not be
    // reported as a success — that is precisely the bug being fixed.
    await seed('Stubborn Policy');
    const inert: typeof store = Object.create(store);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    (inert as unknown as { togglePolicy: () => Promise<void> }).togglePolicy = async () => {};
    const { logs, errs, exit } = await capture(() =>
      setPolicyActive('stubborn-policy', false, inert)
    );
    expect(exit).toBe(1);
    expect(errs).toMatch(/did not take effect/i);
    expect(logs).not.toMatch(/Disabled:/);
  });
});
