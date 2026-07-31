import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryGraph,
  reconstruct,
  heuristicPolicy,
  seedCuesFromQuery,
  activeReconstructionEnabled,
  type ReconstructionPolicy,
} from '../../src/memory/reconstruct.js';

describe('Cue–Tag–Content graph + active reconstruction (harness plan E)', () => {
  let dir: string;
  let graph: MemoryGraph;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-mem-graph-'));
    graph = new MemoryGraph(join(dir, 'graph.db'));
  });
  afterEach(() => {
    graph.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is OFF by default — the lift is measured before it becomes the default path', () => {
    delete process.env.UAP_MEMORY_ACTIVE;
    expect(activeReconstructionEnabled()).toBe(false);
    process.env.UAP_MEMORY_ACTIVE = '1';
    expect(activeReconstructionEnabled()).toBe(true);
    delete process.env.UAP_MEMORY_ACTIVE;
  });

  it('indexes content through tags, not cues alone', () => {
    const id = graph.addContent({
      layer: 'semantic',
      text: 'the deploy pipeline runs on staging first',
      cues: ['deploy', 'staging'],
      tags: ['release-process'],
    });
    expect(graph.tagsForCue('deploy')).toEqual(['release-process']);
    expect(graph.contentsFor('deploy', 'release-process').map((c) => c.id)).toEqual([id]);
    // The tag bridge is bidirectional: it is how a traversal finds NEW cues.
    expect(graph.cuesForTag('release-process').sort()).toEqual(['deploy', 'staging']);
  });

  it('supplies a coarse tag rather than indexing an item with none', () => {
    graph.addContent({ layer: 'episodic', text: 'anything', cues: ['x'], tags: [] });
    expect(graph.tagsForCue('x')).toEqual(['episodic']);
  });

  it('reaches evidence that is NOT lexically reachable from the query', () => {
    // The hop that passive top-k retrieval cannot make: the query names
    // "rollback", the answer text never does, and the bridge is the shared tag.
    graph.addContent({
      layer: 'episodic',
      text: 'rollback of the payments release',
      cues: ['rollback'],
      tags: ['payments-incident'],
    });
    graph.addContent({
      layer: 'semantic',
      text: 'the payments incident was caused by a stale migration',
      cues: ['migration'],
      tags: ['payments-incident'],
    });

    const r = reconstruct(graph, 'rollback', {
      policy: heuristicPolicy({ keepThreshold: 0, sufficientAt: 99 }),
    });
    const texts = r.context.map((c) => c.text);
    expect(texts.some((t) => t.includes('stale migration'))).toBe(true);
    // It took more than one hop to get there — that is the reconstruction.
    expect(r.steps.length).toBeGreaterThan(1);
  });

  it('prunes weak paths before they cost context', () => {
    graph.addContent({
      layer: 'episodic',
      text: 'database migration failed on staging',
      cues: ['migration'],
      tags: ['db'],
    });
    graph.addContent({
      layer: 'episodic',
      text: 'lunch order for the offsite was pizza',
      cues: ['migration'],
      tags: ['db'],
    });

    const r = reconstruct(graph, 'migration failed staging database', {
      policy: heuristicPolicy({ sufficientAt: 99 }),
    });
    expect(r.context.map((c) => c.text)).toEqual(['database migration failed on staging']);
    expect(r.steps[0].pruned).toHaveLength(1);
  });

  it('stops as soon as the policy declares the evidence sufficient', () => {
    for (let i = 0; i < 5; i++) {
      graph.addContent({ layer: 'episodic', text: `fact ${i} about deploys`, cues: ['deploy'], tags: ['t'] });
    }
    const r = reconstruct(graph, 'deploys', { policy: heuristicPolicy({ sufficientAt: 1 }) });
    expect(r.converged).toBe(true);
    expect(r.steps).toHaveLength(1);
  });

  it('respects the step cap when evidence never suffices', () => {
    graph.addContent({ layer: 'episodic', text: 'a', cues: ['x'], tags: ['t1'] });
    graph.addContent({ layer: 'episodic', text: 'b', cues: ['y'], tags: ['t1'] });
    const never: ReconstructionPolicy = {
      selectCues: (_q, active) => [...active],
      route: (_q, candidates) => ({ keep: candidates.map((c) => c.id), sufficient: false }),
    };
    const r = reconstruct(graph, 'x', { policy: never, maxSteps: 2 });
    expect(r.converged).toBe(false);
    expect(r.steps.length).toBeLessThanOrEqual(2);
  });

  it('never admits the same content twice across hops', () => {
    graph.addContent({
      layer: 'episodic',
      text: 'shared item',
      cues: ['a', 'b'],
      tags: ['t'],
    });
    const r = reconstruct(graph, 'a b', { policy: heuristicPolicy({ keepThreshold: 0, sufficientAt: 99 }) });
    expect(r.context).toHaveLength(1);
  });

  it('seeds from query tokens present in the graph, else from everything', () => {
    graph.addContent({ layer: 'episodic', text: 'x', cues: ['deploy'], tags: ['t'] });
    expect(seedCuesFromQuery(graph, 'how does deploy work')).toEqual(['deploy']);
    expect(seedCuesFromQuery(graph, 'unrelated question')).toEqual(['deploy']);
  });
});
