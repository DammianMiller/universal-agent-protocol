/**
 * The policy read paths must tolerate a malformed row (e.g. an invalid `level`
 * like "mandatory") instead of throwing — one bad row used to 500 the dashboard
 * /api/policies endpoint via getAllPoliciesUnfiltered -> PolicySchema.parse.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PolicyMemoryManager } from '../src/policies/policy-memory.js';
import { DatabaseManager } from '../src/policies/database-manager.js';

const dirs: string[] = [];
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-polres-'));
  dirs.push(d);
  mkdirSync(join(d, 'agents', 'data', 'memory'), { recursive: true });
  return join(d, 'agents', 'data', 'memory', 'policies.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Valid uuid + ISO dates so `level` is the only variable under test (the schema
// legitimately requires those; a bad one there is correctly skipped, not coerced).
function row(_id: string, name: string, level: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name, category: 'quality', level, enforcementStage: 'pre-exec',
    rawMarkdown: `# ${name}\n`, tags: [], createdAt: now, updatedAt: now,
    version: 1, isActive: 1, priority: 50,
  };
}

describe('resilient policy read', () => {
  it('does NOT throw and keeps the good rows when one has an invalid level', async () => {
    const db = tmpDbPath();
    const raw = new DatabaseManager(db);
    raw.upsertPolicy(row('a', 'Good', 'REQUIRED'));
    raw.upsertPolicy(row('b', 'BadLevel', 'mandatory')); // the octopus failure
    raw.upsertPolicy(row('c', 'AlsoGood', 'OPTIONAL'));

    const mgr = new PolicyMemoryManager(db);
    const all = await mgr.getAllPoliciesUnfiltered(); // used to throw on 'mandatory'
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.name).sort()).toEqual(['AlsoGood', 'BadLevel', 'Good']);
  });

  it('coerces "mandatory" to REQUIRED (never leaks an invalid enum)', async () => {
    const db = tmpDbPath();
    const raw = new DatabaseManager(db);
    raw.upsertPolicy(row('b', 'BadLevel', 'mandatory'));
    const all = await new PolicyMemoryManager(db).getAllPoliciesUnfiltered();
    expect(all).toHaveLength(1);
    expect(all[0].level).toBe('REQUIRED');
    expect(['REQUIRED', 'RECOMMENDED', 'OPTIONAL']).toContain(all[0].level);
  });

  it('coerces an unknown level to RECOMMENDED (kept, not dropped)', async () => {
    const db = tmpDbPath();
    const raw = new DatabaseManager(db);
    raw.upsertPolicy(row('a', 'Good', 'RECOMMENDED'));
    raw.upsertPolicy(row('b', 'Weird', 'whoknows'));
    const all = await new PolicyMemoryManager(db).getAllPoliciesUnfiltered();
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.name === 'Weird')?.level).toBe('RECOMMENDED');
  });
});
