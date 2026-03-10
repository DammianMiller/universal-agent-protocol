# Universal Agent Protocol (UAP)

[![npm version](https://img.shields.io/npm/v/universal-agent-protocol.svg)](https://www.npmjs.com/package/universal-agent-protocol)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">

### AI agents that learn and remember

**Every lesson, every pattern, every memory preserved across sessions.**

_Not just in one conversation—but forever._

</div>

---

## Quick Start (30 seconds)

```bash
# Install
npm install -g universal-agent-protocol

# Run complete setup (installs dependencies, git hooks, etc.)
npm run setup

# Initialize in your project
uap init
```

That's it. Your AI now has persistent memory and follows proven workflows.

---

## Complete Setup

For a full installation with all features:

```bash
# Install UAP CLI
npm install -g universal-agent-protocol

# Run comprehensive setup
npm run setup
# This will:
# ✓ Check and install dependencies
# ✓ Install npm packages
# ✓ Build TypeScript
# ✓ Configure git hooks (pre-commit, commit-msg, pre-push)
# ✓ Set up GitHub PR templates
```

### Requirements

**Required:**

- Node.js >= 18.0.0
- npm
- git
- npx

**Optional (recommended):**

- Docker - for local Qdrant semantic search
- Python 3 - for Pattern RAG indexing
- pre-commit - for advanced git hooks

### Installing Dependencies

**macOS:**

```bash
brew install node git python docker
```

**Ubuntu/Debian:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3 docker.io
```

**Windows:**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Python.Python.3.12
winget install Docker.DockerDesktop
```

---

## Recommended Platform: **opencode**

UAP is optimized for **[opencode](https://opencode.ai)** - the local AI coding platform that provides:

- **Persistent sessions** - Memory survives across sessions
- **Plugin architecture** - Pattern RAG, session hooks, and more
- **Local LLM support** - Run Qwen3.5 35B locally via llama.cpp
- **Built-in tooling** - File operations, bash, search, todo management

### Setup opencode (Recommended)

```bash
# Install opencode
npm install -g opencode

# Configure local LLM (optional, requires llama.cpp server)
# See: https://opencode.ai/docs/configuration

# Initialize UAP in your project
cd your-project
uap init
```

The `opencode.json` configuration file automatically loads UAP plugins for:

- **Pattern RAG** - Context-aware pattern injection (~12K tokens saved)
- **Session hooks** - Pre-execution setup, memory preservation
- **Agent coordination** - Multi-agent workflows without conflicts

### Other Supported Platforms

| Platform        | Notes                                   |
| --------------- | --------------------------------------- |
| **Factory.AI**  | Works well, use `CLAUDE.md` for context |
| **Claude Code** | Desktop app, full UAP support           |
| **VSCode**      | Use with Claude Code extension          |
| **claude.ai**   | Web version, limited tooling            |

---

## What UAP Gives You

### 🧠 Persistent Memory

Your AI never forgets:

```bash
# Store a lesson
uap memory store "Always validate CSRF tokens in auth flows"

# Query later (any agent, any session)
uap memory query "auth security"
```

Memory persists in SQLite databases that travel with your code:

- `agents/data/memory/short_term.db` - Recent actions + session memories
- Semantic search via Qdrant (optional, `uap memory start`)

### 🎯 Pattern Router

Before every task, UAP auto-selects relevant patterns:

```
=== PATTERN ROUTER ===
Task: Fix authentication bug
Classification: bug-fix
ACTIVE: P3, P12, P17
BLOCKING: [none]
=== END ===
```

**58 battle-tested patterns** from Terminal-Bench 2.0 analysis:

- **P12** - Verify outputs exist (fixes 37% of failures)
- **P17** - Extract hidden constraints ("exactly", "only", "single")
- **P3** - Backup before destructive actions
- **P20** - Attack mindset for security tasks

### 🛡️ Completion Gates

Three mandatory checks before "done":

1. **Output Existence** - All expected files exist
2. **Constraint Compliance** - All requirements verified
3. **Tests Pass** - `npm test` 100%

### 🌳 Safe Worktrees

No more accidental commits to main:

```bash
uap worktree create my-feature
# → Creates isolated branch in .worktrees/
# → All changes tracked
uap worktree pr <id>
# → Creates PR, triggers reviews
uap worktree cleanup <id>
# → Clean removal after merge
```

### 🤖 Expert Droids

Tasks automatically route to specialists:

| Task Type       | Routed To                |
| --------------- | ------------------------ |
| TypeScript/JS   | `typescript-node-expert` |
| Security review | `security-auditor`       |
| Performance     | `performance-optimizer`  |
| Documentation   | `documentation-expert`   |

---

## How It Works

1. **Install & init** - `npm i -g universal-agent-protocol && uap init`
2. **CLAUDE.md generated** - Auto-populated with project structure, commands, patterns
3. **AI reads CLAUDE.md** - Follows embedded workflows automatically
4. **Every task**:
   - Pattern Router classifies task and selects patterns
   - Adaptive context loads relevant memory
   - Agent coordination checks for conflicts
   - Worktree created for isolated changes
   - Completion gates verify outputs, constraints, tests
   - Learnings stored in memory

---

## Commands

### Essential

| Command        | Description                                      |
| -------------- | ------------------------------------------------ |
| `uap init`     | Initialize/update UAP (never loses data)         |
| `uap generate` | Regenerate CLAUDE.md from project analysis       |
| `uap update`   | Update templates while preserving customizations |

### Memory

| Command                      | Description                      |
| ---------------------------- | -------------------------------- |
| `uap memory status`          | Check memory system status       |
| `uap memory query <search>`  | Search memories                  |
| `uap memory store <content>` | Store a learning                 |
| `uap memory start`           | Start Qdrant for semantic search |

### Tasks

| Command                 | Description                            |
| ----------------------- | -------------------------------------- |
| `uap task create`       | Create tracked task                    |
| `uap task list`         | List all tasks                         |
| `uap task claim <id>`   | Claim task (announces to other agents) |
| `uap task release <id>` | Complete task                          |

### Worktrees

| Command                      | Description             |
| ---------------------------- | ----------------------- |
| `uap worktree create <name>` | Create isolated branch  |
| `uap worktree pr <id>`       | Create PR from worktree |
| `uap worktree cleanup <id>`  | Remove worktree         |

### Droids

| Command                 | Description                  |
| ----------------------- | ---------------------------- |
| `uap droids list`       | List available expert droids |
| `uap droids add <name>` | Create new expert droid      |

---

## Architecture

### 4-Layer Memory System

```
┌─────────────────────────────────────────────────────────────────┐
│  L1: WORKING      │ Recent actions       │ 50 max  │ SQLite    │
│  L2: SESSION      │ Current session      │ Per run │ SQLite    │
│  L3: SEMANTIC     │ Long-term learnings  │ Qdrant  │ Vectors   │
│  L4: KNOWLEDGE    │ Entity relationships │ SQLite  │ Graph     │
└─────────────────────────────────────────────────────────────────┘
```

### Hierarchical Memory (Hot/Warm/Cold)

- **HOT** (10 entries) - In-context, always included → <1ms access
- **WARM** (50 entries) - Cached, promoted on access → <5ms access
- **COLD** (500 entries) - Archived, semantic search → ~50ms access

### Pattern RAG

Dynamically retrieves relevant patterns from Qdrant:

- Queries `agent_patterns` collection
- Injects ~2 patterns per task (saves ~12K tokens)
- Filters by similarity score (default 0.35)
- Avoids duplicate injections per session

---

## Configuration

### opencode.json (Platform-specific)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama.cpp": {
      "name": "llama-server (local)",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "sk-qwen35b"
      },
      "models": {
        "qwen35-a3b-iq4xs": {
          "name": "Qwen3.5 35B A3B (IQ4_XS)",
          "limit": {
            "context": 262144,
            "output": 16384
          }
        }
      }
    }
  },
  "model": "llama.cpp/qwen35-a3b-iq4xs"
}
```

### .uap.json (Project-specific)

```json
{
  "project": {
    "name": "my-project",
    "defaultBranch": "main"
  },
  "memory": {
    "shortTerm": { "enabled": true, "path": "./agents/data/memory/short_term.db" },
    "longTerm": { "enabled": true, "provider": "qdrant" }
  },
  "worktrees": {
    "enabled": true,
    "directory": ".worktrees"
  }
}
```

---

## Requirements

### Required Dependencies

| Dependency | Version           | Purpose                     |
| ---------- | ----------------- | --------------------------- |
| Node.js    | >= 18.0.0         | Runtime environment         |
| npm        | Latest            | Package manager             |
| git        | Latest            | Version control (git hooks) |
| npx        | Included with npm | Run CLI tools               |

### Optional Dependencies

| Dependency | Purpose                          | Installation                                   |
| ---------- | -------------------------------- | ---------------------------------------------- |
| Docker     | Local Qdrant for semantic search | [get.docker.com](https://get.docker.com)       |
| Python 3   | Pattern RAG indexing             | `brew install python` or `apt install python3` |
| pre-commit | Advanced git hooks               | `pip install pre-commit`                       |

### Platform-Specific Setup

**macOS:**

```bash
brew install node@18 git python docker
```

**Ubuntu/Debian:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3 docker.io
```

**Windows (PowerShell):**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Python.Python.3.12
winget install Docker.DockerDesktop
```

---

## Testing & Quality

```bash
# Run tests
npm test

# Run linter
npm run lint

# Build TypeScript
npm run build
```

---

## Documentation

### Core CLAUDE.md Sections

| File                     | Purpose                          |
| ------------------------ | -------------------------------- |
| `CLAUDE_ARCHITECTURE.md` | Cluster topology, IaC rules      |
| `CLAUDE_CODING.md`       | Coding standards, security       |
| `CLAUDE_WORKFLOWS.md`    | Task workflows, completion gates |
| `CLAUDE_MEMORY.md`       | Memory system, Pattern RAG       |
| `CLAUDE_DROIDS.md`       | Available droids/skills          |

### Deep Dive

| Document                                                               | Description                |
| ---------------------------------------------------------------------- | -------------------------- |
| [`docs/UAP_OVERVIEW.md`](docs/UAP_OVERVIEW.md)       | Full system architecture   |
| [`docs/UAP_CLI_REFERENCE.md`](docs/UAP_CLI_REFERENCE.md) | Universal agent patterns   |
| [`docs/BEHAVIORAL_PATTERNS.md`](docs/BEHAVIORAL_PATTERNS.md)           | What works vs what doesn't |
| [`benchmark-results/`](benchmark-results/)                             | Terminal-Bench 2.0 results |

---

## What's Next

UAP v7.1.0 includes:

- ✅ **58 Optimizations** - Battle-tested from Terminal-Bench 2.0
- ✅ **Pattern Router** - Auto-selects optimal patterns per task
- ✅ **Completion Gates** - 3 mandatory checks before "done"
- ✅ **8 Expert Droids** - Specialized agents for common tasks
- ✅ **6 Skills** - Reusable capabilities (balls-mode, CLI design, etc.)
- ✅ **Pre-execution Hooks** - Task-specific setup before agent runs
- ✅ **Hierarchical Memory** - Hot/warm/cold tiering with auto-promotion
- ✅ **Pattern RAG** - Context-aware pattern injection (~12K tokens saved)
- ✅ **opencode Integration** - Plugin system for seamless integration
- ✅ **Model Router** - Per-model performance fingerprints

---

## Attribution

Code Field prompts based on research from [NeoVertex1/context-field](https://github.com/NeoVertex1/context-field).

Terminal-Bench patterns from [Terminal-Bench 2.0](https://github.com/aptx432/terminal-bench) benchmarking.

---

<div align="center">

**[Documentation](docs/UAP_OVERVIEW.md)** · **[Issues](https://github.com/DammianMiller/universal-agent-protocol/issues)** · **[npm](https://www.npmjs.com/package/universal-agent-protocol)**

_Built for developers who want AI that learns._

</div>
