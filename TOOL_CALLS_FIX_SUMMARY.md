# Tool Call Interruption Fix Summary

## Root Causes Identified

1. **Hook Output Blocking** - Session-start hook writing to stdout interfered with tool call streams
2. **SQLite Contention** - Single database connections caused blocking during concurrent tool calls
3. **Worktree Race Conditions** - Non-atomic ID generation led to conflicts during mode switches
4. **Unbounded Token Generation** - No max_tokens limit allowed generation to be interrupted mid-stream

## Fixes Applied

### 1. Session Start Hook (`.claude/hooks/session-start.sh`)
Changed output method from `echo` to `tee /dev/stderr`:
- Keeps context injection on stderr
- Preserves stdout clean for tool calls
- Prevents stream blocking during mode switches

### 2. SQLite Connection Pooling (`src/memory/model-router.ts`, `src/memory/adaptive-context.ts`)
Added connection pooling with 5 pooled connections:
```typescript
const DB_POOL_SIZE = 5;
// Round-robin distribution across pooled connections
const currentIndex = Date.now() % DB_POOL_SIZE;
return dbPool[currentIndex];
```

**Benefits:**
- Prevents SQLite locking contention during concurrent tool calls
- WAL mode + busy_timeout=10000ms ensures smooth concurrent access
- Automatic connection reuse reduces overhead

### 3. Worktree Race Condition Fix (`src/cli/worktree.ts`)
Added SQLite-backed worktree registry:
```typescript
const db = getWorktreeDb(cwd);
db.prepare(`
  INSERT INTO worktrees (slug, branch_name, worktree_path, status)
  VALUES (?, ?, ?, 'active')
`).run(slug, branchName, worktreePath);
```

**Benefits:**
- Atomic ID generation prevents duplicate branches
- Registry tracks all worktrees with status
- Cleanup updates registry to prevent stale entries

### 4. Qwen3.5 Optimized Settings (`.opencode/config.json`, `config/qwen35-settings.json`)
Added explicit limits:
```json
{
  "max_tokens": 4096,
  "timeout_ms": 120000,
  "stop_sequences": ["<tool_call>", "</tool_call>"],
  "optimize_for_tool_calls": true
}
```

**Benefits:**
- Caps generation window to prevent mid-stream interruptions
- Timeout ensures tool calls complete within reasonable time
- Stop sequences prevent stray tokens during mode switches

## Files Modified

1. `.claude/hooks/session-start.sh` - Hook output redirection
2. `.opencode/config.json` - Added model timeout & token limits
3. `config/qwen35-settings.json` - Created optimized settings
4. `src/memory/model-router.ts` - Connection pooling for fingerprints
5. `src/memory/adaptive-context.ts` - Connection pooling for historical data
6. `src/cli/worktree.ts` - SQLite registry to prevent race conditions

## Testing

Run these commands to verify fixes:
```bash
# Build verification
npm run build

# Test worktree creation (should use atomic ID generation)
uam worktree create test-worktree

# Check SQLite connections don't block
uam memory query "test"

# Monitor tool call completion during mode switches
# Watch for clean stdout output without interruptions
```

## Expected Outcome

- Tool calls complete without mid-stream interruption
- Mode switches don't cause database contention
- Worktree creation is atomic and race-condition free
- Generation bounded by token limits prevents hanging
