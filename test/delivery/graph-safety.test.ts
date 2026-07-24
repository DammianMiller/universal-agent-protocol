import { describe, it, expect } from 'vitest';
import { syntheticEdges, reconcileFanIn, layerFanIn } from '../../src/delivery/graph-safety.js';

describe('syntheticEdges — false-independence serialization', () => {
  it('adds an edge between two nodes writing the same file (zero data dep)', () => {
    const edges = syntheticEdges([
      { id: 'a', writes: ['src/x.ts'] },
      { id: 'b', writes: ['src/x.ts'] },
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b', resource: 'src/x.ts' }]);
  });

  it('does NOT edge nodes that write disjoint files (genuinely independent)', () => {
    const edges = syntheticEdges([
      { id: 'a', writes: ['src/x.ts'] },
      { id: 'b', writes: ['src/y.ts'] },
    ]);
    expect(edges).toEqual([]);
  });

  it('chains 3+ writers of the same file in input order', () => {
    const edges = syntheticEdges([
      { id: 'a', writes: ['f'] },
      { id: 'b', writes: ['f'] },
      { id: 'c', writes: ['f'] },
    ]);
    expect(edges).toEqual([
      { from: 'a', to: 'b', resource: 'f' },
      { from: 'b', to: 'c', resource: 'f' },
    ]);
  });

  it('handles nodes with no predicted writes', () => {
    expect(syntheticEdges([{ id: 'a' }, { id: 'b', writes: [] }])).toEqual([]);
  });
});

describe('reconcileFanIn — silent-node-failure guard', () => {
  it('flags missing nodes instead of reporting complete', () => {
    const r = reconcileFanIn(['a', 'b', 'c'], ['a', 'c']);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['b']);
    expect(r.completedCount).toBe(2);
    expect(r.expectedCount).toBe(3);
  });

  it('is complete only when every expected node has a result', () => {
    const r = reconcileFanIn(['a', 'b'], ['b', 'a']);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe('layerFanIn — context-collapse batching', () => {
  it('splits into batches of at most batchSize', () => {
    const items = Array.from({ length: 65 }, (_, i) => i);
    const batches = layerFanIn(items, 30);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(30);
    expect(batches[2].length).toBe(5);
    expect(batches.flat()).toEqual(items);
  });

  it('returns a single batch when under the threshold', () => {
    expect(layerFanIn([1, 2, 3], 30)).toEqual([[1, 2, 3]]);
  });
});
