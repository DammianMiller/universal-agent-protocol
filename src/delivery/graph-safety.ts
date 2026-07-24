/**
 * Graph-engineering safety (S7).
 *
 * Pure implementations of the three failure modes from the graph-engineering
 * playbook, so a fan-out/fan-in decomposition is safe at scale:
 *
 *  1. FALSE INDEPENDENCE — two nodes with no data dependency but a shared write
 *     target (same file) have a hidden edge; they must serialize. `syntheticEdges`
 *     derives those edges from predicted writes (fed by the coordination DB).
 *  2. SILENT NODE FAILURE — one failed node among many vanishes into a report
 *     that looks complete. `reconcileFanIn` checks completed-vs-expected and
 *     surfaces the gap instead of synthesizing partial output.
 *  3. CONTEXT COLLAPSE — feeding N raw outputs into one consolidation blows the
 *     context window. `layerFanIn` batches into groups for layered summary.
 */

export interface GraphNode {
  id: string;
  /** File paths this node is predicted to write (from the coordination DB). */
  writes?: string[];
}

export interface SyntheticEdge {
  /** Earlier node (by input order) — the writer that goes first. */
  from: string;
  /** Later node — serialized after `from`. */
  to: string;
  /** The shared resource that forced the edge. */
  resource: string;
}

/**
 * Derive serialization edges between nodes that write the SAME file, even with
 * zero data dependency (false independence). Deterministic: for each shared
 * write target, chains the nodes in input order (earlier → later). Pure.
 */
export function syntheticEdges(nodes: GraphNode[]): SyntheticEdge[] {
  const byResource = new Map<string, string[]>();
  for (const n of nodes) {
    for (const w of n.writes ?? []) {
      const list = byResource.get(w) ?? [];
      if (!list.includes(n.id)) list.push(n.id);
      byResource.set(w, list);
    }
  }
  const edges: SyntheticEdge[] = [];
  for (const [resource, ids] of byResource) {
    for (let i = 1; i < ids.length; i++) {
      edges.push({ from: ids[i - 1], to: ids[i], resource });
    }
  }
  return edges;
}

export interface FanInReconciliation {
  complete: boolean;
  expectedCount: number;
  completedCount: number;
  /** Expected node ids with no completed result. */
  missing: string[];
}

/**
 * Silent-node-failure guard: compare completed node ids against the expected
 * set BEFORE synthesizing. `complete` is false when any expected node is
 * missing, so the caller flags the gap rather than shipping partial output.
 * Pure.
 */
export function reconcileFanIn(expected: string[], completed: string[]): FanInReconciliation {
  const done = new Set(completed);
  const missing = expected.filter((id) => !done.has(id));
  return {
    complete: missing.length === 0,
    expectedCount: expected.length,
    completedCount: expected.length - missing.length,
    missing,
  };
}

/**
 * Layer a list into fan-in batches (context-collapse fix). Batches of at most
 * `batchSize` (default 30) so a consolidation step summarizes group summaries
 * rather than N raw outputs. Pure.
 */
export function layerFanIn<T>(items: readonly T[], batchSize = 30): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Augment DAG phases with false-independence serialization edges: phases
 * predicted to write the SAME file get their `deps` extended so the scheduler
 * serializes them, even with zero data dependency. `predictWrites` is injected
 * (fed by the coordination DB's predicted writes). Pure — returns new phase
 * objects with a merged `deps`; input order defines the serialization chain.
 * This is the S7 fix wired at the DeliveryPhase layer.
 *
 * PRECONDITION: `phases` must be in an order consistent with their existing
 * `deps` (topologically ordered, as planDeliveryPhases emits). Synthetic edges
 * run earlier→later by input order; passing a phase before one it already
 * depends on could combine with the pre-existing dep to form a cycle. Callers
 * that don't guarantee topological input order should cycle-check the result.
 */
export function augmentPhasesWithWriteEdges<T extends { id: string; deps?: string[] }>(
  phases: readonly T[],
  predictWrites: (phase: T) => string[]
): Array<T & { deps: string[] }> {
  const nodes: GraphNode[] = phases.map((p) => ({ id: p.id, writes: predictWrites(p) }));
  const edges = syntheticEdges(nodes);
  const extra = new Map<string, Set<string>>();
  for (const e of edges) {
    const set = extra.get(e.to) ?? new Set<string>();
    set.add(e.from);
    extra.set(e.to, set);
  }
  return phases.map((p) => {
    const merged = new Set(p.deps ?? []);
    for (const from of extra.get(p.id) ?? []) merged.add(from);
    return { ...p, deps: [...merged] };
  });
}
