# Database Schema Reference

> Universal Agent Protocol (UAP) v1.91.0

> **🏭 Where this fits:** Cross-cutting — the shop's records and shift log.
> **What it delivers:** the durable memory of your [delivery pipeline](../guides/DELIVERY_PIPELINE.md)
> — tasks, coordination, policies, and what the floor has learned — so nothing a
> station knows is lost when the session ends.

These databases are the factory's paperwork: the job tickets, the coordination
board, the enforced rulebook, and the long-term memory that lets tomorrow's
session pick up where today's left off. UAP persists state in a set of SQLite
databases (via `better-sqlite3`, WAL mode) plus a Qdrant vector store for
semantic search. All schemas below are grounded in source. Paths are resolved
relative to the project working directory unless noted otherwise.

## SQLite databases

| DB file | Owning module | Purpose |
|---------|---------------|---------|
| `.uap/tasks/tasks.db` (+ `tasks.jsonl` mirror) | `src/tasks/database.ts` | Task tracking, dependency DAG, history. |
| `.uap/worktree_registry.db` (legacy `.uam/...`) | `src/cli/worktree.ts` | Worktree registry. |
| `agents/data/coordination/coordination.db` | `src/coordination/database.ts`, `adaptive-patterns.ts` | Multi-agent coordination + adaptive pattern outcomes. |
| `agents/data/memory/policies.db` | `src/policies/database-manager.ts` | Executable policy engine. |
| `agents/data/memory/short_term.db` | `src/memory/short-term/schema.ts` (+ daily-log, correction-propagator) | Short-term (L1/L2) memory, sessions, knowledge graph. |
| `agents/data/memory/model_analytics.db` | `src/models/analytics.ts` | Model task-outcome analytics. |
| `agents/data/memory/model_fingerprints.db` | `src/memory/model-router.ts` (package-relative path) | Model routing fingerprints. |
| `agents/data/memory/historical_context.db` | `src/memory/adaptive-context.ts` | Historical task outcomes + semantic cache. |
| `agents/data/memory/predictive.db` | `src/memory/predictive-memory.ts` | Predictive query learning. |
| `agents/data/memory/telemetry.db` | `src/dashboard/data-service.ts` | Dashboard telemetry time-series + session history. |
| `agents/data/memory/session.db` | `src/dashboard/data-service.ts` | Dashboard display view (sessions/agents/skills/...). |
| `agents/data/memory/session_snapshots.db` | read-only in `src/cli/dashboard.ts` | Session snapshots. |
| Hierarchical memory DB (caller-supplied path) | `src/memory/hierarchical-memory.ts` | Tiered hot/warm/cold memory. |

## Tasks DB (`src/tasks/database.ts`)

| Table | Key columns |
|-------|-------------|
| `tasks` | `id` PK, `title`, `description`, `type` (task/bug/feature/epic/chore/story), `status` (open/in_progress/blocked/done/wont_do), `priority` (0-4), `assignee`, `worktree_branch`, `labels`, `parent_id` FK, timestamps, `closed_reason` |
| `task_dependencies` | `from_task` FK, `to_task` FK, `dep_type` (blocks/related/discovered_from), `UNIQUE(from_task,to_task)` |
| `task_history` | `task_id` FK, `field`, `old_value`, `new_value`, `changed_by`, `changed_at` |
| `task_activity` | `task_id` FK, `agent_id`, `activity` (claimed/released/commented/updated/created/closed), `timestamp` |
| `task_summaries` | `original_ids`, `summary`, `labels`, `closed_period`, `created_at` |

## Worktree Registry DB (`src/cli/worktree.ts`)

| Table | Key columns |
|-------|-------------|
| `worktrees` | `id` PK, `slug` UNIQUE, `branch_name`, `worktree_path`, `created_at`, `status` (default `active`) |

## Coordination DB (`src/coordination/database.ts`, `adaptive-patterns.ts`)

| Table | Key columns |
|-------|-------------|
| `agent_registry` | `id` PK, `name`, `session_id`, `status` (active/idle/completed/failed), `current_task`, `worktree_branch`, `last_heartbeat`, `capabilities` |
| `agent_messages` | `channel`, `from_agent`, `to_agent`, `type` (request/response/notification/claim/release), `payload`, `priority`, `expires_at` |
| `work_announcements` | `agent_id` FK, `worktree_branch`, `intent_type` (editing/reviewing/refactoring/testing/documenting), `resource`, `files_affected`, `announced_at`, `completed_at` |
| `work_claims` | `resource`, `agent_id` FK, `claim_type` (exclusive/shared), `claimed_at`, `expires_at` |
| `deploy_queue` | `agent_id`, `action_type` (commit/push/merge/deploy/workflow), `target`, `status` (pending/batched/executing/completed/failed), `batch_id`, `priority`, `dependencies` |
| `deploy_batches` | `id` PK, `status` (pending/executing/completed/failed), `result`, timestamps |
| `pattern_outcomes` | `pattern_id`, `task_category`, `uses`, `successes`, PK(`pattern_id`,`task_category`) |
| `agent_pattern_outcomes` | `agent_id`, `pattern_id`, `task_category`, `uses`, `successes`, composite PK |

## Policies DB (`src/policies/database-manager.ts`)

| Table | Key columns |
|-------|-------------|
| `policies` | `id` PK, `name`, `category`, `level`, `rawMarkdown`, `convertedFormat`, `executableTools`, `tags`, `version`, `isActive`, `priority`, `enforcementStage` |
| `executable_tools` | `id` PK, `policyId` FK, `toolName`, `code`, `language` (default `python`) |
| `policy_executions` | `policyId` FK, `toolName`, `operation`, `args`, `result`, `allowed`, `reason`, `executedAt` |

## Short-Term Memory DB (`src/memory/short-term/schema.ts`)

| Table | Key columns |
|-------|-------------|
| `memories` | `id` PK, `timestamp`, `type` (action/observation/thought/goal/lesson/decision), `content`, `project_id` (default `default`), `importance` (default 5) |
| `memories_fts` | FTS5 virtual table mirroring `memories` (synced by triggers) |
| `session_memories` | `session_id`, `timestamp`, `type`, `content`, `importance` |
| `session_memories_fts` | FTS5 virtual table mirroring `session_memories` |
| `entities` | `type`, `name`, `description`, `mention_count`, `UNIQUE(type,name)` |
| `relationships` | `source_id` FK, `target_id` FK, `relation`, `strength`, `UNIQUE(source_id,target_id,relation)` |
| `daily_log` | `date`, `content`, `type`, `promoted`, `promoted_to`, `gate_score` (created by `daily-log.ts`) |
| `superseded_entries` | `tier`, `original_entry_id`, `original_content`, `corrected_content`, `reason` (created by `correction-propagator.ts`) |

## Other memory / analytics DBs

| DB / table | Key columns |
|------------|-------------|
| `hierarchical_memory` (`hierarchical-memory.ts`) | `id` PK, `tier` (hot/warm/cold), `content`, `compressed`, `type`, `importance`, `access_count`, `embedding` BLOB |
| `task_outcomes` (`analytics.ts`) | `modelId`, `taskType`, `complexity`, `success`, `durationMs`, `tokensIn`, `tokensOut`, `cost`, `taskId` |
| `fingerprint_updates` (`model-router.ts`) | `model_id` PK, `avg_latency_ms`, `success_rate`, `updated_at` |
| `category_stats` (`model-router.ts`) | `model_id`, `category`, `attempts`, `successes`, PK(`model_id`,`category`) |
| `historical_data` (`adaptive-context.ts`) | `task_type` PK, `total_attempts`, `uam_successes`, `no_uam_successes`, avg times |
| `semantic_cache` (`adaptive-context.ts`) | `cache_key` PK, `instruction_hash`, `decision_json`, `success_rate`, `use_count` |
| `predictive_queries` / `predictive_history` (`predictive-memory.ts`) | `keyword` PK / `description`, `queries` |
| `time_series` / `session_history` (`data-service.ts`) | telemetry JSON / per-session tokens, cost, tool_calls, policy_checks, policy_blocks |

## Qdrant collections

Qdrant runs as a local Docker container (`qdrant/qdrant:latest`, container
`uap-qdrant`, port 6333) or against a cloud endpoint (`QDRANT_URL` /
`QDRANT_API_KEY`). Client is `@qdrant/js-client-rest`, lazy-loaded.

| Collection | Purpose | Embedding model | Vector dim / distance |
|------------|---------|-----------------|-----------------------|
| `agent_memory` | Long-term semantic memory (L3) | `all-MiniLM-L6-v2` (config) / nomic-embed-text (runtime) | 384 (compliance/MiniLM path) or 768 (cloud/nomic); Cosine |
| `agent_patterns` | Pattern RAG retrieval | `all-MiniLM-L6-v2` | 384; Cosine |

> **Dimension nuance (load-bearing).** The pattern indexer
> (`agents/scripts/index_patterns_to_qdrant.py`) and the compliance auto-fix
> (`src/cli/compliance.ts`) create collections at 384 dims. The TypeScript
> Qdrant Cloud backend (`src/memory/backends/qdrant-cloud.ts`) defaults
> `vectorSize` to 768 and, on dimension mismatch, creates a suffixed collection
> `${collection}_v${vectorSize}`. Collection names are configurable
> (`memory.longTerm.collection`, `memory.patternRag.collection`) and may be
> suffixed with a project id by `sanitizeCollectionName`. Distance is always
> Cosine.
