# Dashboard Data Service - Real vs Mock Data Verification Report

**File Analyzed:** `/home/cogtek/dev/miller-tech/universal-agent-protocol/src/dashboard/data-service.ts`  
**Date:** April 11, 2026  
**Status:** ALL DATA SOURCES CONFIRMED AS REAL/LIVE

---

## Executive Summary

After thorough analysis of the dashboard data service code and verification of all underlying database files, **ALL 10 data sources use REAL/LIVE data from actual databases, live APIs, filesystem paths, or runtime metrics.** No mock, fake, dummy, stub, or placeholder data was found in the codebase.

---

## Detailed Data Source Analysis

### 1. System Data (getSystemData)

- **Status:** REAL/LIVE
- **Sources:**
  - package.json file read (version: 1.20.32)
  - git branch --show-current subprocess (branch: master)
  - git status --porcelain subprocess (dirty count: 37 files)
- **Implementation:** Direct filesystem and git command execution

### 2. Tasks Data (getTaskData)

- **Status:** REAL/LIVE
- **Database:** .uap/tasks/tasks.db
- **Table:** tasks
- **Verified Data:** 77 total tasks (12 done, 65 in_progress)
- **Implementation:** Direct SQLite queries with status aggregation

### 3. Coordination Data (getCoordData)

- **Status:** REAL/LIVE
- **Databases:**
  - agents/data/coordination/coordination.db (agent_registry, work_claims, deploy_queue, pattern_outcomes, agent_pattern_outcomes)
  - .uap/worktree_registry.db (worktrees table)
- **Filesystem:** .claude/skills/ directory scan
- **Verified Data:** 44 agents (3 active, 41 completed), 70 worktrees, 2 pattern outcomes, 5 skill directories
- **Implementation:** Multi-database queries with filesystem enumeration

### 4. Memory Data (getMemoryData)

- **Status:** REAL/LIVE
- **Databases:**
  - agents/data/memory/short_term.db (memories, session_memories, entities, relationships)
  - agents/data/memory/model_analytics.db (task_outcomes for compression stats)
- **External Service:** Docker API (docker ps --filter name=qdrant)
- **Verified Data:**
  - L1: 238 memories (188 action, 48 observation, 2 thought)
  - L2: 100 session memories
  - L3: Qdrant running (Up 16 hours)
  - L4: 407 entities, 406 relationships
- **Implementation:** SQLite queries with Docker subprocess and TTL caching

### 5. Models Data (getModelData)

- **Status:** REAL/LIVE
- **Config:** .uap/config.json (multiModel configuration)
- **Database:** agents/data/memory/model_analytics.db (task_outcomes table)
- **Verified Data:**
  - 602 task outcomes across 2 models
  - haiku: 497 tasks, 35,429 tokens in, 5,396 tokens out
  - glm-4.7: 105 tasks, 7,485 tokens in, 1,095 tokens out
  - Total cost: $0.0507852
- **Implementation:** Config loading + SQLite aggregation queries

### 6. Policies Data (getPolicyData, getPolicyFiles)

- **Status:** REAL/LIVE
- **Database:** agents/data/memory/policies.db (policies table)
- **Filesystem:** policies/\*.md directory scan
- **Verified Data:**
  - 12 policies in database
  - 12 policy markdown files (excluding README.md)
  - Categories: quality, infrastructure, workflow, versioning, operations, safety, general
- **Implementation:** SQLite queries + filesystem glob pattern matching

### 7. Deploys Data (getDeployBucketData)

- **Status:** REAL/LIVE
- **Database:** agents/data/coordination/coordination.db (deploy_queue, deploy_batches tables)
- **Verified Data:** 100 deploy items (all completed status), batch tracking with saved operations calculation
- **Implementation:** SQLite status aggregation with batch counting

### 8. TimeSeries Data (getTimeSeriesHistory)

- **Status:** REAL/LIVE
- **Database:** agents/data/memory/telemetry.db (time_series table)
- **Verified Data:** 500 time series points stored (auto-truncated to last 500)
- **Implementation:** SQLite queries with JSON parsing and reverse ordering

### 9. Sessions Data (getSessionHistory, buildSessionTelemetry)

- **Status:** REAL/LIVE
- **Databases:**
  - agents/data/memory/telemetry.db (session_history table)
  - agents/data/memory/session.db (sessions, agents, skills, patterns, routing_decisions, deploys tables)
  - agents/data/memory/model_analytics.db (task_outcomes grouped by date for historical reconstruction)
- **Verified Data:**
  - 1 active session in telemetry
  - 20 agents in session.db
  - Historical sessions reconstructed from analytics data
  - Token I/O: 42,914 tokens in, 6,491 tokens out total
- **Implementation:** Multi-database merge with deduplication and historical reconstruction

### 10. Compliance Data (getComplianceData)

- **Status:** REAL/LIVE
- **Database:** agents/data/memory/policies.db (policy_executions table with JOIN to policies)
- **Verified Data:** Table exists with proper schema, currently 0 executions (no policy blocks recorded yet)
- **Implementation:** SQLite queries with LEFT JOIN for policy names and mechanism categorization

---

## Additional Real Data Sources

### Performance Metrics (getPerformanceData)

- **Status:** REAL/LIVE
- **Source:** globalSessionStats and PerformanceMonitor in-memory tracking
- **Data:** Actual runtime metrics from MCP router session statistics and tool execution timing

### Audit Trail (getAuditData)

- **Status:** REAL/LIVE
- **Database:** agents/data/memory/policies.db (policy_executions table)
- **Implementation:** SQLite queries for recent policy enforcement decisions

---

## Code Quality Observations

1. No Mock Data Patterns: Searched codebase for mock, fake, dummy, stub, placeholder - none found
2. Graceful Degradation: All database queries wrapped in try/catch with empty result fallbacks
3. Connection Pooling: Memory DB uses 5-second TTL caching to prevent excessive open/close cycles
4. Subprocess Caching: Git and Docker commands cached for 30 seconds to avoid redundant subprocess calls
5. Multi-Source Merging: Session history intelligently merges data from 3 different databases with deduplication
6. Schema Validation: All queries check table existence before querying
7. Read-Only Mode: Historical databases opened in read-only mode where appropriate

---

## Database File Verification Summary

| Database Path                            | Size   | Status           |
| ---------------------------------------- | ------ | ---------------- |
| agents/data/memory/telemetry.db          | 360 KB | Exists with data |
| agents/data/memory/session.db            | 52 KB  | Exists with data |
| agents/data/memory/model_analytics.db    | 160 KB | Exists with data |
| agents/data/memory/policies.db           | 88 KB  | Exists with data |
| agents/data/memory/short_term.db         | 524 KB | Exists with data |
| agents/data/coordination/coordination.db | 148 KB | Exists with data |
| .uap/tasks/tasks.db                      | 108 KB | Exists with data |
| .uap/worktree_registry.db                | 32 KB  | Exists with data |

---

## Conclusion

VERIFICATION COMPLETE: All 10 dashboard data sources are confirmed to use REAL/LIVE data. The dashboard provides genuine telemetry and operational visibility into the UAP system with:

- Zero mock or fabricated data
- Direct database queries to SQLite files
- Live subprocess execution for git/Docker status
- Real-time in-memory metrics from runtime systems
- Filesystem enumeration for policy files and skills
- Multi-source data merging with proper deduplication

The dashboard accurately reflects the actual state of the Universal Agent Protocol system.
