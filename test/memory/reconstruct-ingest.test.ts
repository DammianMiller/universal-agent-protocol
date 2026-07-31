import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph, reconstruct, heuristicPolicy } from '../../src/memory/reconstruct.js';
import {
  ingestItems,
  heuristicExtractor,
  itemKey,
  type IngestItem,
} from '../../src/memory/reconstruct-ingest.js';

describe('heuristicExtractor (harness plan E1)', () => {
  it('pulls identifiers and paths as cues — what a later query actually names', () => {
    const { cues } = heuristicExtractor.extract({
      text: 'fixed the deadlock in src/delivery/convergence-loop.ts by reordering acquireLock',
    });
    expect(cues).toContain('src/delivery/convergence-loop.ts');
    expect(cues).toContain('acquirelock');
  });

  it('derives a directory tag so entries touching the same area associate', () => {
    // The classic associative bridge: two memories with no word in common still
    // relate because they touch the same subtree.
    const a = heuristicExtractor.extract({ text: 'patched src/delivery/applier.ts' });
    const b = heuristicExtractor.extract({ text: 'reverted src/delivery/critic.ts' });
    expect(a.tags).toContain('src/delivery');
    expect(b.tags).toContain('src/delivery');
  });

  it('routes stable knowledge to the semantic layer and events to episodic', () => {
    expect(heuristicExtractor.extract({ text: 'x', type: 'decision' }).layer).toBe('semantic');
    expect(heuristicExtractor.extract({ text: 'x', type: 'action' }).layer).toBe('episodic');
  });

  it('keeps the store\'s own tags — an operator tag is the best bridge available', () => {
    const { tags } = heuristicExtractor.extract({ text: 'anything', tags: ['Deploy', 'ci'] });
    expect(tags).toContain('deploy');
    expect(tags).toContain('ci');
  });

  it('drops stopwords that would fan out to the whole graph', () => {
    const { cues } = heuristicExtractor.extract({ text: 'the and for with that this from' });
    expect(cues).toEqual([]);
  });

  it('does NOT emit hub tags when a real bridge exists', () => {
    // The entry type and a year-month bucket were derived tags. They are hubs,
    // not bridges: a 6-value enum tags ~1/6 of the corpus and a month links
    // everything written that month, so the graph goes near-complete within two
    // hops and pruning does all the discrimination the structure should do.
    const { tags } = heuristicExtractor.extract({
      text: 'patched src/delivery/applier.ts',
      type: 'action',
      occurredAt: '2026-07-31T10:00:00Z',
    });
    expect(tags).toContain('src/delivery');
    expect(tags).not.toContain('action');
    expect(tags.some((t) => t.startsWith('when:'))).toBe(false);
  });

  it('falls back to a coarse tag only when nothing else would connect the entry', () => {
    // An edge of last resort still beats an unreachable node.
    const { tags } = heuristicExtractor.extract({ text: 'plain prose with no path', type: 'action' });
    expect(tags).toEqual(['action']);
  });

  it('does not let a capitalised stopword through as a cue', () => {
    // The identifier regex bypassed STOPWORDS, so "The deploy failed" produced
    // the cue `the` — attached to a large fraction of entries, which is exactly
    // the fan-out-to-everything cue the list exists to remove.
    const { cues } = heuristicExtractor.extract({ text: 'The deploy failed. This broke staging.' });
    expect(cues).not.toContain('the');
    expect(cues).not.toContain('this');
  });
});

describe('ingestItems (harness plan E1)', () => {
  let dir: string;
  let graph: MemoryGraph;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-ingest-'));
    graph = new MemoryGraph(join(dir, 'g.db'));
  });
  afterEach(() => {
    graph.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ITEMS: IngestItem[] = [
    { id: '1', text: 'deploy of the payments service failed on staging', tags: ['incident'] },
    { id: '2', text: 'the payments rollback was caused by a stale migration', tags: ['incident'] },
    { id: '3', text: 'lunch order for the offsite was pizza', tags: ['social'] },
  ];

  it('populates the graph and reports what was built', () => {
    const r = ingestItems(graph, ITEMS);
    expect(r.ingested).toBe(3);
    expect(r.cues).toBeGreaterThan(0);
    expect(graph.stats().contents).toBe(3);
  });

  it('counts BRIDGING tags but excludes near-universal hubs', () => {
    // A tag on exactly one memory is an index entry, not a link. A tag on EVERY
    // memory links everything and discriminates nothing — counting it would
    // report health while the graph is a hairball.
    const many: IngestItem[] = [];
    for (let i = 0; i < 10; i++) {
      many.push({ id: `p${i}`, text: `entry ${i} about deployment`, tags: ['everywhere', 'pair'] });
    }
    for (let i = 0; i < 10; i++) {
      many.push({ id: `q${i}`, text: `entry q${i} about billing`, tags: ['everywhere'] });
    }
    ingestItems(graph, many);
    const s = graph.stats();
    // 'pair' covers 10/20 = 50% -> a bridge. 'everywhere' covers 100% -> a hub.
    expect(s.bridgingTags).toBe(1);
  });

  it('re-ingests an entry whose CONTENT changed under the same source id', () => {
    // `uap memory correct` rewrites in place keeping the rowid. Keying the
    // ledger on the id alone made the graph serve the pre-correction text
    // forever, exempting active recall from the correction propagator.
    const seen = new Set<string>();
    ingestItems(graph, [{ id: 'm1', text: 'the deploy targets staging' }], { seen });
    expect(graph.stats().contents).toBe(1);
    ingestItems(graph, [{ id: 'm1', text: 'the deploy targets production' }], { seen });
    expect(graph.stats().contents).toBe(2);
  });

  it('does NOT mark a no-cue item as ingested — a better extractor must retry it', () => {
    const seen = new Set<string>();
    const item = { id: 'z', text: 'the and for' };
    expect(ingestItems(graph, [item], { seen }).ingested).toBe(0);
    expect(seen.size).toBe(0);
    // Same item, an extractor that CAN find a cue in it: it must still be seen.
    const better = {
      id: 'better',
      extract: () => ({ cues: ['forced'], tags: ['t'], layer: 'episodic' as const }),
    };
    expect(ingestItems(graph, [item], { seen, extractor: better }).ingested).toBe(1);
  });

  it('is incremental — re-ingesting the same sources is a no-op', () => {
    const seen = new Set<string>();
    const first = ingestItems(graph, ITEMS, { seen });
    expect(first.ingested).toBe(3);
    expect(first.storedKeys).toHaveLength(3);
    expect(ingestItems(graph, ITEMS, { seen }).ingested).toBe(0);
    expect(graph.stats().contents).toBe(3);
  });

  it('skips an item with no usable cue rather than storing something unreachable', () => {
    const r = ingestItems(graph, [{ text: 'the and for' }]);
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('gives an untagged item a stable key so dedupe survives a restart', () => {
    const k1 = itemKey({ text: 'same text' });
    const k2 = itemKey({ text: 'same text' });
    expect(k1).toBe(k2);
    expect(itemKey({ text: 'other' })).not.toBe(k1);
  });

  it('produces a graph a traversal can actually reason over', () => {
    // End-to-end: ingest real-shaped prose, then reach the second memory from a
    // query that names only the first. That hop is the thing passive top-k
    // cannot make.
    ingestItems(graph, ITEMS);
    const r = reconstruct(graph, 'payments deploy failed staging', {
      policy: heuristicPolicy({ sufficientAt: 99 }),
    });
    const texts = r.context.map((c) => c.text).join(' | ');
    expect(texts).toContain('payments service failed');
    expect(texts).toContain('stale migration');
    // The unrelated memory was pruned, not carried into context.
    expect(texts).not.toContain('pizza');
  });
});

describe('graph source ledger', () => {
  it('persists ingested keys so a rebuild is incremental across processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-ledger-'));
    try {
      const path = join(dir, 'g.db');
      const g1 = new MemoryGraph(path);
      g1.markIngested(['a', 'b']);
      g1.close();

      const g2 = new MemoryGraph(path);
      expect([...g2.ingestedKeys()].sort()).toEqual(['a', 'b']);
      g2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
