# Memory System

> UAP v1.91.0

> **🏭 Where this fits:** INTAKE + FEEDBACK — the front and back doors of the [delivery pipeline](./DELIVERY_PIPELINE.md). At intake, a fresh agent forgets everything the last session learned and re-hallucinates scope; at feedback, nobody records the lesson, so the same mistake ships again next week. **What it delivers:** a persistent, searchable memory that hands each new agent the relevant past learnings on the way in, and captures durable lessons on the way out — so your team of agents gets smarter every run instead of starting from zero.

The Universal Agent Protocol gives agents a persistent, multi-tier memory so
that learnings survive across sessions, compactions, and even harness switches.
The system is implemented as 27 modules under [`src/memory/`](../../src/memory/)
and is driven from the `uap memory` CLI.

The design goal is **token efficiency**: instead of replaying entire transcripts
into the context window, agents write small, high-signal memories and retrieve
only the most relevant ones on demand via semantic search.

## The four tiers

Memory flows from a cheap, high-churn staging area down to a durable, searchable
archive — think of it as raw notes at the head of the line being refined into
finished, shelved knowledge. Each tier has a distinct cost/permanence trade-off.

| Tier | Name | Storage | Purpose | Module(s) |
|------|------|---------|---------|-----------|
| 0 | Daily log | SQLite | Staging area for raw writes; "log first, promote later" | [`daily-log.ts`](../../src/memory/daily-log.ts), [`short-term/sqlite.ts`](../../src/memory/short-term/sqlite.ts), [`short-term/schema.ts`](../../src/memory/short-term/schema.ts) |
| 1 | Working cache | In-process / SQLite | Hot context with decay; predictive prefetch | [`speculative-cache.ts`](../../src/memory/speculative-cache.ts), [`predictive-memory.ts`](../../src/memory/predictive-memory.ts) |
| 2 | Semantic | Qdrant vectors | Embedding-based recall over consolidated knowledge | [`serverless-qdrant.ts`](../../src/memory/serverless-qdrant.ts), [`embeddings.ts`](../../src/memory/embeddings.ts) |
| 3 | Long-term archive | Pluggable backends | Durable, auditable store of promoted learnings | [`backends/base.ts`](../../src/memory/backends/base.ts), [`backends/factory.ts`](../../src/memory/backends/factory.ts), [`backends/github.ts`](../../src/memory/backends/github.ts), [`backends/qdrant-cloud.ts`](../../src/memory/backends/qdrant-cloud.ts) |

### Tier 0 — Daily log

Every observation an agent records lands first in the daily log, a SQLite-backed
staging table (`daily_log`). This follows a "log first, promote later" pattern:
writes are cheap and non-destructive, and a separate review step decides which
entries are worth keeping. Each entry carries a `suggestedTier` of either
`working` or `semantic` so promotion is guided rather than blind. See
[`daily-log.ts`](../../src/memory/daily-log.ts).

### Tier 1 — Working cache

The working cache holds the hot context an agent is likely to need next. Entries
**decay** over time so the cache stays small and relevant, and a predictive layer
prefetches likely-needed memories. See
[`speculative-cache.ts`](../../src/memory/speculative-cache.ts) and
[`predictive-memory.ts`](../../src/memory/predictive-memory.ts).

### Tier 2 — Semantic

Consolidated knowledge is embedded and stored as vectors in Qdrant. Recall is by
semantic similarity rather than exact match, so a query retrieves conceptually
related memories even when the wording differs. See
[`serverless-qdrant.ts`](../../src/memory/serverless-qdrant.ts).

### Tier 3 — Long-term archive

The durable archive is backend-pluggable. The bundled backends are selected via
[`backends/factory.ts`](../../src/memory/backends/factory.ts):

- **Qdrant Cloud** — managed vector store ([`backends/qdrant-cloud.ts`](../../src/memory/backends/qdrant-cloud.ts))
- **GitHub** — version-controlled archive ([`backends/github.ts`](../../src/memory/backends/github.ts))
- A common interface defined in [`backends/base.ts`](../../src/memory/backends/base.ts)

## Semantic recall

Tier 2/3 recall uses **real embeddings**, not placeholder hashes. The default
provider runs a local `nomic-embed-text-v2-moe` model via `llama-server` (or
Ollama) and produces **768-dimensional** vectors (Matryoshka — truncatable to
256). Running embeddings locally means semantic recall incurs no per-query API
cost. See [`embeddings.ts`](../../src/memory/embeddings.ts).

Queries return matches ranked by cosine similarity, filtered by a configurable
threshold (default `0.35`).

## Write gates

Not every observation deserves to be a memory. The write gate
([`write-gate.ts`](../../src/memory/write-gate.ts)) scores incoming content and
**rejects low-value writes** before they consume storage or pollute recall —
quality control at the feedback door, so the archive stays high-signal.
Rejections include:

- Empty content
- Content too short to be a meaningful memory
- Content matching a **noise pattern** (acknowledgements, transient requests)

Content that records a **decision and its reasoning**, a durable **preference or
convention**, or other high-signal information passes the gate. Rejected writes
come back with a `rejectionReason` so the caller knows why.

The gate can be bypassed deliberately with `--force` on `uap memory store`.

## Correction propagation

When a fact changes, you don't want stale copies lingering across tiers. The
correction propagator ([`correction-propagator.ts`](../../src/memory/correction-propagator.ts))
applies a correction **across all tiers** and marks the superseded entries with a
date and reason, preserving an **audit trail** in a `superseded_entries` table
rather than silently deleting. The result reports `tiersUpdated` and
`supersededCount`.

Trigger it from the CLI with `uap memory correct`.

## Supporting modules

Beyond the tiers, the system includes consolidation
([`memory-consolidator.ts`](../../src/memory/memory-consolidator.ts)), a
knowledge graph ([`knowledge-graph.ts`](../../src/memory/knowledge-graph.ts)),
task classification ([`task-classifier.ts`](../../src/memory/task-classifier.ts)),
dynamic retrieval ([`dynamic-retrieval.ts`](../../src/memory/dynamic-retrieval.ts)),
semantic compression
([`semantic-compression.ts`](../../src/memory/semantic-compression.ts)), and
scheduled maintenance
([`memory-maintenance.ts`](../../src/memory/memory-maintenance.ts)).

## The `uap memory` CLI

All commands are defined in [`src/bin/cli.ts`](../../src/bin/cli.ts) and
implemented in [`src/cli/memory.ts`](../../src/cli/memory.ts).

```bash
uap memory status        # Show memory system status
uap memory start         # Start memory services (Qdrant container)
uap memory stop          # Stop memory services
```

### Query

```bash
uap memory query <search> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-n, --limit <number>` | `10` | Max results |
| `-k, --top-k <number>` | `10` | Alias for `--limit` |
| `-t, --threshold <number>` | `0.35` | Minimum similarity score (0–1) |

```bash
uap memory query "qdrant connection retry" --limit 5 --threshold 0.5
```

### Store

```bash
uap memory store <content> [options]
```

Applies the write gate unless `--force` is passed.

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --tags <tags>` | — | Comma-separated tags |
| `-i, --importance <number>` | `5` | Importance score (1–10) |
| `-f, --force` | — | Bypass the write gate (store without quality check) |

```bash
uap memory store "Chose Qdrant over pgvector for HNSW recall speed" \
  --tags architecture,memory --importance 8
```

### Prepopulate

Seed memory from existing project knowledge.

```bash
uap memory prepopulate [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--docs` | — | Import from documentation only |
| `--git` | — | Import from git history only |
| `-n, --limit <number>` | `500` | Limit git commits to analyze |
| `--since <date>` | — | Only analyze commits since date (e.g. `2024-01-01`) |
| `-v, --verbose` | — | Show detailed output |

### Promote

Review daily-log (Tier 0) entries and promote significant ones into working or
semantic memory.

```bash
uap memory promote
```

### Correct

Find an existing memory and supersede it with a correction that propagates across
all tiers.

```bash
uap memory correct <search> [options]
```

| Option | Description |
|--------|-------------|
| `-c, --correction <text>` | The corrected content |
| `-r, --reason <reason>` | Reason for the correction |

```bash
uap memory correct "uses pgvector" \
  --correction "uses Qdrant for semantic recall" \
  --reason "migrated in v1.26"
```

### Maintain

Run scheduled maintenance: decay, prune stale entries, archive old ones, and
remove duplicates.

```bash
uap memory maintain [-v|--verbose]
```

## How agents use memory

The recommended decision loop (see the project `CLAUDE.md`) wires memory into
every task — pulling context in at intake and pushing lessons back out at
feedback:

1. **READ** recent context with `uap memory query`.
2. **QUERY** long-term memory for related learnings (semantic search).
3. **ACT** on the task.
4. **RECORD** observations back to the daily log (`uap memory store`).
5. **PROMOTE** significant learnings to long-term memory (`uap memory promote`).

Corrections discovered along the way are pushed with `uap memory correct` so the
fix cascades across tiers.

## How it saves tokens

- Agents retrieve a handful of **relevant** memories instead of replaying whole
  transcripts into context.
- The **write gate** keeps storage and recall results free of noise, so each
  retrieved item carries signal.
- **Decay** and **maintenance** keep the working set small.
- **Local embeddings** make semantic recall free of per-query API cost.
- **Correction propagation** prevents stale duplicates from inflating results.

See also the [MCP Router guide](./MCP_ROUTER.md) for compressing tool *output*
before it reaches the model.
