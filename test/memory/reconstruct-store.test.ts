import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMemoryGraph,
  recallActive,
  shouldUseActiveRecall,
  memoryGraphExists,
  memoryGraphPath,
  openMemoryGraph,
} from '../../src/memory/reconstruct-store.js';
import { heuristicPolicy, reconstruct, MemoryGraph } from '../../src/memory/reconstruct.js';
import type { IngestItem } from '../../src/memory/reconstruct-ingest.js';

const EXTRA: IngestItem[] = [
  { id: 'a', text: 'the deploy pipeline runs staging before production', tags: ['release'] },
  { id: 'b', text: 'release gate requires a green staging build', tags: ['release'] },
  { id: 'c', text: 'the coffee machine on floor two is broken', tags: ['office'] },
];

describe('memory graph store wiring (harness plan E3)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-mem-store-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('builds a graph under the memory data dir', async () => {
    expect(memoryGraphExists(cwd)).toBe(false);
    const report = await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    expect(report.ingested).toBe(3);
    expect(report.graphPath).toBe(memoryGraphPath(cwd));
    expect(memoryGraphExists(cwd)).toBe(true);
  });

  it('is incremental across calls — the ledger lives with the graph', async () => {
    await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    const second = await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('TRUNCATES on --rebuild instead of duplicating the corpus', async () => {
    // Resetting only the in-memory dedupe set left every row in place and
    // re-inserted the whole corpus under fresh ids, so two rebuilds meant every
    // memory twice — permanently, since the ledger then called them indexed.
    await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    const rebuilt = await buildMemoryGraph(cwd, { extra: EXTRA, rebuild: true, includeLongTerm: false });
    expect(rebuilt.ingested).toBe(3);
    const graph = openMemoryGraph(cwd);
    try {
      expect(graph.stats().contents).toBe(3);
    } finally {
      graph.close();
    }
  });

  it('reports tier coverage so a partial corpus cannot pass as complete', async () => {
    const report = await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    expect(report.coverage).toEqual({ shortTerm: 0, longTerm: 0 });
    expect(report.considered).toBe(3);
  });

  it('marks ONLY stored keys, so a skipped item is retried on the next build', async () => {
    // An item the extractor cannot cue must not be recorded as indexed — that
    // drops it forever, including after the extractor is upgraded.
    const noCue = { id: 'nc', text: 'the and for with that' };
    await buildMemoryGraph(cwd, { extra: [noCue], includeLongTerm: false });
    const graph = openMemoryGraph(cwd);
    try {
      expect(graph.ingestedKeys().size).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('recalls by traversal and prunes the unrelated memory', async () => {
    const r = await recallActive(cwd, 'staging release gate', {
      buildOptions: { extra: EXTRA, includeLongTerm: false },
      policy: heuristicPolicy({ sufficientAt: 99 }),
    });
    expect(r.graphEmpty).toBe(false);
    const texts = r.context.map((c) => c.text).join(' | ');
    expect(texts).toContain('staging');
    expect(texts).not.toContain('coffee machine');
  });

  it('reports an EMPTY GRAPH distinctly from an empty answer', async () => {
    // Different failures want different fixes: "build the index" vs "nothing
    // matched". Collapsing them into "no results" hides a broken setup.
    const r = await recallActive(cwd, 'anything', { buildOptions: { extra: [], includeLongTerm: false } });
    expect(r.graphEmpty).toBe(true);
    expect(r.context).toEqual([]);
  });

  it('does not route to active recall when the graph is empty', async () => {
    process.env.UAP_MEMORY_ACTIVE = '1';
    try {
      // Opted in, but nothing indexed — routing here would return nothing where
      // passive retrieval would have answered.
      expect(shouldUseActiveRecall(cwd)).toBe(false);
      await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
      expect(shouldUseActiveRecall(cwd)).toBe(true);
    } finally {
      delete process.env.UAP_MEMORY_ACTIVE;
    }
  });

  it('stays off without the opt-in even with a populated graph', async () => {
    delete process.env.UAP_MEMORY_ACTIVE;
    await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
    expect(shouldUseActiveRecall(cwd)).toBe(false);
  });

  it('survives a missing short-term store rather than failing the build', async () => {
    const report = await buildMemoryGraph(cwd, { shortTermPath: join(cwd, 'nope.db'), extra: EXTRA, includeLongTerm: false });
    expect(report.ingested).toBe(3);
  });
});

describe('traversal is bounded (review finding: unbounded fan-out)', () => {
  let dir: string;
  let graph: MemoryGraph;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-mem-bounded-'));
    graph = new MemoryGraph(join(dir, 'g.db'));
    // A densely connected graph: every entry shares one tag, so discovery
    // reseeds the active set with every cue in the store.
    for (let i = 0; i < 200; i++) {
      graph.addContent({
        layer: 'episodic',
        text: `entry ${i} about the shared topic`,
        cues: [`cue${i}`, 'shared'],
        tags: ['everything'],
      });
    }
  });
  afterEach(() => {
    graph.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps cue expansion per step', () => {
    // Unbounded, step 2 expands all ~201 cues — a full scan, which would make
    // this slower AND costlier than the passive top-k it replaces.
    const r = reconstruct(graph, 'shared topic', {
      policy: heuristicPolicy({ maxExpandPerStep: 10, sufficientAt: 10_000 }),
      maxContext: 10_000,
    });
    for (const step of r.steps) {
      expect(step.expandedCues.length).toBeLessThanOrEqual(10);
    }
  });

  it('caps admitted context — sufficiency only stops FURTHER steps', () => {
    const r = reconstruct(graph, 'shared topic', {
      policy: heuristicPolicy({ sufficientAt: 10_000 }),
      maxContext: 12,
    });
    expect(r.context.length).toBeLessThanOrEqual(12);
  });

  it('enforces the expansion cap even when the POLICY ignores it', () => {
    // The policy seam exists for an LLM to plug into, and an LLM will happily
    // return 200 cues — or cues that were never active. The bound has to live in
    // the traversal, not in the default policy's good manners.
    const rogue = {
      selectCues: (_q: string, active: string[]) => [...active, 'never-was-a-cue', 'invented'],
      route: (_q: string, candidates: { id: number }[]) => ({
        keep: candidates.map((c) => c.id),
        sufficient: false,
      }),
    };
    const r = reconstruct(graph, 'shared topic', {
      policy: rogue,
      maxExpandPerStep: 7,
      maxContext: 10_000,
    });
    for (const step of r.steps) {
      expect(step.expandedCues.length).toBeLessThanOrEqual(7);
      expect(step.expandedCues).not.toContain('invented');
    }
  });

  it('bounds the seed set when the query matches nothing in the graph', () => {
    const r = reconstruct(graph, 'zzz totally unrelated qqq', {
      policy: heuristicPolicy({ sufficientAt: 10_000 }),
      maxSeeds: 5,
      maxContext: 10_000,
    });
    expect(r.steps[0]?.expandedCues.length ?? 0).toBeLessThanOrEqual(5);
  });
});


describe('recall coverage and honesty', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-mem-cov-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('describeMemoryMode never claims active over an empty graph', async () => {
    process.env.UAP_MEMORY_ACTIVE = '1';
    try {
      const { describeMemoryMode } = await import('../../src/memory/reconstruct-store.js');
      expect(describeMemoryMode(cwd)).toBe('semantic retrieval');
      await buildMemoryGraph(cwd, { extra: EXTRA, includeLongTerm: false });
      expect(describeMemoryMode(cwd)).toBe('active reconstruction');
    } finally {
      delete process.env.UAP_MEMORY_ACTIVE;
    }
  });

  it('reports a stop reason a caller can give accurate advice from', async () => {
    const r = await recallActive(cwd, 'staging release gate', {
      buildOptions: { extra: EXTRA, includeLongTerm: false },
      maxContext: 1,
      policy: heuristicPolicy({ sufficientAt: 10_000 }),
    });
    // Context filled, not the step budget — telling the user to raise --steps
    // would be useless advice.
    expect(r.stopReason).toBe('context-full');
  });

  it('separates budget-dropped candidates from pruned ones', async () => {
    const r = await recallActive(cwd, 'staging release gate deploy pipeline', {
      buildOptions: { extra: EXTRA, includeLongTerm: false },
      maxContext: 1,
      policy: heuristicPolicy({ keepThreshold: 0, sufficientAt: 10_000 }),
    });
    const dropped = r.steps.reduce((n, s) => n + s.dropped.length, 0);
    expect(dropped).toBeGreaterThan(0);
  });
});
