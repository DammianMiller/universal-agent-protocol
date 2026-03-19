# Model Routing CLI Selection & UAP Compliance Analysis

## Current Issues Identified

### 1. Missing 'task' Role in Model Routing

**File**: `src/models/types.ts` (line 15)

```typescript
export type ModelRole = 'planner' | 'executor' | 'reviewer' | 'fallback';
```

The routing rules support `'task'` as a target role, but the type definition is missing this value.

### 2. Null Issues in Router

**File**: `src/models/router.ts`

- Line 117: `preset` can be undefined when model preset doesn't exist
- Line 468: No fallback when executor model is not found
- Line 13: Import uses `ModelPresets` but no null check before access

### 3. Missing CLI Command for Model Selection

**Current**: `uap model status`, `route`, `plan`, `compare` exist
**Missing**: Interactive CLI to select models per purpose at runtime

---

## UAP Compliance Correctness Analysis

### Compliant Features ✅

1. **Multi-model architecture types** - Properly defined in `types.ts`
2. **Routing rules with priorities** - Implemented in `router.ts`
3. **Task classification** - Complexity-based routing works correctly
4. **Planner/Executor separation** - Implemented with validation
5. **Cost estimation** - Built into router
6. **Fallback mechanisms** - Present in all critical paths

### Non-Compliant Features ❌

1. **Missing 'task' role** - Type definition incomplete
2. **No null safety** - Multiple undefined access patterns
3. **Incomplete CLI** - No interactive model selection
4. **TypeScript build issues** - May fail on missing presets
5. **No validation for role assignments** - Can assign non-existent models to roles

---

## Performance Analysis

### Current Implementation Performance

| Feature             | Performance | Notes                           |
| ------------------- | ----------- | ------------------------------- |
| Task Classification | O(1)        | Keyword matching is fast        |
| Model Selection     | O(n)        | Iterates through routing rules  |
| Plan Creation       | O(n\*m)     | n=subtasks, m=complexity levels |
| Routing Analysis    | O(n)        | Full rule evaluation            |

### Bottlenecks Identified

1. **Routing rules iteration** - Can be optimized with indexing
2. **Keyword matching** - Linear scan through all keywords
3. **No caching** - Classification recalculated each time
4. **Model lookup** - Map is efficient but presets initialization is synchronous

---

## Optimization Options

### Option 1: Quick Fixes (Recommended for Immediate Use)

**Priority**: High | **Effort**: Low | **Impact**: Medium

#### A. Fix Missing 'task' Role

```typescript
// src/models/types.ts line 15
export type ModelRole = 'planner' | 'executor' | 'reviewer' | 'fallback' | 'task';
```

#### B. Add Null Safety to Router

```typescript
// src/models/router.ts line 117-120
if (preset) {
  this.models.set(modelDef, preset);
}
// Add check before accessing preset throughout
```

#### C. Add Role Assignment Validation

```typescript
// In ModelRouter constructor
private validateRoleAssignments(): void {
  const roles = this.config.roles || {};
  for (const [role, modelId] of Object.entries(roles)) {
    if (!this.models.has(modelId)) {
      console.warn(`Role ${role} assigned to non-existent model ${modelId}`);
    }
  }
}
```

### Option 2: CLI Enhancement (User-Friendly Selection)

**Priority**: High | **Effort**: Medium | **Impact**: High

#### A. Add Interactive Model Selector

```typescript
// src/cli/model.ts - New command
program
  .command('model:select')
  .description('Interactively select models for each role')
  .option('--planner <id>', 'Model ID for planning role')
  .option('--executor <id>', 'Model ID for execution role')
  .option('--reviewer <id>', 'Model ID for review role')
  .option('--fallback <id>', 'Model ID for fallback role')
  .option(
    '--strategy <strategy>',
    'Routing strategy: balanced|cost-optimized|performance-first|adaptive'
  )
  .option('--save', 'Save configuration to .uap.json')
  .action(async (options) => {
    // Interactive selection logic
  });
```

#### B. Add Preset Browser

```typescript
// Show available presets with details
uap model presets --verbose
```

#### C. Add Configuration Export

```typescript
// Export current config as JSON/YAML
uap model export --format json > model-config.json
```

### Option 3: Performance Optimizations

**Priority**: Medium | **Effort**: Medium | **Impact**: High

#### A. Add Classification Caching

```typescript
class ModelRouter {
  private classificationCache = new Map<string, TaskClassificationResult>();

  classifyTask(taskDescription: string): TaskClassificationResult {
    const cacheKey = taskDescription.toLowerCase().trim();
    if (this.classificationCache.has(cacheKey)) {
      return this.classificationCache.get(cacheKey)!;
    }
    // ... existing logic ...
    const result = /* classification logic */;
    this.classificationCache.set(cacheKey, result);
    return result;
  }
}
```

#### B. Optimize Keyword Matching

```typescript
// Pre-compile keyword patterns for faster matching
private complexityPatterns: Map<TaskComplexity, RegExp[]> = new Map();
private taskTypePatterns: Map<string, RegExp[]> = new Map();

private buildPatternIndex(): void {
  for (const [level, keywords] of Object.entries(COMPLEXITY_KEYWORDS)) {
    this.complexityPatterns.set(level as TaskComplexity,
      keywords.map(kw => new RegExp(`\\b${kw}\\b`, 'i')));
  }
}
```

#### C. Add Routing Rule Indexing

```typescript
// Group rules by condition for O(1) lookup
private complexityIndex: Map<TaskComplexity, RoutingRule[]> = new Map();
type TaskTypeIndex: Map<string, RoutingRule[]> = new Map();

private buildIndexes(): void {
  for (const rule of this.routingRules) {
    if (rule.complexity) {
      const rules = this.complexityIndex.get(rule.complexity) || [];
      rules.push(rule);
      this.complexityIndex.set(rule.complexity, rules);
    }
  }
}
```

### Option 4: Enhanced Validation & Diagnostics

**Priority**: Medium | **Effort**: Low | **Impact**: Medium

#### A. Add Model Health Check

```typescript
// src/cli/model.ts
async function healthCheckCommand(): Promise<void> {
  const config = loadConfig();
  const mmConfig = getMultiModelConfig(config);
  const router = createRouter(mmConfig);

  console.log('=== Model Health Check ===\n');

  // Check all assigned models exist
  const roles = mmConfig.roles || {};
  let hasErrors = false;
  for (const [role, modelId] of Object.entries(roles)) {
    if (!router.getModel(modelId)) {
      console.error(`❌ ${role}: Model '${modelId}' not found`);
      hasErrors = true;
    } else {
      console.log(`✓ ${role}: ${modelId} (OK)`);
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}
```

#### B. Add Configuration Diff

```typescript
// Compare current config with defaults
uap model diff
```

#### C. Add Simulation Mode

```typescript
// Test routing without execution
uap model simulate --task "<task description>" --dry-run
```

---

## Recommended Implementation Plan

### Phase 1: Critical Fixes (1-2 hours)

1. ✅ Fix missing 'task' role type definition
2. ✅ Add null safety checks in router
3. ✅ Add role assignment validation
4. ✅ Run build to verify TypeScript compilation

### Phase 2: CLI Enhancement (2-3 hours)

1. ✅ Add `uap model select` interactive command
2. ✅ Add `uap model presets` listing
3. ✅ Add `uap model export` for config backup
4. ✅ Add `uap model health` diagnostic

### Phase 3: Performance (4-6 hours)

1. ✅ Add classification caching
2. ✅ Optimize keyword matching with precompiled patterns
3. ✅ Index routing rules for faster lookup
4. ✅ Benchmark before/after performance

### Phase 4: Validation & Testing (2-3 hours)

1. ✅ Add comprehensive unit tests for router
2. ✅ Add integration tests for CLI commands
3. ✅ Create sample configurations for testing
4. ✅ Document all new commands

---

## Implementation Priority Matrix

| Task                     | Priority | Effort | Impact | Phase |
| ------------------------ | -------- | ------ | ------ | ----- |
| Fix 'task' role type     | High     | Low    | High   | 1     |
| Add null safety          | High     | Low    | High   | 1     |
| CLI interactive selector | High     | Medium | High   | 2     |
| Role validation          | High     | Low    | Medium | 1     |
| Classification cache     | Medium   | Low    | Medium | 3     |
| Keyword optimization     | Medium   | Medium | Low    | 3     |
| Health check command     | Medium   | Low    | Medium | 2     |
| Rule indexing            | Medium   | Medium | Medium | 3     |

---

## UAP Compliance Checklist

After implementation, verify:

- [ ] All model roles properly typed and validated
- [ ] No undefined/null access patterns in router
- [ ] CLI commands for model selection work interactively
- [ ] Build passes without errors
- [ ] All existing tests pass
- [ ] New commands documented in CLI help
- [ ] Performance improvements verified with benchmarks
- [ ] Configuration export/import works correctly

---

## Next Steps

1. **Start with Phase 1** - Critical fixes to prevent runtime errors
2. **Run `npm run build`** after each phase to verify compilation
3. **Test with sample tasks** to verify routing correctness
4. **Document changes** in CHANGELOG.md
5. **Create migration guide** if breaking changes are introduced
