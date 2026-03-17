# DeployBatcher Feature Analysis

> Comprehensive analysis of the `DeployBatcher` class - a multi-agent deployment optimization system designed to reduce CI/CD pipeline minutes through intelligent batching, squashing, and parallel execution.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Type System](#type-system)
4. [Class Diagram](#class-diagram)
5. [Core Features](#core-features)
6. [Data Flow](#data-flow)
7. [State Management](#state-management)
8. [CI/CD Optimization Strategies](#cicd-optimization-strategies)
9. [CLI Integration](#cli-integration)
10. [Usage Examples](#usage-examples)
11. [Performance Characteristics](#performance-characteristics)

---

## Overview

The `DeployBatcher` is a SQLite-backed deployment coordination system that optimizes CI/CD pipeline usage in multi-agent environments. It addresses a critical problem: when multiple AI agents work in parallel, they can trigger redundant CI/CD runs, consuming expensive pipeline minutes.

### Key Problem Solved

```
Without DeployBatcher:
  Agent A commits → CI Run 1 (5 min)
  Agent B commits → CI Run 2 (5 min)  
  Agent C commits → CI Run 3 (5 min)
  Agent A pushes → CI Run 4 (5 min)
  Total: 4 runs × 5 min = 20 CI minutes

With DeployBatcher:
  Agent A, B, C queue commits → Batched → Single squashed commit
  Single push → CI Run 1 (5 min)
  Total: 1 run × 5 min = 5 CI minutes (75% reduction)
```

---

## Architecture

```mermaid
graph TB
    subgraph "Multi-Agent Environment"
        A1[Agent 1]
        A2[Agent 2]
        A3[Agent N]
    end

    subgraph "DeployBatcher Core"
        Q[Queue Layer]
        B[Batch Creator]
        S[Squash Engine]
        E[Executor]
    end

    subgraph "Storage"
        DB[(SQLite DB)]
        DQ[deploy_queue]
        DBT[deploy_batches]
    end

    subgraph "Execution Targets"
        GIT[Git Operations]
        GH[GitHub CLI]
        DEPLOY[Deploy Scripts]
    end

    A1 --> Q
    A2 --> Q
    A3 --> Q
    
    Q --> DB
    DB --> DQ
    DB --> DBT
    
    Q --> B
    B --> S
    S --> E
    
    E --> GIT
    E --> GH
    E --> DEPLOY

    style Q fill:#e1f5fe
    style B fill:#fff3e0
    style S fill:#f3e5f5
    style E fill:#e8f5e9
```

---

## Type System

### Core Types (from `types/coordination.ts`)

```typescript
// Action types that can be batched
type DeployActionType = 'commit' | 'push' | 'merge' | 'deploy' | 'workflow';

// Status lifecycle
type DeployStatus = 'pending' | 'batched' | 'executing' | 'completed' | 'failed';

// Single deploy action
interface DeployAction {
  id: number;
  agentId: string;
  actionType: DeployActionType;
  target: string;
  payload?: Record<string, unknown>;
  status: DeployStatus;
  batchId?: string;
  queuedAt: string;
  executeAfter?: string;
  priority: number;
  dependencies?: string[];
}

// Grouped batch
interface DeployBatch {
  id: string;           // UUID
  actions: DeployAction[];
  createdAt: string;
  status: DeployStatus;
}

// Execution result
interface BatchResult {
  batchId: string;
  success: boolean;
  executedActions: number;
  failedActions: number;
  errors?: string[];
  duration: number;     // milliseconds
}
```

### Configuration Interfaces

```typescript
// Dynamic window configuration (per action type)
interface DynamicBatchWindows {
  commit: number;    // Default: 30000ms (30s)
  push: number;      // Default: 5000ms (5s)
  merge: number;     // Default: 10000ms (10s)
  workflow: number;  // Default: 5000ms (5s)
  deploy: number;    // Default: 60000ms (60s)
}

// Batcher configuration
interface DeployBatcherConfig {
  dbPath?: string;
  batchWindowMs?: number;           // Legacy single window
  dynamicWindows?: Partial<DynamicBatchWindows>;
  maxBatchSize?: number;            // Default: 20
  dryRun?: boolean;
  parallelExecution?: boolean;      // Default: true
  maxParallelActions?: number;      // Default: 5
}
```

---

## Class Diagram

```mermaid
classDiagram
    class DeployBatcher {
        -db: Database
        -dynamicWindows: DynamicBatchWindows
        -maxBatchSize: number
        -dryRun: boolean
        -parallelExecution: boolean
        -maxParallelActions: number
        
        +constructor(config?: DeployBatcherConfig)
        +getBatchWindow(actionType): number
        +setUrgentMode(urgent: boolean): void
        +queue(agentId, actionType, target, payload?, options?): Promise~number~
        +queueBulk(agentId, actions): Promise~number[]~
        +createBatch(): Promise~DeployBatch|null~
        +executeBatch(batchId): Promise~BatchResult~
        +getBatch(batchId): DeployBatch|null
        +getPendingBatches(): DeployBatch[]
        +flushAll(): Promise~BatchResult[]~
        +getWindowConfig(): DynamicBatchWindows
        
        -queueSync(agentId, actionType, target, payload?, options?): number
        -findSimilarAction(actionType, target): DeployAction|null
        -canMerge(existing, incoming): boolean
        -mergeActions(existingId, newPayload?): Promise~void~
        -mergePayloads(existing, incoming): Record
        -groupByTarget(actions): Map
        -squashActions(grouped): DeployAction[]
        -squashCommits(commits): DeployAction
        -categorizeActions(actions): {sequential, parallel}
        -executeParallel(actions): Promise~Array~
        -executeAction(action): Promise~void~
        -executeCommit(target, payload): Promise~void~
        -executePush(target, payload): Promise~void~
        -executeMerge(target, payload): Promise~void~
        -executeWorkflow(target, payload): Promise~void~
        -executeDeploy(target, payload): Promise~void~
        -updateActionStatus(actionId, status): void
    }

    class CoordinationDatabase {
        -db: Database
        -instance: CoordinationDatabase$
        
        +getInstance(dbPath): CoordinationDatabase$
        +resetInstance(): void$
        +getDatabase(): Database
        +close(): void
        -initSchema(): void
    }

    class DeployAction {
        <<interface>>
        +id: number
        +agentId: string
        +actionType: DeployActionType
        +target: string
        +payload?: Record
        +status: DeployStatus
        +batchId?: string
        +queuedAt: string
        +executeAfter?: string
        +priority: number
        +dependencies?: string[]
    }

    class DeployBatch {
        <<interface>>
        +id: string
        +actions: DeployAction[]
        +createdAt: string
        +status: DeployStatus
    }

    class BatchResult {
        <<interface>>
        +batchId: string
        +success: boolean
        +executedActions: number
        +failedActions: number
        +errors?: string[]
        +duration: number
    }

    class DynamicBatchWindows {
        <<interface>>
        +commit: number
        +push: number
        +merge: number
        +workflow: number
        +deploy: number
    }

    DeployBatcher --> CoordinationDatabase : uses
    DeployBatcher --> DeployAction : manages
    DeployBatcher --> DeployBatch : creates
    DeployBatcher --> BatchResult : returns
    DeployBatcher --> DynamicBatchWindows : configures
    DeployBatch --> DeployAction : contains
```

---

## Core Features

### 1. Dynamic Batch Windows

Different action types have different time-sensitivity requirements:

| Action Type | Window | Rationale |
|-------------|--------|-----------|
| `push` | 5s | PRs need fast feedback |
| `workflow` | 5s | CI triggers should be responsive |
| `merge` | 10s | Moderate safety buffer |
| `commit` | 30s | Allows squashing multiple commits |
| `deploy` | 60s | Safety buffer for production |

```mermaid
gantt
    title Batch Window Timeline
    dateFormat X
    axisFormat %s

    section Push Actions
    Window (5s)     :0, 5

    section Workflow Actions
    Window (5s)     :0, 5

    section Merge Actions
    Window (10s)    :0, 10

    section Commit Actions
    Window (30s)    :0, 30

    section Deploy Actions
    Window (60s)    :0, 60
```

### 2. Action Merging & Deduplication

The batcher intelligently merges similar pending actions:

```mermaid
flowchart LR
    subgraph "Incoming Actions"
        C1[Commit: file1.ts]
        C2[Commit: file2.ts]
        C3[Commit: file3.ts]
        P1[Push: main]
        P2[Push: main]
        W1[Workflow: test.yml]
        W2[Workflow: test.yml]
    end

    subgraph "Merge Logic"
        MC[canMerge]
        MP[mergePayloads]
    end

    subgraph "Result"
        SC[Squashed Commit:\nfile1, file2, file3]
        SP[Single Push: main]
        SW[Single Workflow: test.yml]
    end

    C1 --> MC
    C2 --> MC
    C3 --> MC
    MC --> MP
    MP --> SC

    P1 --> MC
    P2 --> MC
    MC --> SP

    W1 --> MC
    W2 --> MC
    MC --> SW
```

### 3. Commit Squashing

Multiple commits to the same target are squashed into one:

```typescript
// Input: 3 separate commits
[
  { message: "fix: typo in auth", files: ["src/auth.ts"] },
  { message: "feat: add logging", files: ["src/logger.ts"] },
  { message: "test: add auth tests", files: ["test/auth.test.ts"] }
]

// Output: Single squashed commit
{
  message: "Squashed 3 commits:\n\n1. fix: typo in auth\n2. feat: add logging\n3. test: add auth tests",
  files: ["src/auth.ts", "src/logger.ts", "test/auth.test.ts"],
  squashedFrom: [1, 2, 3]
}
```

### 4. Parallel Execution

Actions are categorized for parallel vs sequential execution:

```mermaid
flowchart TB
    subgraph "Action Pool"
        A1[Commit]
        A2[Push]
        A3[Workflow 1]
        A4[Workflow 2]
        A5[Workflow 3]
        A6[Deploy]
    end

    subgraph "Categorization"
        CAT{categorizeActions}
    end

    subgraph "Sequential Queue"
        S1[Commit]
        S2[Push]
        S3[Deploy]
    end

    subgraph "Parallel Pool"
        P1[Workflow 1]
        P2[Workflow 2]
        P3[Workflow 3]
    end

    A1 --> CAT
    A2 --> CAT
    A3 --> CAT
    A4 --> CAT
    A5 --> CAT
    A6 --> CAT

    CAT --> S1
    CAT --> S2
    CAT --> S3
    CAT --> P1
    CAT --> P2
    CAT --> P3

    S1 --> |"order matters"| S2
    S2 --> S3

    P1 --> |"concurrent"| DONE[Complete]
    P2 --> |"concurrent"| DONE
    P3 --> |"concurrent"| DONE
```

**Parallel-safe types**: `workflow` (no state dependencies)  
**Sequential types**: `commit`, `push`, `merge`, `deploy` (state-dependent)

### 5. Urgent Mode

For time-critical operations, urgent mode reduces all windows:

```typescript
// Normal mode
{ commit: 30000, push: 5000, merge: 10000, workflow: 5000, deploy: 60000 }

// Urgent mode
{ commit: 2000, push: 1000, merge: 2000, workflow: 1000, deploy: 5000 }
```

---

## Data Flow

### Queue → Batch → Execute Flow

```mermaid
sequenceDiagram
    participant A1 as Agent 1
    participant A2 as Agent 2
    participant Q as queue()
    participant DB as SQLite
    participant CB as createBatch()
    participant EB as executeBatch()
    participant GIT as Git/GitHub

    Note over A1,A2: Multiple agents queue actions

    A1->>Q: queue(commit, main, {files})
    Q->>DB: INSERT INTO deploy_queue
    Q-->>A1: action_id: 1

    A2->>Q: queue(commit, main, {files})
    Q->>DB: findSimilarAction()
    DB-->>Q: existing action found
    Q->>DB: mergeActions()
    Q-->>A2: action_id: 1 (merged)

    A1->>Q: queue(push, main)
    Q->>DB: INSERT INTO deploy_queue
    Q-->>A1: action_id: 2

    Note over CB: Time window expires

    rect rgb(255, 243, 224)
        CB->>DB: SELECT pending WHERE execute_after <= now
        DB-->>CB: [action 1, action 2]
        CB->>CB: groupByTarget()
        CB->>CB: squashActions()
        CB->>DB: UPDATE status='batched', INSERT batch
        CB-->>EB: DeployBatch
    end

    rect rgb(232, 245, 233)
        EB->>EB: categorizeActions()
        EB->>DB: UPDATE status='executing'
        
        par Parallel Execution
            EB->>GIT: executeAction(workflow)
        and
            EB->>GIT: executeAction(workflow)
        end
        
        loop Sequential Execution
            EB->>GIT: executeCommit()
            EB->>GIT: executePush()
        end
        
        EB->>DB: UPDATE status='completed'
        EB-->>A1: BatchResult
    end
```

---

## State Management

### Action Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: queue()
    
    pending --> pending: mergeActions()
    pending --> batched: createBatch()
    
    batched --> executing: executeBatch()
    
    executing --> completed: success
    executing --> failed: error
    
    completed --> [*]
    failed --> [*]

    note right of pending
        Actions wait in queue
        until executeAfter time
    end note

    note right of batched
        Actions grouped into
        batch, ready for execution
    end note

    note right of executing
        Parallel/sequential
        execution in progress
    end note
```

### Batch Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: createBatch()
    
    pending --> executing: executeBatch() starts
    
    executing --> completed: all actions succeed
    executing --> completed: partial success (some failed)
    executing --> failed: all actions failed
    
    completed --> [*]
    failed --> [*]
```

---

## CI/CD Optimization Strategies

### Strategy 1: Commit Squashing

**Problem**: N commits = N CI runs  
**Solution**: Squash commits within window into single commit

```mermaid
flowchart LR
    subgraph "Without Squashing"
        C1A[Commit 1] --> CI1[CI Run 1]
        C2A[Commit 2] --> CI2[CI Run 2]
        C3A[Commit 3] --> CI3[CI Run 3]
    end

    subgraph "With Squashing"
        C1B[Commit 1] --> SQ[Squash]
        C2B[Commit 2] --> SQ
        C3B[Commit 3] --> SQ
        SQ --> CIS[CI Run 1]
    end

    style CI1 fill:#ffcdd2
    style CI2 fill:#ffcdd2
    style CI3 fill:#ffcdd2
    style CIS fill:#c8e6c9
```

**Savings**: ~67% reduction (3 runs → 1 run)

### Strategy 2: Push Deduplication

**Problem**: Multiple agents push to same branch  
**Solution**: Merge push requests, execute once

```mermaid
flowchart LR
    subgraph "Without Dedup"
        P1A[Push Agent 1] --> CI1[CI Run 1]
        P2A[Push Agent 2] --> CI2[CI Run 2]
    end

    subgraph "With Dedup"
        P1B[Push Agent 1] --> MERGE[Merge]
        P2B[Push Agent 2] --> MERGE
        MERGE --> CIS[CI Run 1]
    end

    style CI1 fill:#ffcdd2
    style CI2 fill:#ffcdd2
    style CIS fill:#c8e6c9
```

### Strategy 3: Workflow Trigger Batching

**Problem**: Redundant workflow dispatches  
**Solution**: Deduplicate identical workflow triggers

### Strategy 4: Time-Window Batching

**Problem**: Rapid-fire actions trigger multiple pipelines  
**Solution**: Delay execution to collect related actions

```mermaid
gantt
    title Action Batching Timeline
    dateFormat X
    axisFormat %s

    section Without Batching
    Action 1    :a1, 0, 1
    CI Run 1    :crit, ci1, 1, 6
    Action 2    :a2, 3, 1
    CI Run 2    :crit, ci2, 4, 9
    Action 3    :a3, 5, 1
    CI Run 3    :crit, ci3, 6, 11

    section With Batching (30s window)
    Action 1    :a1b, 0, 1
    Action 2    :a2b, 3, 1
    Action 3    :a3b, 5, 1
    Window      :active, w, 0, 30
    Batch CI    :done, bci, 30, 35
```

---

## CLI Integration

The `DeployBatcher` is exposed through the CLI:

```bash
# Queue a commit
uam deploy queue --agent-id <id> --action-type commit --target main \
  --message "feat: new feature" --files "src/feature.ts"

# Queue a push
uam deploy queue --agent-id <id> --action-type push --target main

# Queue a workflow trigger
uam deploy queue --agent-id <id> --action-type workflow --target test.yml \
  --ref main --inputs '{"env":"staging"}'

# View status
uam deploy status

# Create batch manually
uam deploy batch

# Execute specific batch
uam deploy execute --batch-id <uuid>

# Flush all pending
uam deploy flush
```

### CLI Command Flow

```mermaid
flowchart TB
    subgraph "CLI Commands"
        QC[uam deploy queue]
        BC[uam deploy batch]
        EC[uam deploy execute]
        SC[uam deploy status]
        FC[uam deploy flush]
    end

    subgraph "DeployBatcher Methods"
        Q[queue]
        CB[createBatch]
        EB[executeBatch]
        GB[getBatch/getPendingBatches]
        FA[flushAll]
    end

    QC --> Q
    BC --> CB
    EC --> EB
    SC --> GB
    FC --> FA
```

---

## Usage Examples

### Example 1: Multi-Agent Commit Batching

```typescript
import { DeployBatcher } from './coordination/deploy-batcher.js';

const batcher = new DeployBatcher({
  dynamicWindows: { commit: 30000 },  // 30s window
  parallelExecution: true,
});

// Agent 1 commits
await batcher.queue('agent-1', 'commit', 'main', {
  message: 'feat: add user auth',
  files: ['src/auth.ts', 'src/user.ts']
});

// Agent 2 commits (within window - will be merged)
await batcher.queue('agent-2', 'commit', 'main', {
  message: 'feat: add logging',
  files: ['src/logger.ts']
});

// After 30s, create and execute batch
const batch = await batcher.createBatch();
const result = await batcher.executeBatch(batch.id);

console.log(result);
// {
//   batchId: 'uuid',
//   success: true,
//   executedActions: 1,  // Squashed into single commit
//   failedActions: 0,
//   duration: 1234
// }
```

### Example 2: Urgent Deployment

```typescript
const batcher = new DeployBatcher();

// Enable urgent mode for critical fix
batcher.setUrgentMode(true);

// Queue with minimal delay
await batcher.queue('agent-1', 'commit', 'main', {
  message: 'hotfix: critical security patch',
  files: ['src/security.ts']
}, { urgent: true });

await batcher.queue('agent-1', 'push', 'main', {}, { urgent: true });

// Immediately flush
const results = await batcher.flushAll();

// Restore normal mode
batcher.setUrgentMode(false);
```

### Example 3: Bulk Queue with Transaction

```typescript
const batcher = new DeployBatcher();

// Queue multiple actions atomically
const ids = await batcher.queueBulk('agent-1', [
  { actionType: 'commit', target: 'main', payload: { message: 'feat: A' } },
  { actionType: 'commit', target: 'main', payload: { message: 'feat: B' } },
  { actionType: 'push', target: 'main' },
  { actionType: 'workflow', target: 'deploy.yml', payload: { ref: 'main' } },
]);

console.log(`Queued ${ids.length} actions`);
```

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `queue()` | O(1) | Single INSERT |
| `queueBulk()` | O(n) | Transaction with n INSERTs |
| `createBatch()` | O(n log n) | SELECT + grouping + squashing |
| `executeBatch()` | O(n) sequential, O(n/p) parallel | p = maxParallelActions |
| `flushAll()` | O(b × n) | b batches, n actions each |

### Space Complexity

| Storage | Size |
|---------|------|
| Per action | ~500 bytes (JSON payload) |
| Per batch | ~100 bytes + action references |
| SQLite overhead | ~4KB per page |

### Recommended Limits

| Parameter | Default | Max Recommended |
|-----------|---------|-----------------|
| `maxBatchSize` | 20 | 100 |
| `maxParallelActions` | 5 | 10 |
| Queue depth | - | 1000 actions |

---

## Database Schema

```mermaid
erDiagram
    deploy_queue {
        INTEGER id PK
        TEXT agent_id
        TEXT action_type
        TEXT target
        TEXT payload
        TEXT status
        TEXT batch_id FK
        TEXT queued_at
        TEXT execute_after
        INTEGER priority
        TEXT dependencies
    }

    deploy_batches {
        TEXT id PK
        TEXT created_at
        TEXT executed_at
        TEXT status
        TEXT result
    }

    deploy_queue }o--|| deploy_batches : "belongs to"
```

---

## Summary

The `DeployBatcher` provides a comprehensive solution for optimizing CI/CD pipeline usage in multi-agent environments:

| Feature | Benefit |
|---------|---------|
| Dynamic batch windows | Balances speed vs batching per action type |
| Commit squashing | Reduces N commits to 1 CI run |
| Action merging | Deduplicates redundant operations |
| Parallel execution | Faster batch completion |
| Urgent mode | Fast path for critical operations |
| SQLite persistence | Survives agent restarts |
| CLI integration | Easy manual control |

**Typical CI/CD savings**: 50-80% reduction in pipeline minutes for multi-agent workflows.
