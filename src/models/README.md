# Models Module

The models module implements multi-model architecture with task planning, model routing, execution, and validation.

## Architecture

```
Tier 1: TaskPlanner    -- Decomposes task into subtasks
Tier 2: ModelRouter    -- Assigns optimal model per subtask
Tier 3: TaskExecutor   -- Executes with validation, dynamic temperature, rate limiting
```

## Components (10 files)

### Core Model System

| Component      | File                | Purpose                                      |
| -------------- | ------------------- | -------------------------------------------- |
| Model Router   | `router.ts`         | Routes by complexity and cost                |
| Task Planner   | `planner.ts`        | Decomposition, dependency analysis           |
| Task Executor  | `executor.ts`       | Execution with model profiles, rate limiting |
| Plan Validator | `plan-validator.ts` | Cycle detection, coherence checks            |

### Configuration & Analytics

| Component          | File                    | Purpose                       |
| ------------------ | ----------------------- | ----------------------------- |
| Profile Loader     | `profile-loader.ts`     | Load model profiles from JSON |
| Execution Profiles | `execution-profiles.ts` | Runtime profile management    |
| Unified Router     | `unified-router.ts`     | Combined routing logic        |
| Analytics          | `analytics.ts`          | Model performance tracking    |

## Model Profiles (13 profiles)

Pre-configured profiles in `config/model-profiles/`:

- claude-opus-4.6, claude-sonnet-4.6, claude-haiku-3.5
- gpt-4.1, gpt-4o, gpt-o3
- gemini-2.5-pro, gemini-2.5-flash
- qwen35, glm-5, kimi-k2.5, llama, generic

Each profile supports:

- `dynamic_temperature` (decay per retry)
- `tool_call_batching` (system prompt suffix)
- `rate_limits` (requests/tokens per minute)

## Usage Examples

```typescript
import { createRouter, createPlanner, TaskExecutor } from '@miller-tech/uap';

// Create router with cost optimization
const router = createCostOptimizedRouter();

// Plan task decomposition
const planner = createPlanner();
const plan = await planner.plan('Implement OAuth2 authentication', {
  maxSubtasks: 10,
  maxDepth: 3,
});

// Execute with validation
const executor = new TaskExecutor();
const result = await executor.execute(plan, {
  validate: true,
  retry: true,
  maxRetries: 2,
});
```

## Configuration

```typescript
interface MultiModelConfig {
  enabled: boolean;
  models: string[]; // Model IDs
  roles: {
    planner: string; // Default planner model
    executor: string; // Default executor model
    fallback: string; // Fallback on failure
  };
  routingStrategy: 'cost-optimized' | 'performance-first' | 'balanced';
}
```

## See Also

- [Multi-Model Architecture](../../docs/reference/FEATURES.md#multi-model-architecture)
- [Model Profiles](../../config/model-profiles/)
- [Task Management](../../docs/reference/FEATURES.md#task-management)
