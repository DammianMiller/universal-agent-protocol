/**
 * Ingestion bridge for active memory reconstruction (harness plan E1 → E3).
 *
 * `reconstruct.ts` shipped as a substrate with no way to fill it: `addContent`
 * was reachable only from tests, so `UAP_MEMORY_ACTIVE=1` traversed an empty
 * graph. This module is the missing half — it turns UAP's existing memory
 * entries into the Cue–Tag–Content triples the traversal needs.
 *
 * THE TAG LAYER IS THE CONTRIBUTION (arXiv 2606.06036): cue → content direct
 * indexing recalls ~65%, cue → TAG → content with multi-turn reasoning ~90%. So
 * extraction here is judged on whether it produces tags that genuinely BRIDGE
 * entries — a tag that applies to exactly one memory is an index entry, not an
 * associative link, and buys nothing.
 *
 * Extraction is deterministic by default and injectable, exactly like
 * `ReconstructionPolicy`. The paper uses an LLM; a deterministic extractor keeps
 * ingestion offline, reproducible and unit-testable, and an LLM extractor can be
 * dropped into the same seam when the paired bench says it earns its cost.
 */

import { createHash } from 'node:crypto';
import { MemoryGraph, type MemoryLayer } from './reconstruct.js';

/** One memory entry to ingest, normalised across UAP's stores. */
export interface IngestItem {
  /** Stable identity — the same source entry must not be ingested twice. */
  id?: string;
  text: string;
  /** Source classification ('action' | 'observation' | 'decision' | ...). */
  type?: string;
  /** Tags already attached by the store; these are the best bridges we have. */
  tags?: string[];
  /** ISO timestamp of the source entry. */
  occurredAt?: string;
}

/** Cue/tag extraction for one item. Injectable so an LLM can replace it. */
export interface ElementExtractor {
  readonly id: string;
  extract(item: IngestItem): { cues: string[]; tags: string[]; layer: MemoryLayer };
}

/**
 * Words that would become cues on nearly every entry, making them useless as
 * discriminators and expensive as traversal seeds (every one fans out to the
 * whole graph). Deliberately short — over-pruning loses real entities.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'were', 'has', 'have',
  'had', 'not', 'but', 'you', 'your', 'are', 'its', 'his', 'her', 'their', 'they', 'them',
  'what', 'when', 'where', 'which', 'while', 'will', 'would', 'should', 'could', 'been',
  'than', 'then', 'there', 'here', 'about', 'after', 'before', 'over', 'under', 'also',
  'run', 'ran', 'use', 'used', 'using', 'get', 'got', 'set', 'add', 'added', 'via',
]);

/** Entries whose type implies stable knowledge rather than a one-off event. */
const SEMANTIC_TYPES = new Set(['decision', 'learning', 'preference', 'fact', 'knowledge', 'insight']);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Deterministic extractor.
 *
 * Cues are the discriminating surface forms — identifiers, paths, and salient
 * words. Tags come from the entry's own tags plus a small number of DERIVED
 * ones, because a store where most entries are untagged would otherwise produce
 * a graph with no bridges at all.
 */
export const heuristicExtractor: ElementExtractor = {
  id: 'heuristic',
  extract(item: IngestItem) {
    const text = item.text ?? '';
    const layer: MemoryLayer = SEMANTIC_TYPES.has(String(item.type)) ? 'semantic' : 'episodic';

    // Identifiers and paths are the highest-value cues: they are what a later
    // query actually names, and they are rare enough to discriminate.
    const identifiers = new Set<string>();
    for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*[./][A-Za-z0-9_./-]+/g)) {
      identifiers.add(m[0].toLowerCase());
    }
    for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
      const id = m[0].toLowerCase();
      // The identifier regex bypassed STOPWORDS entirely, so any sentence-initial
      // capitalised stopword ("The deploy failed") became a cue — exactly the
      // fan-out-to-everything cue the list exists to remove.
      if (!STOPWORDS.has(id)) identifiers.add(id);
    }

    const words = tokens(text);
    // Frequency-ranked salient words fill out the cue set for prose entries that
    // contain no identifiers at all.
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    const salient = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([w]) => w);

    const cues = [...new Set([...identifiers, ...salient])].slice(0, 12);

    // Tags: the store's own first (an operator's tag is a real bridge), then
    // derived ones so untagged entries still connect to something.
    const tags = new Set<string>((item.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    // A path's owning directory is the classic associative bridge: everything
    // touching `src/delivery/` relates, even with no word in common.
    for (const id of identifiers) {
      const slash = id.lastIndexOf('/');
      if (slash > 0) tags.add(id.slice(0, slash));
    }
    // The entry TYPE and a year-month bucket were derived tags too. They are
    // hubs, not bridges: a 6-value enum tags ~1/6 of the corpus and a month
    // links everything written that month, so within two hops the graph is
    // effectively complete and pruning does all the discrimination the
    // structure was supposed to do. Kept ONLY as a last resort so an entry with
    // no other tag still has an edge.
    if (tags.size === 0) {
      if (item.type) tags.add(String(item.type).toLowerCase());
      else tags.add(SEMANTIC_TYPES.has(String(item.type)) ? 'semantic' : 'episodic');
    }

    return { cues, tags: [...tags].slice(0, 8), layer };
  },
};

/**
 * Ledger key for an item.
 *
 * Deliberately includes a CONTENT hash and the extractor id, not just the source
 * id. `uap memory correct` rewrites an entry in place keeping its rowid, so an
 * id-only key made the graph serve the pre-correction text forever; and swapping
 * in the LLM extractor the seam exists for would have re-processed nothing.
 */
export function itemKey(item: IngestItem, extractorId = 'heuristic'): string {
  const hash = createHash('sha1').update(item.text ?? '').digest('hex').slice(0, 16);
  return `${item.id ?? 'anon'}:${hash}:${extractorId}`;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
  /**
   * Keys that were actually STORED. Only these may go in the ledger: marking a
   * skipped item as ingested drops it forever, including after the extractor is
   * upgraded.
   */
  storedKeys: string[];
  cues: number;
  tags: number;
  /**
   * Tags that link MORE THAN ONE content node — the ones doing associative
   * work. Reported because a graph whose tags are all singletons has the shape
   * of the ~65%-recall ablation and none of the benefit.
   */
  bridgingTags: number;
}

/**
 * Ingest items into the graph, skipping ones already present.
 *
 * `seen` is the caller's dedupe set (persisted alongside the graph), so a second
 * `uap memory graph build` is incremental rather than duplicating every entry.
 */
export function ingestItems(
  graph: MemoryGraph,
  items: IngestItem[],
  opts: { extractor?: ElementExtractor; seen?: Set<string> } = {},
): IngestResult {
  const extractor = opts.extractor ?? heuristicExtractor;
  const seen = opts.seen ?? new Set<string>();
  const cueSet = new Set<string>();
  const tagCounts = new Map<string, number>();
  const storedKeys: string[] = [];
  let ingested = 0;
  let skipped = 0;

  for (const item of items) {
    const text = (item.text ?? '').trim();
    if (!text) {
      skipped++;
      continue;
    }
    const key = itemKey(item, extractor.id);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    const { cues, tags, layer } = extractor.extract(item);
    if (cues.length === 0) {
      // No cue means no entry point; storing it would be dead weight the
      // traversal can never reach. NOT marked as seen — a better extractor must
      // get another chance at it.
      skipped++;
      continue;
    }
    graph.addContent({ layer, text, occurredAt: item.occurredAt, cues, tags });
    seen.add(key);
    storedKeys.push(key);
    ingested++;
    for (const c of cues) cueSet.add(c);
    for (const t of tags.length > 0 ? tags : [layer]) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }

  let bridgingTags = 0;
  for (const n of tagCounts.values()) if (n > 1) bridgingTags++;

  return { ingested, skipped, storedKeys, cues: cueSet.size, tags: tagCounts.size, bridgingTags };
}
