# Memory System Architecture Summary

## Overview

I have successfully read all three core memory system modules:

## 1. `predictive-memory.ts` (422 lines)

**Purpose:** Predicts which memory queries will be needed for a task and prefetches them to reduce latency.

**Key Components:**

- **5 Prediction Strategies:**
  - Task similarity (Jaccard similarity > 0.3 threshold)
  - Entity extraction (file paths, function names, quoted strings, technical terms)
  - Category-based prediction (8 categories: security, deployment, testing, refactor, database, api, performance, debugging)
  - Recent task context analysis
  - Learned keyword→query mappings
- **Learning System:** Tracks which queries were used for a task. This feeds the learning model so future predictions improve.
- **Persistence:** SQLite storage (`predictive.db`) for cross-session learning
- **Concurrent Prefetch:** Uses `concurrentMap` for bounded parallelism

**Main Class:** `PredictiveMemoryService`

- `predictNeededContext(taskDescription, recentTasks)` → predicted queries
- `prefetch(predictions, memoryService)` → prefetch results
- `recordAccess(taskDescription, queriesUsed)` → update learning model
- `saveToDb()` / `loadFromDb()` for persistence

## 2. `context-pruner.ts` (85 lines)

**Purpose:** Scores and prunes memories based on relevance, recency, and access frequency to fit within a token budget.

**Key Components:**

- **Composite Scoring Formula:**
  ```
  score = relevance * 0.5 + recency * 0.3 + frequency * 0.2
  ```

  - Recency = `1 / (1 + age_hours)`
  - Frequency = `min(accessCount / 10, 1)`
- **Token-Aware:** Uses accurate token estimator from `context-compressor`
- **Greedy Selection:** Keeps highest-scoring memories until budget exhausted

**Main Class:** `ContextPruner`

- `prune(memories, budget)` → pruned memory array
- `estimateTokens` re-exported from `context-compressor.ts`

## 3. `context-compressor.ts` (539 lines)

**Purpose:** Reduces token usage while preserving meaning.

**Key Features:**

- **Accurate Token Estimation:** Accounts for whitespace, special chars, camelCase, numbers
- **3 Compression Levels:**
  - **Light:** Remove whitespace/comments only
  - **Medium:** Also remove filler phrases/sentences
  - **Aggressive:** Extract only key facts (entities, decisions, actions)
- **Smart Truncation:** Head+tail split preserves setup and error context
- **Dynamic Compression:** Adjusts level based on remaining budget

**Main Classes/Functions:**

- `estimateTokens(text)` → token count
- `compressMemoryEntry(content, config)` → single entry compression
- `compressMemoryBatch(memories, config)` → batch compression
- `summarizeMemories(memories)` → consolidated summary
- `smartTruncate(content, maxChars)` → head+tail truncation
- `ContextBudget` → token budget manager
- `DynamicCompressor` → adaptive compression based on budget

---

## Data Flow:

```
Task Description
    ↓
[Task Classifier] → Categorize task
    ↓
[Predictive Memory] → Predict needed queries
    ↓
[Dynamic Retrieval] → Fetch relevant memories
    ↓
[Context Pruner] → Score and prune to budget
    ↓
[Context Compressor] → Compress if needed
    ↓
[LLM Context] → Final context for model
    ↓
[Memory Consolidator] → Store results
    ↓
[Predictive Memory] → Learn from access patterns
```

---

## Key Design Principles

1. **Predictive:** Prefetch before needed to reduce latency
2. **Adaptive:** Adjust compression/retrieval based on budget
3. **Persistent:** Cross-session learning via SQLite
4. **Efficient:** Token-aware pruning and compression
5. **Learnable:** Improves predictions over time
6. **Modular:** Each module has a single responsibility
7. **Backend-Agnostic:** Pluggable storage backends
