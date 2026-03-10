# UAP - Universal Agent Protocol

**A persistent memory system for autonomous AI agents**

UAP (Universal Agent Protocol) provides a standardized framework for AI agents to maintain persistent context, learn from past interactions, and apply proven patterns across tasks.

---

## What is UAP?

UAP is an open protocol that enables AI agents to:

1. **Remember Context**: Store and retrieve relevant information across sessions
2. **Apply Patterns**: Leverage battle-tested workflows and decision frameworks
3. **Maintain State**: Track progress, failures, and successes over time
4. **Collaborate**: Coordinate with other agents using shared memory

Unlike temporary context windows, UAP provides **persistent memory** that survives session boundaries, enabling true long-term learning and improvement.

---

## Core Components

### 1. Memory System (4-Layer Architecture)

| Layer | Type                        | Purpose                             | Speed |
| ----- | --------------------------- | ----------------------------------- | ----- |
| L1    | SQLite (`memories`)         | Working context, recent decisions   | <1ms  |
| L2    | SQLite (`session_memories`) | Current task session state          | <5ms  |
| L3    | Qdrant (vector DB)          | Semantic search across all memories | ~50ms |
| L4    | SQLite (entities/rels)      | Knowledge graph of relationships    | <20ms |

### 2. CLAUDE.md Protocol

Every UAP-enabled project includes a `CLAUDE.md` file that defines:

- **Directive Hierarchy**: Which rules take precedence
- **Decision Loop**: Standard workflow for any task
- **Patterns**: 58+ battle-tested patterns for common scenarios
- **Skills**: Domain-specific expertise (chess, compression, debugging)
- **Completion Gates**: Mandatory checks before declaring success

### 3. CLI Tools

```bash
# Initialize UAP in a project
uap init

# Create a tracked task with memory
uap task create --title "Fix login bug" --type bug

# Query semantic memory
uap memory query "authentication errors"

# Manage worktrees for parallel development
uap worktree create fix-auth-issue
```

### 4. Worktree Workflow

UAP enforces a **worktree-only** workflow to prevent accidental changes to main branches:

```bash
# Create worktree for any change (even single file)
uap worktree create bugfix-description

# Make changes, commit, create PR
cd .worktrees/NNN-bugfix-description/
git add -A && git commit -m "type: description"
uap worktree pr 123

# After merge, cleanup is mandatory
uap worktree cleanup 123
```

---

## How It Works

### Task Execution Flow

```
1. CLASSIFY → Is this complex? Does it need memory?
2. PROTECT   → Backup critical files (configs, DBs)
3. MEMORY    → Query relevant context + past failures
4. SKILLS    → Load domain-specific patterns if needed
5. WORK      → Implement using worktree
6. REVIEW    → Self-review diff before testing
7. TEST      → Run verifier/tests minimum 3 times
8. LEARN     → Store outcome in memory for future tasks
```

### Memory Retrieval

When starting a task, UAP automatically:

1. **Classifies** the task type (coding, debugging, research, etc.)
2. **Queries** L1/L2 memory for recent relevant decisions
3. **Searches** L3 semantic memory for similar past tasks
4. **Loads** L4 knowledge graph for entity relationships
5. **Applies** patterns based on classification confidence

### Pattern Router

UAP includes 58+ patterns for common scenarios:

| Pattern ID | Trigger                 | Action                              |
| ---------- | ----------------------- | ----------------------------------- |
| P3         | Modifies config/DB      | `cp file file.bak` first            |
| P12        | Creates files           | `ls -la` verify all outputs exist   |
| P13        | Tests partial pass      | Fix specific failure, re-run        |
| P26        | Same error twice        | Change approach completely          |
| P32        | CLI tool                | Test `./script` not `python script` |
| P37        | Output format specified | Diff output schema vs expectations  |

---

## Installation

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Optional: Docker (for Qdrant semantic search)

### Quick Start

```bash
# Install globally
npm install -g universal-agent-protocol

# Initialize in your project
uap init

# Run the interactive setup
npx universal-agent-protocol init --interactive
```

### With Qdrant (Recommended for Full Features)

```bash
cd agents && docker-compose up -d
```

---

## Configuration

### `.uap.json` - Project Settings

```json
{
  "project": {
    "name": "my-project",
    "description": "Project with UAP memory"
  },
  "memory": {
    "shortTerm": {
      "enabled": true,
      "path": "./agents/data/memory/short_term.db"
    },
    "longTerm": {
      "enabled": true,
      "provider": "qdrant",
      "endpoint": "localhost:6333"
    }
  },
  "worktrees": {
    "enabled": true,
    "directory": ".worktrees"
  }
}
```

---

## Best Practices

### DO ✅

- Use `uap task create` for all work items
- Always use worktrees (never commit to main directly)
- Run verifier/tests minimum 3 times before declaring done
- Store outcomes in memory after completing tasks
- Load relevant skills for domain-specific tasks

### DON'T ❌

- Commit directly to main/develop branches
- Skip backup steps when modifying critical files
- Declare success without running tests multiple times
- Ignore pattern recommendations (they prevent bugs)
- Leave merged worktrees uncleand

---

## Protocol Compliance

UAP enforces **completion gates** before any task is considered done:

```
[x] If decoder provided: round-trip passes (BLOCKING)
[x] Outputs verified: ls -la shows all files exist
[x] Schema diffed against test expectations
[x] Tests: X/Y pass (must be 100%, run 3+ times)
[x] CLI tools tested as ./script not python script
[x] If recovery: artifacts copied before read operation
```

Run compliance check:

```bash
npm run verify-uap
# or
uap compliance check
```

---

## Integration Points

### Claude Code

UAP integrates with Anthropic's Claude Code via session hooks:

```bash
uap hooks install
```

This adds automatic memory queries at task start and outcome storage on completion.

### Factory.AI

UAP provides skills for Factory.AI droids:

- `@Skill:chess-engine.md` - Chess pattern matching
- `@Skill:compression.md` - Information-theoretic limits
- `@Skill:adversarial.md` - Security vulnerability analysis
- `@Skill:git-forensics.md` - Repository recovery

### Multi-Agent Coordination

UAP detects overlapping work between agents via:

```bash
uap coordination check --agents agent1,agent2,agent3
```

This prevents duplicate effort and identifies collaboration opportunities.

---

## API Reference

### Memory Operations

```typescript
// Store a memory
await uap.memory.store('Always validate CSRF tokens in auth flows');

// Query memories
const results = await uap.memory.query('authentication security', {
  topK: 5,
  scoreThreshold: 0.35,
});

// Clear session memory
await uap.memory.clearSession();
```

### Task Management

```typescript
// Create a task
const task = await uap.task.create({
  title: 'Implement rate limiting',
  type: 'feature',
  priority: 'high',
});

// Update task status
await uap.task.update(task.id, { status: 'in_progress' });

// Get task with memory context
const enrichedTask = await uap.task.get(task.id, { includeMemory: true });
```

---

## Troubleshooting

### Common Issues

| Error                      | Solution                                          |
| -------------------------- | ------------------------------------------------- |
| `ModuleNotFoundError`      | Run `npm install` after cloning                   |
| `Qdrant connection failed` | Start Docker: `cd agents && docker-compose up -d` |
| `Worktree already exists`  | Use `uap worktree cleanup <id>` first             |
| `Memory DB locked`         | Close other processes using the DB                |
| `Compliance check failed`  | Review specific gate failure in output            |

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

UAP is open source. Contributions welcome:

1. Fork the repository
2. Create a worktree: `uap worktree create feature-name`
3. Make changes and run tests: `npm test`
4. Submit PR via `uap worktree pr <id>`

### Development Setup

```bash
git clone https://github.com/DammianMiller/universal-agent-protocol.git
cd universal-agent-protocol
npm install
npm run build
npm test
```

---

## License

MIT License - See [LICENSE](../LICENSE) file

**Maintained By**: UAP Team  
**Repository**: https://github.com/DammianMiller/universal-agent-protocol  
**Issues**: https://github.com/DammianMiller/universal-agent-protocol/issues
