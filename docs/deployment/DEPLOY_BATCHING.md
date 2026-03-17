# Deploy Batching & Bucketing System

## Overview

The UAP Deploy system provides intelligent action batching and execution for automated deployments. It uses **dynamic batch windows** to group related actions together, reducing unnecessary operations and improving efficiency.

## Key Features

### 1. Dynamic Batch Windows

Actions are queued with type-specific waiting periods before being batched together:

| Action Type | Default Window | Description                       |
| ----------- | -------------- | --------------------------------- |
| `commit`    | 30,000ms (30s) | Allows squashing multiple commits |
| `push`      | 5,000ms (5s)   | Fast for PR creation              |
| `merge`     | 10,000ms (10s) | Moderate safety buffer            |
| `workflow`  | 5,000ms (5s)   | Fast workflow triggers            |
| `deploy`    | 60,000ms (60s) | Safety buffer for deployments     |

### 2. Smart Deduplication

The system automatically detects and merges similar actions:

- Multiple commits to the same branch are squashed
- Multiple pushes to the same branch are merged
- Duplicate workflow triggers are deduplicated

### 3. Parallel Execution

Independent actions (like workflow triggers) can execute in parallel while maintaining order for dependent actions (commits → push → merge).

### 4. Urgent Mode

For time-critical operations, urgent mode reduces all batch windows to minimum values:

- commit: 2,000ms
- push: 1,000ms
- merge: 2,000ms
- workflow: 1,000ms
- deploy: 5,000ms

## CLI Commands

### View Current Configuration

```bash
uap deploy config
```

**Output:**

```
📋 Deploy Batch Configuration

Current batch window settings (ms):

  commit:   30000ms   (30s)
  push:     5000ms   (5s)
  merge:    10000ms   (10s)
  workflow: 5000ms   (5s)
  deploy:   60000ms   (60s)
```

### Set Custom Configuration

```bash
uap deploy set-config --message '{"commit":60000,"push":3000,"merge":15000}'
```

**Examples:**

```bash
# Set custom windows for all types
uap deploy set-config --message '{"commit":60000,"push":5000,"merge":10000,"workflow":5000,"deploy":120000}'

# Set only specific windows (others remain unchanged)
uap deploy set-config --message '{"commit":120000}'
```

### Enable/Disable Urgent Mode

```bash
# Enable urgent mode (fast execution)
uap deploy urgent --on

# Disable urgent mode (return to default windows)
uap deploy urgent --off
```

## Usage Examples

### Queue a Deploy Action

```bash
# Queue a commit action
uap deploy queue --agent-id my-agent --action-type commit --target main --message "Fix bug" --files src/file.ts

# Queue a push action
uap deploy queue --agent-id my-agent --action-type push --target main --remote origin --force

# Queue a merge action
uap deploy queue --agent-id my-agent --action-type merge --target main

# Queue a workflow trigger
uap deploy queue --agent-id my-agent --action-type workflow --target CI --ref main --inputs '{"deploy_env":"production"}'
```

### Create and Execute Batches

```bash
# Create a batch from pending actions
uap deploy batch

# Execute a specific batch
uap deploy execute --batch-id <batch-id>

# Execute all pending batches
uap deploy flush
```

### Check Status

```bash
# View queue status
uap deploy status

# View detailed status
uap deploy status --verbose
```

## Configuration Schema

The batch window configuration follows this schema:

```typescript
interface DynamicBatchWindows {
  commit: number; // Default: 30000ms (30s)
  push: number; // Default: 5000ms (5s)
  merge: number; // Default: 10000ms (10s)
  workflow: number; // Default: 5000ms (5s)
  deploy: number; // Default: 60000ms (60s)
}
```

## Best Practices

### When to Adjust Windows

1. **Increase windows** when:
   - You want more aggressive batching
   - Multiple developers are working on the same branch
   - You prefer fewer, larger deployments

2. **Decrease windows** when:
   - You need faster feedback
   - Time-sensitive deployments
   - CI/CD pipeline is the bottleneck

3. **Use urgent mode** when:
   - Hotfix deployment
   - Security patch
   - Critical bug fix

### Performance Considerations

- **Shorter windows** = Faster execution but more individual operations
- **Longer windows** = More batching but slower response time
- **Parallel execution** works best for independent workflow triggers

## Architecture

The deploy system consists of:

1. **DeployBatcher** - Core batching logic with dynamic windows
2. **CoordinationService** - Manages agent coordination state
3. **SQLite Database** - Persistent storage for pending actions and batches

## API Reference

### DeployBatcher Configuration

```typescript
interface DeployBatcherConfig {
  dbPath?: string;
  batchWindowMs?: number; // Legacy: single window for all types
  dynamicWindows?: Partial<DynamicBatchWindows>; // NEW: per-type windows
  maxBatchSize?: number;
  dryRun?: boolean;
  parallelExecution?: boolean;
  maxParallelActions?: number;
}
```

### Methods

```typescript
class DeployBatcher {
  // Queue an action with type-specific batching
  async queue(
    agentId: string,
    actionType: DeployActionType,
    target: string,
    payload?: Record<string, unknown>,
    options?: { priority?: number; dependencies?: string[]; urgent?: boolean }
  ): Promise<number>;

  // Get current batch window for action type
  getBatchWindow(actionType: DeployActionType): number;

  // Set urgent mode
  setUrgentMode(urgent: boolean): void;

  // Get current configuration
  getWindowConfig(): DynamicBatchWindows;

  // Create batch from ready actions
  async createBatch(): Promise<DeployBatch | null>;

  // Execute a batch
  async executeBatch(batchId: string): Promise<BatchResult>;

  // Flush all pending deploys
  async flushAll(): Promise<BatchResult[]>;
}
```

## Troubleshooting

### Actions Not Batching

**Issue:** Actions remain in "pending" status for too long.

**Solution:** Check batch window configuration:

```bash
uap deploy config
```

Adjust windows if needed:

```bash
uap deploy set-config --message '{"commit":5000,"push":2000}'
```

### Urgent Mode Not Working

**Issue:** Urgent mode doesn't reduce wait times.

**Solution:** Ensure you're using the correct flags:

```bash
uap deploy urgent --on
```

### Parallel Execution Not Working

**Issue:** Actions execute sequentially instead of in parallel.

**Solution:** Check that actions are independent (different action types or targets).

## Related Documentation

- [Deploy Command Reference](./CLI_DEPLOY.md)
- [Coordination System](./COORDINATION.md)
- [Batch Execution Guide](./BATCH_EXECUTION.md)

## Version History

- **v4.3.0** - Added dynamic batch windows per action type
- **v4.2.0** - Added urgent mode for fast execution
- **v4.1.0** - Added parallel execution for independent actions
- **v4.0.0** - Initial deploy batching system
