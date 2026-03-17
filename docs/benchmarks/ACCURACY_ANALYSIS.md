# UAP Benchmark Analysis: Accuracy Issues & Improvement Recommendations

**Date:** 2026-01-15
**Author:** Droid Analysis

## Executive Summary

Our internal UAP benchmark shows dramatically different results from Terminal-Bench 2.0:

| Model           | Our Benchmark | Terminal-Bench 2.0                 | Delta   |
| --------------- | ------------- | ---------------------------------- | ------- |
| Claude Opus 4.5 | 100%          | 63.1% (Droid), 52.1% (Claude Code) | +37-48% |
| GPT 5.2 Codex   | 87.5%         | 64.9% (Droid), 62.9% (Codex CLI)   | +23-25% |
| GLM 4.7         | 75%           | ~24.5% (GLM 4.6 baseline)          | +50%    |

**Conclusion:** Our benchmark is NOT accurate and significantly overestimates model capabilities.

---

## Root Cause Analysis

### 1. Task Complexity Gap (CRITICAL)

**Our Tasks:**

- Simple code generation (calculate average, fix off-by-one bug)
- Pattern implementation (singleton class)
- Refactoring (strategy pattern)
- Algorithm (Dijkstra's - well-documented)

**Terminal-Bench 2.0 Tasks (89 tasks):**

- Build Linux kernel from source
- Configure git web server with authentication
- Exploit CVE-2023-28432 (MinIO vulnerability)
- Train RL agents and text classifiers
- Resolve Conda environment dependency conflicts
- Scrub repository of secrets
- QEMU/KVM virtualization setup
- DNS server configuration
- Cron job debugging with malware detection

**Issue:** Our tasks are "textbook problems" with well-known solutions in training data. Terminal-Bench tasks require:

- Multi-step environment exploration
- Real system interaction (file I/O, network, processes)
- Domain-specific knowledge (security, ML, sysadmin)
- Error recovery and debugging
- Time-constrained execution (aggressive timeouts)

### 2. Evaluation Method Flaws

**Our Method:**

```typescript
// Simple pattern matching - 60% threshold
const matchRatio = result.matchedPatterns.length / task.expectedPatterns.length;
result.success = matchRatio >= 0.6;
```

**Problems:**

1. **Pattern matching != correctness** - Code can contain patterns but be wrong
2. **No execution verification** - We don't run the generated code
3. **No test suite** - Terminal-Bench has post-run tests for each task
4. **No environment interaction** - Real tasks need file I/O, network, shell commands

**Terminal-Bench Method:**

- Tasks run in Docker containers
- Time-boxed execution (aggressive timeouts)
- Success = ALL post-run tests pass
- Real environment interaction required

### 3. Memory Context Injection Issues

**Current Implementation:**

```typescript
const prompt = withMemory
  ? getUAPMemoryContext() + task.prompt // Just prepend context
  : task.prompt;
```

**Problems:**

1. **Static context prepending** - Not dynamically relevant to task
2. **No semantic retrieval** - Doesn't query memory based on task content
3. **Context bloat** - 4158 chars of generic info, may hurt more than help
4. **No task-specific memories** - Doesn't retrieve relevant past experiences

### 4. Execution Environment Gap

**Our Benchmark:**

- `droid exec` with `--auto medium` (limited permissions)
- Single prompt completion (no multi-turn interaction)
- No file system access during execution
- No shell command execution
- No network access

**Terminal-Bench:**

- Full Docker container with root access
- Multi-turn agent loop (explore, act, verify)
- Real file system operations
- Shell command execution
- Network access for some tasks

---

## Why Models Score Higher in Our Benchmark

1. **Training data advantage** - Our tasks (Dijkstra, singleton, etc.) are common in training data
2. **No verification** - Pattern matching doesn't catch bugs
3. **Single-shot completion** - No need for environment exploration
4. **No time pressure** - Tasks take 20-200s, Terminal-Bench has strict timeouts
5. **No real execution** - Generated code is never run

---

## UAP Improvement Recommendations

### High Impact (Must Do)

#### 1. Implement Semantic Memory Retrieval

```typescript
// BEFORE: Static prepending
const prompt = memoryContext + task.prompt;

// AFTER: Semantic retrieval based on task content
async function getRelevantMemory(task: BenchmarkTaskDef): Promise<string> {
  const keywords = extractKeywords(task.prompt);
  const relevantLessons = await querySemanticMemory(keywords, {
    minSimilarity: 0.7,
    limit: 5,
    types: ['lesson', 'gotcha', 'pattern'],
  });

  const taskCategory = classifyTask(task.prompt);
  const categoryPatterns = await getPatternsByCategory(taskCategory);

  return formatMemoryContext(relevantLessons, categoryPatterns);
}
```

#### 2. Add Task Classification & Routing

```typescript
interface TaskClassification {
  category: 'sysadmin' | 'security' | 'ml' | 'debugging' | 'coding';
  requiredCapabilities: string[];
  suggestedDroid: string;
  memoryQueryHints: string[];
}

function classifyTask(instruction: string): TaskClassification {
  // Use keyword matching + LLM classification
  // Route to specialized droids based on category
}
```

#### 3. Implement Real Execution Verification

```typescript
// Execute generated code in sandboxed environment
async function verifyCodeExecution(
  code: string,
  testCases: TestCase[]
): Promise<VerificationResult> {
  const sandbox = await createSandbox();
  try {
    await sandbox.writeFile('solution.ts', code);
    await sandbox.exec('npx tsc solution.ts');

    for (const test of testCases) {
      const result = await sandbox.exec(`node solution.js ${test.input}`);
      if (result.stdout.trim() !== test.expectedOutput) {
        return { success: false, failedTest: test };
      }
    }
    return { success: true };
  } finally {
    await sandbox.cleanup();
  }
}
```

#### 4. Add Multi-Turn Agent Loop

```typescript
// Enable iterative refinement like real Terminal-Bench agents
async function executeWithRetry(task: BenchmarkTaskDef, maxTurns: number = 5): Promise<TaskResult> {
  let context = getInitialContext(task);

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await model.complete(context);
    const verification = await verifyResponse(response, task);

    if (verification.success) {
      return { success: true, turns: turn + 1, response };
    }

    // Add error feedback for next turn
    context += `\n\nPrevious attempt failed: ${verification.error}\nPlease fix and try again.`;
  }

  return { success: false, turns: maxTurns };
}
```

### Medium Impact (Should Do)

#### 5. Implement Hierarchical Prompting (from Droid #1)

```typescript
// Three-tier prompting hierarchy
interface PromptHierarchy {
  toolDescriptions: string; // High-level capabilities
  systemPrompt: string; // Behavioral guidelines
  systemNotifications: string; // Time-sensitive context (injected at END for recency bias)
}

function buildPrompt(task: BenchmarkTaskDef, memory: string): string {
  return `
${TOOL_DESCRIPTIONS}

${SYSTEM_PROMPT}

Task: ${task.prompt}

${memory}

${SYSTEM_NOTIFICATION}  // Put critical reminders at END
`;
}
```

#### 6. Add Environment Bootstrap Phase

```typescript
// Gather system info before task execution (like Droid does)
async function bootstrapEnvironment(): Promise<EnvironmentContext> {
  const sysInfo = await exec('uname -a && cat /etc/os-release');
  const tools = await exec('which python python3 pip npm node go cargo');
  const diskMem = await exec('df -h / && free -h');
  const processes = await exec('ps aux | head -20');
  const gitStatus = await exec('git status 2>/dev/null');

  return {
    system: sysInfo,
    availableTools: tools,
    resources: diskMem,
    processes,
    gitStatus,
  };
}
```

#### 7. Store Task-Specific Learnings

```typescript
// After each task, store what worked/failed
async function storeTaskLearning(task: BenchmarkTaskDef, result: TaskResult): Promise<void> {
  if (result.success) {
    await storeMemory({
      type: 'lesson',
      content: `Task "${task.name}" succeeded with approach: ${summarizeApproach(result.response)}`,
      tags: [task.category, task.difficulty],
      importance: 8,
    });
  } else {
    await storeMemory({
      type: 'gotcha',
      content: `Task "${task.name}" failed: ${result.error}. Avoid: ${summarizeFailure(result)}`,
      tags: [task.category, 'failure'],
      importance: 9,
    });
  }
}
```

### Lower Impact (Nice to Have)

#### 8. Add Speed Optimizations

- Track tool/command runtime, inject into context
- Use short default timeouts (30s), opt-in to longer
- Cache environment bootstrap info
- Parallelize independent operations

#### 9. Model-Specific Adaptations

```typescript
const MODEL_CONFIGS = {
  'opus-4.5': {
    fileEditFormat: 'FIND_AND_REPLACE',
    pathStyle: 'absolute',
    strengths: ['security', 'debugging', 'CVE exploitation'],
  },
  'gpt-5.2-codex': {
    fileEditFormat: 'V4A_DIFF',
    pathStyle: 'relative',
    strengths: ['ML training', 'video editing'],
  },
  'glm-4.7': {
    fileEditFormat: 'FIND_AND_REPLACE',
    pathStyle: 'absolute',
    strengths: ['speed', 'simple tasks'],
  },
};
```

---

## Recommended Benchmark Redesign

### Phase 1: Add Real Tasks (Week 1)

1. Add 10+ Terminal-Bench-style tasks:
   - File manipulation with verification
   - Git operations with repo state verification
   - Code refactoring with test execution
   - Debugging tasks with error injection
   - Configuration tasks with validation

### Phase 2: Add Execution Verification (Week 2)

1. Integrate Docker sandbox for code execution
2. Add test suites for each task
3. Implement timeout handling
4. Add resource monitoring (memory, CPU)

### Phase 3: Improve Memory System (Week 3)

1. Implement semantic memory retrieval
2. Add task classification & routing
3. Store task-specific learnings
4. Add pattern extraction from successes

### Phase 4: Multi-Turn Agent Loop (Week 4)

1. Enable iterative refinement
2. Add error feedback mechanism
3. Implement planning & progress tracking
4. Add environment exploration phase

---

## Expected Impact

After implementing these improvements:

| Model           | Current      | Expected        | Reasoning                         |
| --------------- | ------------ | --------------- | --------------------------------- |
| Claude Opus 4.5 | 100% → ~65%  | Real difficulty | Harder tasks, real verification   |
| GPT 5.2 Codex   | 87.5% → ~60% | Real difficulty | Harder tasks, real verification   |
| GLM 4.7         | 75% → ~35%   | Base capability | Lower base, but memory helps more |

**With UAP Memory Improvements:**

| Model           | Without UAP | With UAP | Expected Gain           |
| --------------- | ----------- | -------- | ----------------------- |
| Claude Opus 4.5 | ~60%        | ~68%     | +8% (already high base) |
| GPT 5.2 Codex   | ~55%        | ~65%     | +10%                    |
| GLM 4.7         | ~30%        | ~45%     | +15% (most benefit)     |

---

## Conclusion

Our current benchmark significantly overestimates model performance due to:

1. Simple, well-known tasks vs real-world complexity
2. Pattern matching vs execution verification
3. Single-shot vs multi-turn interaction
4. No environment interaction

To make UAP truly effective for Terminal-Bench-style tasks, we need to:

1. Implement semantic memory retrieval
2. Add task classification & routing
3. Enable multi-turn agent loops
4. Add real execution verification

The current +12.5% improvement for GLM 4.7 with memory is likely real but understated - with proper memory retrieval, the benefit could be +15-20% for lower-capability models.

---

## Appendix: Specific Code Issues Found

### Issue 1: Qdrant Query Uses Dummy Embeddings

**File:** `src/memory/backends/qdrant-cloud.ts`

```typescript
async query(_queryText: string, limit = 10): Promise<MemoryEntry[]> {
  // TODO: Generate embedding for query string
  // For now, use dummy embedding - needs embedding service integration
  const queryEmbedding = new Array(384).fill(0);  // THIS IS BROKEN

  const results = await this.client.search(this.collection, {
    vector: queryEmbedding,
    limit,
  });
```

**Impact:** Semantic memory retrieval is completely non-functional. All queries return random results.

**Fix Required:** Integrate embedding generation (OpenAI, Sentence Transformers, or local model).

### Issue 2: Memory Context Loading Is Static

**File:** `src/benchmarks/model-integration.ts`

```typescript
function loadUAPMemoryContext(): string {
  // Extracts fixed sections from CLAUDE.md
  // Does NOT query based on task content
  // Uses hardcoded patterns, not semantic search
}
```

**Impact:** Memory context is identical for all tasks regardless of relevance.

### Issue 3: Short-Term Memory Query Is Keyword-Only

**File:** `src/memory/short-term/sqlite.ts`

```typescript
async query(searchTerm: string, limit = 10): Promise<ShortTermMemory[]> {
  const stmt = this.db.prepare(`
    SELECT ... FROM memories
    WHERE project_id = ? AND content LIKE ?  // Simple substring match
  `);
  return stmt.all(this.projectId, `%${searchTerm}%`, limit);
}
```

**Impact:** No semantic understanding. "authentication flow" won't match "login process".

### Issue 4: No Task-Specific Memory Retrieval

**Current flow:**

1. Load generic CLAUDE.md sections
2. Query short-term memory with fixed SQL
3. Prepend to prompt

**Required flow:**

1. Classify task type (sysadmin, security, ML, etc.)
2. Extract task keywords/entities
3. Query semantic memory with embeddings
4. Retrieve task-specific patterns and gotchas
5. Format context with recency bias (critical info at END)
6. Inject dynamically during multi-turn execution

---

## Implementation Priority

| Priority | Issue                              | Impact                 | Effort |
| -------- | ---------------------------------- | ---------------------- | ------ |
| P0       | Fix Qdrant embedding generation    | Semantic search broken | Medium |
| P0       | Add task classification            | Enable routing         | Low    |
| P1       | Implement dynamic memory retrieval | Context relevance      | Medium |
| P1       | Add execution verification         | Accuracy measurement   | High   |
| P2       | Multi-turn agent loop              | Error recovery         | High   |
| P2       | Hierarchical prompting             | Context optimization   | Medium |
