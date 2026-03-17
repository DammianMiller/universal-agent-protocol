# Multi-Model Agentic Architecture

## Executive Summary

This document proposes a two-tier agentic architecture using separate models for planning and execution, achieving **92-98% cost reduction** while maintaining near-original performance for complex tasks.

## Core Concept

**Separation of Concerns:**
- **Tier 1 (Planner)**: High-level reasoning, task decomposition, orchestration
- **Tier 2 (Executor)**: Concrete implementation following planner's specifications

### Research Findings (2026)

#### Model Candidates

| Model | Role | Cost (Input/Output) | SWE-Bench | Context | Notes |
|-------|------|----------------------|-----------|---------|-------|
| **Claude Opus 4.5** | Planner (current) | $5/$25 per 1M | Highest | 200K | Premium, but expensive |
| **DeepSeek-V3.2** | Planner | $0.25/$0.38 per 1M | 73.1% | 164K | Best cost/performance ratio |
| **DeepSeek-V3.2-Exp** | Executor | $0.21/$0.32 per 1M | Strong | 164K | 78x cheaper output than Opus |
| **GLM-4.7** | Executor | Very Low | Good | 128K | Current workhorse |

#### Key Findings

1. **DeepSeek-V3.2 Speciale** achieves 73.1% on SWE-Bench Verified (vs Opus's highest scores)
2. **Cost differential**: DeepSeek is ~23x cheaper for input, ~78x cheaper for output
3. **Context**: 164K is sufficient for most agentic workflows (vs 200K for Opus)
4. **Architecture**: MoE with 671B params, activates only 37B per token (high efficiency)

## Proposed Architecture

### Tier 1: Master Planner

**Model**: **DeepSeek-V3.2 Speciale** (replacing Opus 4.5)

**Responsibilities**:
- Task decomposition and planning
- Subtask dependency analysis
- Model selection for each subtask
- Quality assurance routing
- Critical path identification

**When to invoke:**
- New task request
- Complex multi-step workflows
- Requirements for strategic planning
- Architectural decisions

**Fallback**: If DeepSeek fails on critical planning, escalate to Opus 4.5 (1% of cases)

### Tier 2: Task Executor

**Model**: **GLM-4.7** (current workhorse) or **DeepSeek-V3.2-Exp**

**Responsibilities**:
- Implement specific code blocks
- Execute tool calls
- Write tests
- Fix bugs based on planner guidance
- Generate documentation

**When to invoke:**
- Concrete implementation tasks
- Coding following specifications
- Test writing
- Bug fixes with clear guidance

### Route Decision Matrix

| Task Complexity | Routing Logic | Model Selection |
|----------------|---------------|-----------------|
| **High** (new feature, architecture) | → Planner → Decompose → Executor | DeepSeek-V3.2 → GLM-4.7 |
| **Medium** (refactor, bug fix) | → Direct Executor | GLM-4.7 |
| **Low** (simple change) | → Direct Executor | GLM-4.7 |
| **Critical** (security, deployment) | → Planner → Verify → Executor | DeepSeek-V3.2 → GLM-4.7 |

## Implementation Strategy

### Phase 1: Router (Week 1)

```typescript
interface ModelRouter {
  route(task: AgenticTask): ModelSelection;
}

interface ModelSelection {
  model: ModelId;
  fallback?: ModelId;
  reasoning: string;
}
```

**Routing Logic**:
1. Analyze task complexity (token estimate, dependencies, novelty)
2. Check for critical keywords (security, architecture, planning)
3. Select DeepSeek-V3.2 for planning tasks
4. Select GLM-4.7 for execution tasks
5. Fallback to Opus 4.5 only on threshold failures

### Phase 2: Planner Integration (Week 2)

**Planner Interface**:
```typescript
interface Planner {
  plan(task: AgenticTask): ExecutionPlan;
}

interface ExecutionPlan {
  subtasks: Subtask[];
  dependencies: DependencyGraph;
  modelAssignments: Map<SubtaskId, ModelId>;
}
```

**DeepSeek-V3.2 Integration**:
- API endpoint integration
- Context window management (164K)
- Token budget accounting
- Failure detection and escalation

### Phase 3: Executor Pool (Week 3)

**Executor Options**:
1. **Primary**: GLM-4.7 (existing, low cost, good performance)
2. **Backup**: DeepSeek-V3.2-Exp (if GLM-4.7 unavailable)
3. **Fallback**: Opus 4.5 (critical failures only)

**Load Balancing**:
- Round-robin across multiple executor instances
- Circuit breaker pattern for reliability
- Timeout management per subtask

## Cost Analysis

### Baseline (Opus 4.5 Only)

**Assumptions**:
- 100 tasks/day
- Average 50K input tokens, 30K output tokens per task
- $5/input per 1M, $25/output per 1M

**Daily Cost**:
- Input: 100 * 50K * $5/1M = $25
- Output: 100 * 30K * $25/1M = $75
- **Total: $100/day**

**Monthly Cost**: $3,000
**Yearly Cost**: $36,500

### Proposed (DeepSeek + GLM-4.7)

**Distribution**:
- 30% complex tasks → DeepSeek-V3.2 planning (10K tokens)
- 70% direct execution → GLM-4.7 (15K input, 5K output)

**Daily Cost**:
- Planner (DeepSeek): 30 tasks * 10K tokens * ($0.25/$0.38)/1M = $0.19
- Executor (GLM): 
  - Input: 100 tasks * 15K * $1/1M = $1.50
  - Output: 100 tasks * 5K * $2/1M = $1.00
- **Total: $2.69/day**

**Monthly Cost**: $80.70
**Yearly Cost**: $982

### Cost Savings

| Metric | Baseline | Proposed | Savings |
|--------|----------|----------|---------|
| Daily | $100 | $2.69 | **97.3%** |
| Monthly | $3,000 | $80.70 | **97.3%** |
| Yearly | $36,500 | $982 | **97.3%** |

### Performance Impact

Expected SWE-Bench performance:
- **Baseline**: Opus 4.5 (highest scores)
- **Proposed**: 
  - Planner (DeepSeek-V3.2): 73.1% (verified)
  - Executor (GLM-4.7): Strong on straightforward tasks
  - **Composite**: Estimated 85-90% of baseline

**Trade-off**: Accept 10-15% performance drop for 97% cost reduction

## Risk Assessment

### Risks

1. **Routing Errors**: Poor model selection for tasks
   - **Mitigation**: Start conservative, 10% fallback to Opus
   - **Monitoring**: Track task success rates per model

2. **Quality Regression**: Lower code质量
   - **Mitigation**: Add review loops, use quality droids
   - **Monitoring**: Track test pass rates, bug counts

3. **API Reliability**: DeepSeek availability issues
   - **Mitigation**: Multi-in redundancy, fallback to Opus
   - **Monitoring**: Uptime, latency tracking

### Rollback Plan

If metrics degrade >20%, revert to Opus 4.5-only mode within 24 hours.

## Next Steps

1. **Week 1**: Implement router with conservative routing (20% direct to Opus)
2. **Week 2**: Integrate DeepSeek-V3.2 API, test on 10% of tasks
3. **Week 3**: Shift to 50/50 routing, monitor carefully
4. **Week 4**: Full deployment, 95% tasks to proposed architecture

## Success Metrics

- Cost reduction: >90% achieved by month 1
- Performance: <20% drop vs baseline
- Reliability: <5% increase in task failures
- ROI: Break-even within 2 weeks

---

**Status**: Draft - Ready for review and implementation
**Created**: 2026-01-21
**Next Review**: 2026-01-28 (after week 1 pilot)
