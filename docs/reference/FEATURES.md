# UAP Feature Reference

The Universal Agent Protocol (UAP) is a framework for building high-reliability AI agents with persistent memory, multi-agent coordination, and strict policy enforcement.

## 1. Memory System
UAP implements a 4-layer hierarchical memory architecture designed to balance retrieval speed with long-term persistence.

### Memory Layers
- **L1: Working Memory**: Short-term buffer for the current turn (SQLite).
- **L2: Session Memory**: Persistent state for the current session (SQLite).
- **L3: Semantic Memory**: Long-term vector storage for lessons and facts (Qdrant).
- **L4: Knowledge Graph**: Entity-relationship mapping for complex domain knowledge (SQLite).

### Key Capabilities
- **Adaptive Context**: Dynamically prunes and compresses context based on query complexity.
- **Semantic Compression**: Extracts atomic facts to reduce token usage while preserving meaning.
- **Hierarchical Tiering**: Automatically promotes/demotes memories between Hot, Warm, and Cold tiers based on access frequency and time-decay.
- **Write Gate**: A quality filter that scores new memories before they are persisted.

## 2. Multi-Agent Coordination
UAP enables multiple agents to work in parallel without overlapping or conflicting.

### Coordination Mechanisms
- **Work Claims**: Agents claim specific files or modules to prevent concurrent edits.
- **Announcements**: A broadcast system for agents to signal their current focus.
- **Overlap Detection**: The Coordination Service detects when two agents claim the same resource.
- **Deploy Batching**: Squashes and parallelizes deployment actions (commits, pushes, merges) to prevent "deploy storms."

## 3. Policy Engine
A middleware-based system that enforces operational constraints.

### Enforcement Logic
- **Policy Gate**: A central middleware that intercepts tool calls and validates them against active policies.
- **Enforcers**: Python-based validation scripts (e.g., \`worktree_required.py\`) that check the actual system state.
- **Compliance Levels**:
    - **REQUIRED**: Blocks execution on violation.
    - **RECOMMENDED**: Logs violation but allows execution.
    - **OPTIONAL**: Informational only.

## 4. MCP Router
A meta-router that replaces hundreds of individual tool definitions with two primary tools.

### Core Tools
- \`discover_tools\`: Uses fuzzy search to find tools across all configured MCP servers.
- \`execute_tool\`: Routes the execution request to the appropriate backend server.

### Token Optimization
- **Output Compression**: The \`OutputCompressor\` strips redundant metadata and large, repetitive blocks from tool responses, reducing token consumption by up to 98%.

## 5. Model Routing
A 3-tier architecture for optimal model selection.

### Execution Tiers
- **Task Planner**: Decomposes high-level goals into a sequence of subtasks.
- **Model Router**: Assigns the most cost-effective model (Opus, Sonnet, Haiku) based on subtask complexity.
- **Task Executor**: Executes the subtask with dynamic temperature and rate limiting.

## 6. Pattern System
A library of 23 battle-tested execution patterns (P-codes) derived from Terminal-Bench 2.0.

### Critical Patterns
- **P12 (Output Existence)**: Mandatory verification that output files were actually created.
- **P35 (Decoder-First)**: Mandatory analysis of the problem format before implementation.

## 7. Worktree System
Isolated git environments for every agent.

- **Isolation**: Every agent operates in \`.worktrees/NNN-slug/\`.
- **Strict Enforcement**: The system blocks any edits made in the project root.
