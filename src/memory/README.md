# Memory Module

The memory module provides a 4-layer persistent memory system with hierarchical tiering (Hot/Warm/Cold) for AI agents.

## Architecture

```
+-------------------------------------------------------------------+
|  L1: WORKING       | Recent actions        | 50 max  | SQLite    |
|  L2: SESSION        | Current session       | Per run | SQLite    |
|  L3: SEMANTIC       | Long-term learnings   | Qdrant  | Vectors   |
|  L4: KNOWLEDGE      | Entity relationships  | SQLite  | Graph     |
+-------------------------------------------------------------------+
```

## Components (22 files)

### Core Memory Systems

| Component           | File                     | Purpose                                              |
| ------------------- | ------------------------ | ---------------------------------------------------- |
| Short-Term Memory   | `short-term/sqlite.ts`   | FTS5 full-text search, WAL mode                      |
| Short-Term Schema   | `short-term/schema.ts`   | FTS5 triggers, table definitions                     |
| Hierarchical Memory | `hierarchical-memory.ts` | Hot/warm/cold tiering with auto-promotion/demotion   |
| Dynamic Retrieval   | `dynamic-retrieval.ts`   | Adaptive depth, hierarchical query, 6 memory sources |

### Embedding Services

| Component         | File                       | Purpose                                               |
| ----------------- | -------------------------- | ----------------------------------------------------- |
| Embedding Service | `embeddings.ts`            | 5 providers: LlamaCpp, Ollama, OpenAI, Local, TF-IDF  |
| GitHub Backend    | `backends/github.ts`       | Store memories as JSON files in a GitHub repo         |
| Qdrant Backend    | `backends/qdrant-cloud.ts` | Vector search with project-isolated collections       |
| Backend Factory   | `backends/factory.ts`      | Backend selection and initialization                  |
| Backend Base      | `backends/base.ts`         | Interface definitions                                 |
| Serverless Qdrant | `serverless-qdrant.ts`     | Auto-start/stop Docker, cloud fallback, idle shutdown |

### Quality & Maintenance

| Component              | File                       | Purpose                                                   |
| ---------------------- | -------------------------- | --------------------------------------------------------- |
| Write Gate             | `write-gate.ts`            | Quality filter: 5 criteria, minimum score 0.3             |
| Daily Log              | `daily-log.ts`             | Staging area -- all writes land here first                |
| Correction Propagation | `correction-propagator.ts` | Cross-tier updates, old claims marked [superseded]        |
| Memory Maintenance     | `memory-maintenance.ts`    | Prune, decay, archive, deduplicate                        |
| Memory Consolidation   | `memory-consolidator.ts`   | Semantic dedup, quality scoring, background consolidation |

### Optimization Modules

| Component            | File                      | Purpose                                                     |
| -------------------- | ------------------------- | ----------------------------------------------------------- |
| Context Compression  | `context-compressor.ts`   | 3 levels (light/medium/aggressive), dynamic budget-aware    |
| Semantic Compression | `semantic-compression.ts` | Atomic facts extraction, token reduction                    |
| Speculative Cache    | `speculative-cache.ts`    | Pre-computes likely queries, LRU with TTL                   |
| Knowledge Graph      | `knowledge-graph.ts`      | Entities + relationships in SQLite, recursive CTE traversal |

### Advanced Features

| Component                | File                          | Purpose                                                |
| ------------------------ | ----------------------------- | ------------------------------------------------------ |
| Adaptive Context         | `adaptive-context.ts`         | 21 optimizations, historical benefit tracking          |
| Task Classifier          | `task-classifier.ts`          | 9 categories, suggests droids                          |
| Model Router             | `model-router.ts`             | Routes to optimal model by task type and cost          |
| Predictive Memory        | `predictive-memory.ts`        | Cross-session query prediction with SQLite persistence |
| Ambiguity Detector       | `ambiguity-detector.ts`       | Detects ambiguous task descriptions                    |
| Context Pruner           | `context-pruner.ts`           | Token-budget-aware memory pruning                      |
| Prepopulation            | `prepopulate.ts`              | Import from docs (markdown) and git history            |
| Terminal-Bench Knowledge | `terminal-bench-knowledge.ts` | Domain knowledge from benchmark analysis               |

## Usage Examples

```typescript
import { HierarchicalMemoryManager, getHierarchicalMemoryManager } from '@miller-tech/uap';

// Get memory manager instance
const memory = getHierarchicalMemoryManager();

// Store a memory
await memory.store('Best practice: Always validate user inputs', {
  type: 'lesson',
  importance: 8,
});

// Query memories
const results = await memory.query('authentication', { topK: 5 });
```

## Configuration

```typescript
interface HierarchicalConfig {
  hot: { maxSize: number; autoPromote: boolean };
  warm: { maxSize: number; accessThreshold: number };
  cold: { maxSize: number; compressionEnabled: boolean };
}
```

## Performance Characteristics

- **Hot tier**: <1ms latency, always in context
- **Warm tier**: ~5ms latency, promoted on frequent access
- **Cold tier**: ~50ms latency, semantic search only, compressed

## Time-Decay Formula

```typescript
effective_importance = (importance * decayRate) ^ daysSinceAccess;
```

## See Also

- [Memory System Architecture](../../docs/architecture/SYSTEM_ANALYSIS.md)
- [API Reference](../../docs/reference/API_REFERENCE.md)
- [Features Documentation](../../docs/reference/FEATURES.md)
