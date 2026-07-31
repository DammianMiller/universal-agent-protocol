import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveDynamicMemoryContext } from '../../src/memory/dynamic-retrieval.js';
import { buildMemoryGraph } from '../../src/memory/reconstruct-store.js';
import type { IngestItem } from '../../src/memory/reconstruct-ingest.js';

/**
 * Two memories with NO word in common, bridged by a shared tag. Passive top-k
 * over the query can reach the first; only a traversal reaches the second.
 */
const BRIDGED: IngestItem[] = [
  { id: 'a', text: 'rollback of the checkout release on staging', tags: ['payments-incident'] },
  { id: 'b', text: 'root cause was a stale database migration', tags: ['payments-incident'] },
  { id: 'c', text: 'the office plant needs watering on fridays', tags: ['facilities'] },
];

describe('agent context path — active reconstruction as an ADDITIONAL source', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-agent-recall-'));
    mkdirSync(join(cwd, 'agents', 'data', 'memory'), { recursive: true });
  });
  afterEach(() => {
    delete process.env.UAP_MEMORY_ACTIVE;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('contributes nothing when the operator has not opted in', async () => {
    await buildMemoryGraph(cwd, { extra: BRIDGED, includeLongTerm: false });
    delete process.env.UAP_MEMORY_ACTIVE;

    const ctx = await retrieveDynamicMemoryContext('checkout rollback staging', cwd);
    expect(ctx.relevantMemories.some((m) => m.source === 'active-reconstruction')).toBe(false);
  });

  it('contributes associative hops once opted in, without removing other sources', async () => {
    await buildMemoryGraph(cwd, { extra: BRIDGED, includeLongTerm: false });
    process.env.UAP_MEMORY_ACTIVE = '1';

    const ctx = await retrieveDynamicMemoryContext('checkout rollback staging', cwd);
    const active = ctx.relevantMemories.filter((m) => m.source === 'active-reconstruction');
    expect(active.length).toBeGreaterThan(0);

    // The hop: reached via the shared tag, not via any word in the query.
    const text = active.map((m) => m.content).join(' | ');
    expect(text).toContain('stale database migration');
    // And the unrelated memory stayed out.
    expect(text).not.toContain('office plant');
  });

  it('ranks associative hops BELOW the passive range so they fill, not displace', async () => {
    await buildMemoryGraph(cwd, { extra: BRIDGED, includeLongTerm: false });
    process.env.UAP_MEMORY_ACTIVE = '1';

    const ctx = await retrieveDynamicMemoryContext('checkout rollback staging', cwd);
    for (const m of ctx.relevantMemories.filter((x) => x.source === 'active-reconstruction')) {
      expect(m.relevance).toBeLessThanOrEqual(0.7);
      expect(m.relevance).toBeGreaterThanOrEqual(0.35);
    }
  });

  it('stays silent — never throws — when the graph is absent', async () => {
    process.env.UAP_MEMORY_ACTIVE = '1';
    // No graph built at all: the passive path must still answer normally.
    const ctx = await retrieveDynamicMemoryContext('anything at all', cwd);
    expect(ctx.relevantMemories.some((m) => m.source === 'active-reconstruction')).toBe(false);
    expect(ctx.classification).toBeDefined();
  });

  it('does not rebuild the index on every retrieval', async () => {
    await buildMemoryGraph(cwd, { extra: BRIDGED, includeLongTerm: false });
    process.env.UAP_MEMORY_ACTIVE = '1';

    const { openMemoryGraph } = await import('../../src/memory/reconstruct-store.js');
    const refreshedAt = () => {
      const g = openMemoryGraph(cwd);
      try {
        return g.lastRefreshedAt();
      } finally {
        g.close();
      }
    };

    const before = refreshedAt();
    expect(before).not.toBeNull();

    await retrieveDynamicMemoryContext('checkout rollback', cwd);
    await retrieveDynamicMemoryContext('database migration', cwd);

    // Asserts on the REFRESH heartbeat, not on lastIngestedAt(). The ingest
    // timestamp only moves when something new is stored, so a rebuild that
    // found nothing would leave it unchanged and this test could never fail —
    // which is exactly the bug the heartbeat was added to expose.
    expect(refreshedAt()).toBe(before);
  });

  it('truncates its content like every other source', async () => {
    const long = 'alpha '.repeat(400) + 'checkout rollback staging';
    await buildMemoryGraph(cwd, {
      extra: [{ id: 'big', text: long, tags: ['payments-incident'] }, ...BRIDGED],
      includeLongTerm: false,
    });
    process.env.UAP_MEMORY_ACTIVE = '1';

    const ctx = await retrieveDynamicMemoryContext('checkout rollback staging', cwd, {
      useSemanticCompression: false,
    });
    for (const m of ctx.relevantMemories.filter((x) => x.source === 'active-reconstruction')) {
      // The merged budget loop BREAKS on the first overflowing item, so one
      // multi-KB node would discard every lower-ranked passive memory under it.
      expect(m.content.length).toBeLessThanOrEqual(500);
    }
  });
});
