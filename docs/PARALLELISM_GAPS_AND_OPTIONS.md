# Parallelism & Dependency Notification: Gaps and Options

**Generated:** 2026-03-17

---

## Current State

### What exists (DO NOT REBUILD)

| Component                    | File                                                                            | What it does                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Executor parallel batching   | `src/models/executor.ts:54-162`                                                 | `Promise.all` batches capped by `maxParallel` (default 3), topological level grouping                          |
| Deploy batcher parallelism   | `src/coordination/deploy-batcher.ts:34-591`                                     | Categorizes actions as parallel-safe vs sequential, `Promise.allSettled` with `maxParallelActions` (default 5) |
| Benchmark model parallelism  | `src/benchmarks/model-integration.ts:911-944` + `improved-benchmark.ts:565-603` | Queue-based concurrency pool, `parallelModels` param (default 1)                                               |
| Planner topological sort     | `src/models/planner.ts:379-413`                                                 | Returns `string[][]` dependency levels for parallel execution                                                  |
| Task dependency DAG          | `src/tasks/database.ts:71-84` + `service.ts:438-538`                            | `task_dependencies` table, add/remove deps, cycle detection (BFS), blocked/ready queries                       |
| Task coordination scoring    | `src/tasks/coordination.ts:260-298`                                             | Scores tasks: +5 no deps, +3 per task it unblocks                                                              |
| Pub/sub messaging            | `src/coordination/service.ts:608-642`                                           | SQLite-backed broadcast/send/receive on channels                                                               |
| Config schema (unused)       | `src/types/config.ts:223-229`                                                   | `maxParallelDroids` (4), `maxParallelWorkflows` (3) -- declared but never consumed                             |
| VRAM detection               | `src/bin/llama-server-optimize.ts:301-331`                                      | nvidia-smi / sysctl, not reusable (private to llama-server)                                                    |
| CPU detection                | `src/bin/llama-server-optimize.ts:614`                                          | `os.cpus().length - 2`, not reusable (inline in llama-server)                                                  |
| Harbor N_CONCURRENT          | Shell scripts                                                                   | `N_CONCURRENT` env var (default 4) for Harbor `-n` flag                                                        |
| Python parallel tool calls   | `tools/agents/scripts/qwen_tool_call_wrapper.py`                                | `parallel_tool_calls: True` in every API request                                                               |
| Unbounded memory parallelism | `src/memory/predictive-memory.ts:94-104` + `embeddings.ts:228-230`              | `Promise.all` with no concurrency limit                                                                        |

### What's broken or missing

| Gap                                                | Location                                                       | Impact                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **No env var override for TypeScript parallelism** | `executor.ts`, `improved-benchmark.ts`, `model-integration.ts` | Cannot tune parallelism without code changes                                |
| **No vCPU/resource detection shared utility**      | `llama-server-optimize.ts` has it but private                  | Every module hardcodes defaults                                             |
| **Config schema not wired**                        | `config.ts:223-229`                                            | `maxParallelDroids`/`maxParallelWorkflows` declared but never read          |
| **No dependency completion notification**          | `service.ts:287-302`                                           | `close()` marks task done but does NOT notify blocked dependents            |
| **No auto-unblock on completion**                  | `coordination.ts:155-200`                                      | `release()` broadcasts generic message, doesn't check newly-unblocked tasks |
| **Unbounded memory concurrency**                   | `predictive-memory.ts`, `embeddings.ts`                        | `Promise.all` on all items, can overwhelm local inference                   |
| **Benchmark parallelism defaults to 1**            | `improved-benchmark.ts:632`, `model-integration.ts`            | Sequential by default, no auto-detection                                    |

---

## Option A: Minimal -- Env Overrides + Wire Config (Recommended)

**Effort:** ~2 hours | **Risk:** Low | **Impact:** High

No new abstractions. Add env var reads to existing code, wire the existing config schema, and add notification to `close()`.

### A1. Shared resource detection utility

**New file:** `src/utils/system-resources.ts`

Extract and generalize the detection logic already in `llama-server-optimize.ts`:

```typescript
import { cpus } from 'os';
import { execSync } from 'child_process';

export interface SystemResources {
  vCPUs: number;
  vramGB: number;
  memoryGB: number;
}

let _cached: SystemResources | null = null;

export function detectSystemResources(): SystemResources {
  if (_cached) return _cached;

  const vCPUs = cpus().length;

  let vramGB = 0;
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    vramGB = Math.round(parseInt(out.trim().split('\n')[0]) / 1024);
  } catch {
    try {
      const out = execSync('sysctl -n hw.memsize', { encoding: 'utf-8' });
      vramGB = Math.min(Math.round(parseInt(out.trim()) / 1024 ** 3), 48);
    } catch {
      vramGB = 0;
    }
  }

  const memoryGB = Math.round(require('os').totalmem() / 1024 ** 3);

  _cached = { vCPUs, vramGB, memoryGB };
  return _cached;
}

/**
 * Compute safe parallelism ceiling.
 * For CPU-bound: vCPUs - 2 (reserve for OS + inference).
 * For IO-bound (API calls): min(vCPUs, 8).
 * Env override: UAP_MAX_PARALLEL always wins.
 */
export function getMaxParallel(mode: 'cpu' | 'io' = 'io'): number {
  const envOverride = process.env.UAP_MAX_PARALLEL;
  if (envOverride) return Math.max(1, parseInt(envOverride, 10) || 1);

  const { vCPUs } = detectSystemResources();

  if (mode === 'cpu') {
    return Math.max(1, vCPUs - 2);
  }
  return Math.min(vCPUs, 8);
}
```

### A2. Env var overrides in existing code

**File: `src/models/executor.ts:58-65`** -- read env vars into defaults:

```typescript
const DEFAULT_OPTIONS: ExecutorOptions = {
  maxRetries: 2,
  retryDelayMs: 1000,
  stepTimeout: 120000,
  enableFallback: true,
  parallelExecution: process.env.UAP_PARALLEL !== 'false',
  maxParallel: parseInt(process.env.UAP_MAX_PARALLEL || '', 10) || 3,
};
```

**File: `src/benchmarks/improved-benchmark.ts:632`** -- auto-detect:

```typescript
const parallelModels =
  (options.parallelModels ?? parseInt(process.env.UAP_BENCHMARK_PARALLEL || '', 10)) ||
  getMaxParallel('io');
```

**File: `src/benchmarks/model-integration.ts`** -- same pattern.

**File: `src/coordination/deploy-batcher.ts:78-79`** -- same pattern:

```typescript
parallelExecution: process.env.UAP_PARALLEL !== 'false',
maxParallelActions: parseInt(process.env.UAP_MAX_PARALLEL || '', 10) || 5,
```

### A3. Wire existing config schema

**File: `src/types/config.ts:223-229`** -- already declares `maxParallelDroids` and `maxParallelWorkflows`.

Wire into executor by reading config at startup:

```typescript
// In executor.ts constructor or factory
const uapConfig = loadUAPConfig(); // existing config loader
if (uapConfig?.parallelExecution) {
  this.options.parallelExecution = uapConfig.parallelExecution.enabled;
  this.options.maxParallel = uapConfig.parallelExecution.maxParallelDroids;
}
```

### A4. Dependency completion notification

**File: `src/tasks/service.ts:287-302`** -- add unblock notification to `close()`:

```typescript
close(id: string, reason?: string): Task | null {
  const task = this.get(id);
  if (!task) return null;

  const now = new Date().toISOString();
  const stmt = this.db.prepare(`
    UPDATE tasks SET status = 'done', closed_at = ?, closed_reason = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(now, reason || null, now, id);

  this.recordHistory(id, 'status', task.status, 'done');
  this.recordActivity(id, 'closed', reason || 'Task completed');

  // --- NEW: Notify newly-unblocked dependents ---
  this.notifyUnblockedDependents(id);

  return this.get(id);
}

private notifyUnblockedDependents(completedTaskId: string): void {
  // Find tasks that were blocked by this task
  const dependents = this.db.prepare(`
    SELECT from_task FROM task_dependencies
    WHERE to_task = ? AND dep_type = 'blocks'
  `).all(completedTaskId) as Array<{ from_task: string }>;

  for (const dep of dependents) {
    const dependent = this.getWithRelations(dep.from_task);
    if (dependent && dependent.isReady) {
      // Task is now unblocked -- record activity
      this.recordActivity(dep.from_task, 'unblocked',
        `Unblocked: dependency "${completedTaskId}" completed`);

      // If task was in 'blocked' status, move to 'open'
      const raw = this.get(dep.from_task);
      if (raw && raw.status === 'blocked') {
        this.db.prepare(`UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), dep.from_task);
        this.recordHistory(dep.from_task, 'status', 'blocked', 'open');
      }
    }
  }
}
```

**File: `src/tasks/coordination.ts:155-200`** -- enhance `release()` to return unblocked tasks:

```typescript
async release(taskId: string, reason?: string): Promise<ReleaseResult | null> {
  // ... existing code ...

  // Broadcast task completion
  this.coordService.broadcast(this.agentId, 'coordination', {
    action: 'task_completed',
    resource: taskId,
    data: {
      title: task.title,
      reason,
    },
  });

  // --- NEW: Find and broadcast newly-unblocked tasks ---
  const nowReady = this.taskService.ready().filter(t =>
    t.blockedBy.length === 0 // was previously blocked, now free
  );

  if (nowReady.length > 0) {
    this.coordService.broadcast(this.agentId, 'coordination', {
      action: 'tasks_unblocked',
      resource: taskId,
      data: {
        unblockedTasks: nowReady.map(t => ({ id: t.id, title: t.title })),
        count: nowReady.length,
      },
    });
  }

  // ... rest of existing code ...

  return {
    task: closedTask,
    completedAnnouncements: 1,
    unblockedTasks: nowReady.map(t => t.id),  // NEW field
  };
}
```

### A5. Cap unbounded memory concurrency

**File: `src/memory/predictive-memory.ts:94-104`**:

```typescript
// Before (unbounded):
const results = await Promise.all(predictions.map((p) => this.query(p)));

// After (capped):
import { getMaxParallel } from '../utils/system-resources.js';

const maxConcurrent = getMaxParallel('io');
const results: MemoryEntry[][] = [];
for (let i = 0; i < predictions.length; i += maxConcurrent) {
  const batch = predictions.slice(i, i + maxConcurrent);
  const batchResults = await Promise.all(batch.map((p) => this.query(p)));
  results.push(...batchResults);
}
```

### Env Variable Summary

| Variable                 | Default                  | Scope                              | Override                           |
| ------------------------ | ------------------------ | ---------------------------------- | ---------------------------------- |
| `UAP_PARALLEL`           | `true`                   | Global on/off                      | `false` to disable all parallelism |
| `UAP_MAX_PARALLEL`       | auto-detected from vCPUs | Global concurrency cap             | Any integer                        |
| `UAP_BENCHMARK_PARALLEL` | auto-detected            | Benchmark model concurrency        | Any integer                        |
| `N_CONCURRENT`           | `4`                      | Harbor task concurrency (existing) | Any integer                        |

### Precedence

```
UAP_MAX_PARALLEL env var
  → uap.config parallelExecution.maxParallelDroids
    → auto-detected from os.cpus().length
      → hardcoded default (3)
```

---

## Option B: Concurrency Pool Utility

**Effort:** ~4 hours | **Risk:** Low | **Impact:** Medium

Everything in Option A, plus a shared concurrency pool to replace the duplicated `Promise.all` batching pattern across 5+ files.

### B1. Shared concurrency pool

**New file:** `src/utils/concurrency-pool.ts`

```typescript
import { getMaxParallel } from './system-resources.js';

export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: { maxConcurrent?: number; mode?: 'cpu' | 'io' }
): Promise<R[]> {
  const max = options?.maxConcurrent ?? getMaxParallel(options?.mode ?? 'io');
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  };

  const workers = Array.from({ length: Math.min(max, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

### B2. Replace duplicated patterns

| File                            | Current                                | Replace with                                                |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `executor.ts:149-153`           | Manual `Promise.all` batch loop        | `concurrentMap(batch, taskId => this.executeSubtask(...))`  |
| `deploy-batcher.ts:582-591`     | Manual `Promise.allSettled` chunk loop | `concurrentMap(actions, action => this.executeAction(...))` |
| `improved-benchmark.ts:565-603` | Queue-based pool                       | `concurrentMap(models, model => runBenchmarkForModel(...))` |
| `model-integration.ts:911-944`  | Queue-based pool                       | `concurrentMap(models, model => runBenchmarkForModel(...))` |
| `predictive-memory.ts:94-104`   | Unbounded `Promise.all`                | `concurrentMap(predictions, p => this.query(p))`            |
| `embeddings.ts:228-230`         | Unbounded `Promise.all`                | `concurrentMap(texts, t => this.embed(t))`                  |

---

## Option C: Full Event-Driven Dependency Resolution

**Effort:** ~8 hours | **Risk:** Medium | **Impact:** High

Everything in Options A+B, plus an event-driven system where task completion automatically triggers dependent task execution.

### C1. TaskEventBus

**New file:** `src/tasks/event-bus.ts`

```typescript
type TaskEvent =
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_unblocked'; taskId: string; unblockedBy: string }
  | { type: 'task_failed'; taskId: string; error: string };

type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;

export class TaskEventBus {
  private handlers: Map<TaskEvent['type'], TaskEventHandler[]> = new Map();

  on(type: TaskEvent['type'], handler: TaskEventHandler): void {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async emit(event: TaskEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) || [];
    await Promise.all(handlers.map((h) => h(event)));
  }
}
```

### C2. Auto-execute unblocked tasks

Wire into `TaskCoordinator`:

```typescript
// In coordinator constructor
this.eventBus.on('task_unblocked', async (event) => {
  if (event.type !== 'task_unblocked') return;
  const task = this.taskService.getWithRelations(event.taskId);
  if (task && task.isReady && this.autoExecuteEnabled) {
    await this.claim(event.taskId);
  }
});
```

### C3. Executor emits completion events

Wire into `TaskExecutor.executePlan()`:

```typescript
// After subtask completes successfully
this.eventBus.emit({ type: 'task_completed', taskId: subtaskId });
```

---

## Recommendation

**Start with Option A** (env overrides + wire config + dependency notification). It addresses every gap with minimal code changes to existing files and no new abstractions. The concurrency pool (Option B) is a nice cleanup but not blocking. The event bus (Option C) is only needed if you want auto-execution of unblocked tasks.

| Option              | Effort   | Files changed | New files                                        | Risk   |
| ------------------- | -------- | ------------- | ------------------------------------------------ | ------ |
| **A (Recommended)** | ~2 hours | 6 existing    | 1 (`system-resources.ts`)                        | Low    |
| B                   | ~4 hours | 8 existing    | 2 (`system-resources.ts`, `concurrency-pool.ts`) | Low    |
| C                   | ~8 hours | 10 existing   | 3 (+ `event-bus.ts`)                             | Medium |

---

## Files to Change (Option A)

| File                                       | Change                                                   | Lines affected |
| ------------------------------------------ | -------------------------------------------------------- | -------------- |
| `src/utils/system-resources.ts`            | **NEW** -- vCPU/VRAM detection + `getMaxParallel()`      | ~45 lines      |
| `src/models/executor.ts:58-65`             | Read `UAP_PARALLEL`, `UAP_MAX_PARALLEL` env vars         | 2 lines        |
| `src/benchmarks/improved-benchmark.ts:632` | Read `UAP_BENCHMARK_PARALLEL`, fallback to auto-detect   | 3 lines        |
| `src/benchmarks/model-integration.ts`      | Same as above                                            | 3 lines        |
| `src/coordination/deploy-batcher.ts:78-79` | Read env vars                                            | 2 lines        |
| `src/tasks/service.ts:287-302`             | Add `notifyUnblockedDependents()` after `close()`        | ~25 lines      |
| `src/tasks/coordination.ts:155-200`        | Broadcast `tasks_unblocked` event, return unblocked list | ~15 lines      |
| `src/memory/predictive-memory.ts:94-104`   | Cap concurrency with `getMaxParallel()`                  | 5 lines        |
