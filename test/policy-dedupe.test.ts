/**
 * Policy de-duplication: prevent (storeRawPolicy upserts by name) + clean up
 * (dedupePolicies collapses legacy same-name rows). planDedup is the pure core.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PolicyMemoryManager, planDedup } from '../src/policies/policy-memory.js';
import { DatabaseManager } from '../src/policies/database-manager.js';

const dirs: string[] = [];
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-pol-'));
  dirs.push(d);
  mkdirSync(join(d, 'agents', 'data', 'memory'), { recursive: true });
  return join(d, 'agents', 'data', 'memory', 'policies.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function row(id: string, name: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    name,
    category: 'custom',
    level: 'OPTIONAL',
    enforcementStage: 'pre-exec',
    rawMarkdown: `# ${name}\n`,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    isActive: 1,
    priority: 50,
    ...over,
  };
}

describe('planDedup (pure)', () => {
  it('returns nothing when every name is unique', () => {
    expect(
      planDedup([
        { id: 'a', name: 'x', isActive: true, version: 1, updatedAt: '' },
        { id: 'b', name: 'y', isActive: true, version: 1, updatedAt: '' },
      ])
    ).toEqual([]);
  });

  it('keeps the ACTIVE row over inactive duplicates', () => {
    const g = planDedup([
      { id: 'off1', name: 'dup', isActive: false, version: 9, updatedAt: '2026-05' },
      { id: 'on', name: 'dup', isActive: true, version: 1, updatedAt: '2026-01' },
      { id: 'off2', name: 'dup', isActive: false, version: 5, updatedAt: '2026-03' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].keep).toBe('on');
    expect(g[0].remove.sort()).toEqual(['off1', 'off2']);
  });

  it('among active rows keeps the highest version', () => {
    const g = planDedup([
      { id: 'v1', name: 'dup', isActive: true, version: 1, updatedAt: '2026-01' },
      { id: 'v3', name: 'dup', isActive: true, version: 3, updatedAt: '2026-01' },
      { id: 'v2', name: 'dup', isActive: true, version: 2, updatedAt: '2026-01' },
    ]);
    expect(g[0].keep).toBe('v3');
    expect(g[0].remove).toHaveLength(2);
  });
});

describe('storeRawPolicy is idempotent by name (prevention)', () => {
  it('re-storing the same policy updates in place, never duplicates', async () => {
    const mgr = new PolicyMemoryManager(tmpDbPath());
    const md = '# My Test Policy\n\n**Level**: OPTIONAL\n\nDo the thing.\n';
    await mgr.storeRawPolicy(md);
    await mgr.storeRawPolicy(md);
    await mgr.storeRawPolicy(md);
    const mine = (await mgr.getAllPolicies()).filter((p) => p.name === 'My Test Policy');
    expect(mine).toHaveLength(1);
    expect(mine[0].version).toBeGreaterThanOrEqual(3); // bumped, not re-created
  });

  it('preserves an operator disable across re-install', async () => {
    const db = tmpDbPath();
    const mgr = new PolicyMemoryManager(db);
    const md = '# Toggle Policy\n\n**Level**: OPTIONAL\n\nrule\n';
    const id = await mgr.storeRawPolicy(md);
    await mgr.togglePolicy(id, false); // operator disables
    await mgr.storeRawPolicy(md); // re-install (e.g. re-run setup)
    const rows = new DatabaseManager(db).getAllPolicyRows().filter((r) => r.name === 'Toggle Policy');
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive === true || rows[0].isActive === 1).toBe(false); // still off
  });
});

describe('dedupePolicies (clean up legacy duplicates)', () => {
  it('collapses same-name rows to one and removes the rest', async () => {
    const db = tmpDbPath();
    const raw = new DatabaseManager(db);
    raw.upsertPolicy(row('d1', 'Dup', { version: 1, updatedAt: '2026-01-01' }));
    raw.upsertPolicy(row('d2', 'Dup', { version: 2, updatedAt: '2026-02-01' }));
    raw.upsertPolicy(row('d3', 'Dup', { version: 3, updatedAt: '2026-03-01' }));
    raw.upsertPolicy(row('solo', 'Solo'));
    expect(raw.getAllPolicyRows()).toHaveLength(4);

    const res = await new PolicyMemoryManager(db).dedupePolicies();
    expect(res.removed).toBe(2);
    expect(res.kept).toBe(1); // one name deduped

    const after = new DatabaseManager(db).getAllPolicyRows();
    expect(after).toHaveLength(2);
    expect(after.filter((r) => r.name === 'Dup')).toHaveLength(1);
    expect(after.find((r) => r.name === 'Dup')?.id).toBe('d3'); // highest version kept
  });

  it('is a no-op when there are no duplicates', async () => {
    const db = tmpDbPath();
    const raw = new DatabaseManager(db);
    raw.upsertPolicy(row('a', 'One'));
    raw.upsertPolicy(row('b', 'Two'));
    const res = await new PolicyMemoryManager(db).dedupePolicies();
    expect(res.removed).toBe(0);
    expect(new DatabaseManager(db).getAllPolicyRows()).toHaveLength(2);
  });
});
