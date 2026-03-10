# UAP CLI Reference

**Complete command reference for Universal Agent Protocol**

---

## Quick Start

```bash
# Initialize UAP in existing project
uap init

# Create a new task with memory tracking
uap task create --title "Add user authentication" --type feature

# Query past decisions
uap memory query "authentication patterns"

# Create worktree for parallel development
uap worktree create add-api-endpoints
```

---

## Command Reference

### `uap init`

Initialize UAP in your project.

```bash
uap init [options]
```

**Options:**

- `--interactive, -i` - Run interactive setup wizard
- `--force, -f` - Overwrite existing configuration
- `--skip-qdrant` - Skip Qdrant setup (use SQLite only)
- `--skip-hooks` - Skip session hook installation

**Example:**

```bash
uap init --interactive
```

---

### `uap task`

Task creation and management with memory integration.

#### `uap task create`

Create a new tracked task.

```bash
uap task create --title "<name>" --type <task|bug|feature> [options]
```

**Options:**

- `--priority, -p` - Priority level: low, medium, high, critical
- `--estimate` - Estimated time in minutes
- `--depends` - Task ID this task depends on
- `--label, -l` - Add label (can be specified multiple times)

**Example:**

```bash
uap task create --title "Fix login timeout bug" --type bug --priority high
uap task create --title "Add OAuth support" --type feature --label auth --label v2.0
```

#### `uap task list`

List all tasks with optional filters.

```bash
uap task list [options]
```

**Options:**

- `--status, -s` - Filter by status: pending, in_progress, completed, blocked
- `--type, -t` - Filter by type: task, bug, feature
- `--priority, -p` - Filter by priority
- `--json` - Output as JSON

**Example:**

```bash
uap task list --status in_progress
uap task list --type bug --priority high --json
```

#### `uap task update`

Update task status or details.

```bash
uap task update <task-id> [options]
```

**Options:**

- `--status, -s` - New status
- `--priority, -p` - New priority
- `--label, -l` - Add label
- `--remove-label, -R` - Remove label
- `--comment, -c` - Add comment

**Example:**

```bash
uap task update abc123 --status in_progress
uap task update def456 --comment "Blocked waiting on API key"
```

#### `uap task ready`

Initialize session with memory context (run at start of agent session).

```bash
uap task ready [options]
```

**Options:**

- `--verbose, -v` - Show detailed memory queries
- `--quiet, -q` - Suppress all output except errors

**Output:**

```
=== UAP SESSION INITIALIZED ===
Current Task: abc123 - Fix login timeout bug
Recent Memories: 5 relevant decisions found
Past Failures: 2 similar bugs resolved
Active Patterns: P13, P26, P32
```

---

### `uap memory`

Memory storage and retrieval operations.

#### `uap memory store`

Store a new memory entry.

```bash
uap memory store "<text>" [options]
```

**Options:**

- `--type, -t` - Memory type: decision, pattern, lesson, failure
- `--tags, -T` - Comma-separated tags

**Example:**

```bash
uap memory store "Always validate CSRF tokens in auth flows" --type decision --tags security,auth
uap memory store "Docker container timeout at 300s - increase to 600s" --type lesson --tags docker
```

#### `uap memory query`

Search memories using semantic search.

```bash
uap memory query "<query>" [options]
```

**Options:**

- `--top-k, -k` - Number of results (default: 5)
- `--threshold, -t` - Minimum similarity score (0-1, default: 0.35)
- `--type, -t` - Filter by memory type
- `--tags, -T` - Filter by tags

**Example:**

```bash
uap memory query "authentication errors" --top-k 10
uap memory query "performance optimization" --threshold 0.5
```

#### `uap memory clear-session`

Clear session-specific memories.

```bash
uap memory clear-session [session-id]
```

**Example:**

```bash
uap memory clear-session current
```

---

### `uap worktree`

Worktree management for isolated development.

#### `uap worktree create`

Create a new worktree with automatic branch naming.

```bash
uap worktree create <slug> [options]
```

**Options:**

- `--from, -f` - Base branch (default: main)
- `--description, -d` - Worktree description

**Example:**

```bash
uap worktree create add-rate-limiting
uap worktree create hotfix-auth-bug --from develop
```

#### `uap worktree pr`

Create a pull request for the current worktree.

```bash
uap worktree pr <worktree-id> [options]
```

**Options:**

- `--title, -t` - PR title
- `--body, -b` - PR body file or text
- `--base, -B` - Target branch (default: main)

**Example:**

```bash
uap worktree pr 123 --title "Add rate limiting to API"
uap worktree pr 123 --body PR_BODY.md
```

#### `uap worktree cleanup`

Remove merged worktrees.

```bash
uap worktree cleanup <worktree-id> [options]
```

**Options:**

- `--force, -f` - Skip confirmation prompt

**Example:**

```bash
uap worktree cleanup 123 --force
```

#### `uap worktree list`

List all active worktrees.

```bash
uap worktree list [options]
```

**Options:**

- `--json` - Output as JSON

---

### `uap hooks`

Session hook management for persistent memory.

#### `uap hooks install`

Install session hooks for automatic memory tracking.

```bash
uap hooks install [options]
```

**Options:**

- `--platform, -p` - Platform: claude-code, factory, vscode, opencode
- `--force, -f` - Overwrite existing hooks

**Example:**

```bash
uap hooks install --platform claude-code
```

#### `uap hooks uninstall`

Remove session hooks.

```bash
uap hooks uninstall [options]
```

**Options:**

- `--all` - Remove all platform hooks

---

### `uap compliance`

Protocol compliance checking and verification.

#### `uap compliance check`

Run all compliance checks.

```bash
uap compliance check [options]
```

**Options:**

- `--verbose, -v` - Show all checks including passed
- `--fail-fast` - Stop on first failure
- `--json` - Output as JSON

**Output:**

```
=== UAP COMPLIANCE CHECK ===
[✓] CLAUDE.md present and valid
[✓] .uam.json configuration exists
[✓] Memory database accessible
[✓] Worktree workflow enforced
[✓] No direct commits to main
[✓] All outputs verified with ls -la
[✓] Schema matches test expectations
[✓] Tests run 3+ times minimum
[✓] CLI tested as ./script
[✓] Critical files backed up
[✓] Decoder round-trip passes
[✓] Recovery artifacts copied

=== COMPLIANCE SCORE: 12/12 (100%) ===
```

#### `uap compliance report`

Generate detailed compliance report.

```bash
uap compliance report [options]
```

**Options:**

- `--output, -o` - Output file path
- `--format, -f` - Format: text, markdown, json

---

### `uap coordination`

Multi-agent collaboration tools.

#### `uap coordination check`

Check for overlapping work between agents.

```bash
uap coordination check --agents <agent1,agent2,...> [options]
```

**Options:**

- `--verbose, -v` - Show detailed overlap analysis
- `--json` - Output as JSON

#### `uap coordination resolve`

Resolve identified overlaps.

```bash
uap coordination resolve <overlap-id> --action <assign|merge|delegate>
```

---

### `uap skill`

Skill management and loading.

#### `uap skill list`

List available skills.

```bash
uap skill list [options]
```

**Options:**

- `--category, -c` - Filter by category
- `--json` - Output as JSON

#### `uap skill load`

Load a specific skill for current session.

```bash
uap skill load <skill-name> [options]
```

**Example:**

```bash
uap skill load chess-engine
uap skill load compression --category optimization
```

---

### `uap agent`

Agent status and management.

#### `uap agent status`

Show current agent status.

```bash
uap agent status [options]
```

**Options:**

- `--verbose, -v` - Show detailed memory stats
- `--json` - Output as JSON

---

### `uap generate`

Generate CLAUDE.md from template.

```bash
uap generate [options]
```

**Options:**

- `--force, -f` - Overwrite existing CLAUDE.md
- `--template, -t` - Custom template path
- `--sections` - Comma-separated section list to include

**Example:**

```bash
uap generate --force
uap generate --sections memorySystem,worktreeWorkflow,troubleshooting
```

---

## Environment Variables

| Variable             | Description                  | Default                              |
| -------------------- | ---------------------------- | ------------------------------------ |
| `UAP_VERBOSE`        | Enable verbose logging       | `false`                              |
| `UAP_DB_PATH`        | Custom database path         | `./agents/data/memory/short_term.db` |
| `UAP_QDRANT_URL`     | Qdrant endpoint              | `localhost:6333`                     |
| `UAP_DEFAULT_BRANCH` | Default worktree base branch | `main`                               |

---

## Exit Codes

| Code | Meaning                   |
| ---- | ------------------------- |
| 0    | Success                   |
| 1    | General error             |
| 2    | Invalid arguments         |
| 3    | Configuration error       |
| 4    | Memory operation failed   |
| 5    | Worktree operation failed |
| 6    | Compliance check failed   |

---

## Shell Completion

Enable tab completion for your shell:

```bash
# Bash
echo 'eval "$(_UAP_COMPLETE=bash_source uap)"' >> ~/.bashrc

# Zsh
echo 'eval "$(_UAP_COMPLETE=zsh_source uap)"' >> ~/.zshrc

# Fish
_uap_complete_fish | source
```

---

## Examples

### Complete Development Workflow

```bash
# 1. Initialize project
uap init --interactive

# 2. Create task
uap task create --title "Implement user registration" --type feature --priority high

# 3. Start session with memory
uap task ready

# 4. Create worktree for changes
uap worktree create implement-user-registration

# 5. Make changes, commit
cd .worktrees/NNN-implement-user-registration/
git add -A && git commit -m "feat: add user registration endpoint"

# 6. Create PR
uap worktree pr 123 --title "Add user registration API"

# 7. Store lessons learned
uap memory store "User validation must check email format before DB insert" \
  --type decision --tags auth,validation

# 8. After merge, cleanup
uap worktree cleanup 123 --force

# 9. Verify compliance
uap compliance check
```

### Memory-Enhanced Debugging

```bash
# 1. Start with memory context
uap task ready --verbose

# 2. Query similar past failures
uap memory query "database connection timeout" --top-k 5

# 3. Apply pattern P26 (same error twice = change approach)
# 4. Fix and test
# 5. Store solution
uap memory store "Connection pool exhaustion fixed by increasing maxPoolSize from 10 to 50" \
  --type lesson --tags database,performance
```

---

## Troubleshooting

### Common Issues

| Error                      | Solution                                |
| -------------------------- | --------------------------------------- |
| `command not found: uap`   | Ensure npm global bin is in PATH        |
| `Database locked`          | Close other processes using the DB      |
| `Qdrant connection failed` | Run `cd agents && docker-compose up -d` |
| `Worktree already exists`  | Use `uap worktree cleanup <id>` first   |
| `Compliance check failed`  | Review specific gate failure in output  |

### Debug Mode

```bash
# Enable verbose logging
export UAP_VERBOSE=true

# Check database contents
sqlite3 ./agents/data/memory/short_term.db "SELECT * FROM memories ORDER BY id DESC LIMIT 5;"

# Inspect session state
sqlite3 ./agents/data/memory/short_term.db "SELECT * FROM session_memories WHERE session_id='current';"
```

---

For more information, see [UAP Overview](./UAP_OVERVIEW.md) or visit the [GitHub repository](https://github.com/DammianMiller/universal-agent-protocol).
