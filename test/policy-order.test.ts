/**
 * Policy ordering (heuristic + AI-parse) and the dashboard CRUD manager methods
 * (duplicate, export/import round-trip).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { heuristicOrder, assignPriorities, buildOrderPrompt, parseOrderResponse, type OrderablePolicy } from '../src/policies/policy-order.js';
import { PolicyMemoryManager } from '../src/policies/policy-memory.js';

const dirs: string[] = [];
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-ord-'));
  dirs.push(d);
  mkdirSync(join(d, 'agents', 'data', 'memory'), { recursive: true });
  return join(d, 'agents', 'data', 'memory', 'policies.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pol(name: string, over: Partial<OrderablePolicy> = {}): OrderablePolicy {
  return { name, category: 'custom', level: 'OPTIONAL', stage: 'pre-exec', ...over };
}

describe('heuristicOrder', () => {
  it('orders pre-exec before post-exec before review', () => {
    const out = heuristicOrder([pol('c', { stage: 'review' }), pol('a', { stage: 'pre-exec' }), pol('b', { stage: 'post-exec' })]);
    expect(out.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('within a stage, REQUIRED beats RECOMMENDED beats OPTIONAL', () => {
    const out = heuristicOrder([pol('opt', { level: 'OPTIONAL' }), pol('req', { level: 'REQUIRED' }), pol('rec', { level: 'RECOMMENDED' })]);
    expect(out.map((p) => p.name)).toEqual(['req', 'rec', 'opt']);
  });

  it('within stage+level, cheap fail-fast categories fire before semantic ones', () => {
    const out = heuristicOrder([pol('docs', { category: 'documentation' }), pol('safe', { category: 'safety' })]);
    expect(out.map((p) => p.name)).toEqual(['safe', 'docs']);
  });
});

describe('assignPriorities', () => {
  it('maps an ordered list to a descending ladder (first highest)', () => {
    const m = assignPriorities(['a', 'b', 'c']);
    expect(m.get('a')).toBeGreaterThan(m.get('b')!);
    expect(m.get('b')).toBeGreaterThan(m.get('c')!);
  });
});

describe('parseOrderResponse', () => {
  const names = ['a', 'b', 'c'];
  it('keeps valid names, drops unknowns, appends omitted ones', () => {
    const r = parseOrderResponse('{"order":["c","zzz","a"],"rationale":"because"}', names);
    expect(r?.order).toEqual(['c', 'a', 'b']); // b was omitted → appended
    expect(r?.rationale).toBe('because');
  });
  it('returns null when nothing valid is present', () => {
    expect(parseOrderResponse('no json here', names)).toBeNull();
    expect(parseOrderResponse('{"order":["nope"]}', names)).toBeNull();
  });
  it('buildOrderPrompt lists every policy and asks for JSON', () => {
    const p = buildOrderPrompt([pol('x'), pol('y')]);
    expect(p).toContain('- x');
    expect(p).toContain('- y');
    expect(p).toMatch(/ONLY JSON/i);
  });
});

describe('duplicatePolicy', () => {
  it('creates a uniquely-named copy with a new id and rewritten title', async () => {
    const mgr = new PolicyMemoryManager(tmpDbPath());
    const id = await mgr.storeRawPolicy('# Base Policy\n\n**Level**: OPTIONAL\n\nrule\n');
    const copyId = await mgr.duplicatePolicy(id);
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe(id);
    const all = await mgr.getAllPoliciesUnfiltered();
    const names = all.map((p) => p.name).sort();
    expect(names).toEqual(['Base Policy', 'Base Policy (copy)']);
    const copy = all.find((p) => p.name === 'Base Policy (copy)')!;
    expect(copy.rawMarkdown).toContain('# Base Policy (copy)'); // H1 rewritten
  });

  it('increments the copy suffix when a copy already exists', async () => {
    const mgr = new PolicyMemoryManager(tmpDbPath());
    const id = await mgr.storeRawPolicy('# P\n\nrule\n');
    await mgr.duplicatePolicy(id);
    await mgr.duplicatePolicy(id);
    const names = (await mgr.getAllPoliciesUnfiltered()).map((p) => p.name).sort();
    expect(names).toContain('P (copy)');
    expect(names).toContain('P (copy 2)');
  });
});

describe('export / import round-trip', () => {
  it('exports policies and re-imports them into a fresh store', async () => {
    const src = new PolicyMemoryManager(tmpDbPath());
    await src.storeRawPolicy('# Alpha\n\n**Level**: REQUIRED\n\nrule\n');
    const bId = await src.storeRawPolicy('# Beta\n\n**Level**: OPTIONAL\n\nrule\n');
    await src.togglePolicy(bId, false); // Beta disabled
    const bundle = src.exportPolicies();
    expect(bundle.policies).toHaveLength(2);

    const dst = new PolicyMemoryManager(tmpDbPath());
    const res = await dst.importPolicies(bundle);
    expect(res.imported).toBe(2);
    const all = await dst.getAllPoliciesUnfiltered();
    expect(all.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
    // disabled state survived the round-trip
    expect(all.find((p) => p.name === 'Beta')?.isActive).toBe(false);
  });

  it('import is idempotent (upsert by name, no duplicates)', async () => {
    const db = tmpDbPath();
    const mgr = new PolicyMemoryManager(db);
    await mgr.storeRawPolicy('# Solo\n\nrule\n');
    const bundle = mgr.exportPolicies();
    await mgr.importPolicies(bundle);
    await mgr.importPolicies(bundle);
    expect((await mgr.getAllPoliciesUnfiltered()).filter((p) => p.name === 'Solo')).toHaveLength(1);
  });
});
