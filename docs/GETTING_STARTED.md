# UAP - Universal Agent Protocol

> **Version:** 1.20.32  
> **Last Updated:** 2026-04-08  
> **License:**

**Universal Agent Protocol (UAP)** is an open protocol that enables AI agents to maintain persistent context, learn from past interactions, and apply proven patterns across tasks.

---

## Core Capabilities

1. **Persistent Memory**: Store and retrieve information across sessions with 4-layer architecture
2. **Pattern Application**: Leverage 58+ battle-tested workflows and decision frameworks
3. **Multi-Agent Coordination**: Coordinate work between agents to prevent conflicts
4. **CI/CD Optimization**: Reduce pipeline costs by 50-80% through intelligent batching
5. **MCP Integration**: Achieve 98% token reduction via meta-tool routing

### Quick Start

```bash
# Install UAP CLI
npm install -g universal-agent-protocol

# Initialize in your project
uap init

# Create a tracked task
uap task create "Implement feature X"

# Use worktree for safe development
uap worktree create feature-name
cd .worktrees/NNN-feature-name/
# Make changes...
uap worktree pr <id>
```

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Optional: Docker (for Qdrant semantic search)

---

## Architecture

### System Overview

UAP implements a **4-layer memory architecture** combined with multi-agent coordination:

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent Layer                           │
│            (Claude, Factory.AI, OpenCode, etc.)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    UAP Core Layer                           │
│  CLI │ Memory │ Coordination │ Task │ Deploy Batcher        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   │
│  CLI │ Memory │ Coordination │ Task │ Deploy Batcher        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    │  CLI │ Memory │ Coordination │ Task │ Deploy Batcher        │
──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Storage Layer                         │
│  SQLite (Working) │ Qdrant (Semantic) │ Git (History)       │	─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component           | Purpose                      | Impact                   |
| ------------------- | ---------------------------- | ------------------------ |
| **Memory System**   | 4-layer persistent context   | 10x retention            |
| ination\*\*         | Multi-agent sync via SQLite  | Zero conflicts           |
| **Task Management** | Structured workflow tracking | Full lifecycle           |
| **Deploy Batcher**  | CI/CD optimization           | 50-80% savings           |
| **MCP Router**      | Meta-tool routing            | 98% token reduction      |
| Worktrees\*\*       | Safe isolated development    | No main branch pollution |

---

## Reference

### CLI Commands

#### Task Management

```bash
# Create and track tasks
uap task create "Fix bug" --priority high
uap task list --active
uap task complete --reason "Fixed"
```

#### Memory Operations

```bash
# Store and query memories
uap memory store "Best practice: validate inputs"
uap memory query "authentication" --top-k 5
uap memory status
```

#### Worktree Workflow

```bash
# Safe isolated development
uap worktree create feature-name
cd .worktrees/NNN-feature-name/
ges...
uap worktree pr <id>
uap worktree cleanup <id>  # After merge
```

#### Compliance

```bash
# Verify protocol compliance
uap compliance check
uap hooks install all
```

### Database Schema

UAP uses SQLite for structured data and Qdrant for semantic search:

**SQLite Tables:**

- `memories` - Short-term working memory (50 entries)
- `session_memories` - Current session state
- `entities/relationships` - Knowledge graph
- `agent_registry` - Multi-agent coordination
- `deploy_queue` - CI/CD batching queue

**Qdrant Collections:**

- `agent_memory` - Semantic embeddings (384-dim vectors)
- `agent_patterns` - Pattern library indexing

---

## Deployment

### Production Setup

```bash
# Start Qdrant for semantic search
cd agents && docker-compose up -d

# Install hooks
uap hooks install all

# Verify setup
uap task ready
```

### CI/CD Integration

UAP integrates with GitHub Actions via the DeployBatcher:

```yaml
name: UAP CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run UAP benchmarks
        run: npm run benchmark:full
```

### Model Providers

| Provider              | Use Case          | Configuration           |
| --------------------- | ----------------- | ----------------------- |
| **Qwen3.5**           | General tasks     | Default, cost-effective |
| **Claude Opus**       | Complex reasoning | High-accuracy scenarios |
| **GPT-4**             | Analysis tasks    | Code generation         |
| **Local (llama.cpp)** | Privacy-focused   | Self-hosted deployments |

---

## Benchmarks

### Performance Summary

| Metric           | Baseline | UAP v1.18 | Improvement |
| ---------------- | -------- | --------- | ----------- |
| **Success Rate** | 75%      | **100%**  | +25pp       |
| **Tokens/Task**  | 52K      | **23.4K** | -55%        |
| **Time/Task**    | 45s      | **32s**   | -29%        |
| **Error Rate**   | 12%      | **0%**    | -100%       |

### Full Benchmark Suite

Run the complete benchmark suite:

```bash
# Quick test (10 tasks)
npm run benchmark:short

# Full validation (14 tasks)
npm run benchmark:full

# Overnight extended run
npm run benchmark:overnight
```

Results are documented in [COMPREHENSIVE_BENCHMARKS.md](benchmarks/COMPREHENSIVE_BENCHMARKS.md).

## Operations

### Troubleshooting

| Issue                      | Solution                               |
| -------------------------- | -------------------------------------- |
| `Qdrant connection failed` | `cd agents && docker-compose up -d`    |
| `Worktree already exists`  | `uap worktree cleanup <id>`            |
| Memory DB locked`          | Close other processes using the DB     |
| `Compliance check failed`  | Review specific gate failure in output |

### Debug Mode

```bash
# Enable verbose logging
export UAP_VERBOSE=true

# Check memory queries
uap task ready --verbose

# Inspect database directly
sqlite3 ./agents/data/memory/short_term.db ".tables"
```

---

## Contributing

### Development Setup

```bash
git clone https://github.com/DammianMiller/universal-agent-protocol.git
cd universal-agent-protocol
npm install
npm run build
npm test
```

### Worktree Workflow

All changes must be made in a worktree:

```bash
# Create worktree for your feature
uap worktree create feature-description

# Make changes, commit, create PR
cd .worktrees/NNN-feature-description/
git add -A && git commit -m "feat: description"
uap worktree pr <id>

# After merge, cleanup is mandatory
uap worktree cleanup <id>
```

---

## License

MIT License - See [LICENSE](../LICENSE) file

---

<div align="center">

**Maintained by:** UAP Team  
**Repository:** https://github.com/DammianMiller/universal-agent-protocol  
**Issues:** https://github.com/DammianMiller/universal-agent-protocol/issues
306 lines)
