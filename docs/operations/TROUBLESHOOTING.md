# UAP Troubleshooting Guide

**Version:** 1.0.0  
**Last Updated:** 2026-03-13  
**Status:** ✅ Production Ready

---

## Executive Summary

This guide provides solutions to common UAP issues, recovery procedures, and debugging tips.

---

## 1. Memory System Issues

### 1.1 Database Not Found

**Symptoms:**

```
Error: Database not found: agents/data/memory/short_term.db
```

**Cause:** Database file missing or permissions issue

**Solution:**

```bash
# Initialize UAP to create database
uap init

# Check permissions
ls -la agents/data/memory/

# If permissions issue, fix with:
chmod 755 agents/data/memory/
```

### 1.2 FTS Index Corruption

**Symptoms:**

```
Error: FTS5 index corrupted
uap memory query returns no results
```

**Cause:** FTS5 index out of sync with memories table

**Solution:**

```bash
# Rebuild FTS index
uap init --rebuild-index

# Or manually:
sqlite3 agents/data/memory/short_term.db "REINDEX memories_fts"
```

**Verification:**

```bash
# Check index health
sqlite3 agents/data/memory/short_term.db "SELECT COUNT(*) FROM memories_fts;"

# Query should return results
uap memory query "test"
```

### 1.3 Memory Full

**Symptoms:**

```
Warning: Memory approaching limit (48/50 entries)
```

**Cause:** Short-term memory at capacity

**Solution:**

```bash
# Check memory status
uap memory status

# Clear old memories (be careful!)
sqlite3 agents/data/memory/short_term.db "DELETE FROM memories WHERE id < (SELECT MIN(id) FROM memories LIMIT 10);"

# Or use UAP command
uap memory cleanup --keep 30
```

### 1.4 Qdrant Connection Failed

**Symptoms:**

```
Error: Qdrant connection failed: Connection refused
```

**Cause:** Qdrant not running or wrong configuration

**Solution:**

```bash
# Start Qdrant
uap memory start

# Check if running
docker ps | grep qdrant

# Or check port
netstat -tlnp | grep 6333

# Test connection
curl http://localhost:6333
```

**Configuration Check:**

```bash
cat .uap.json | grep -A 5 "longTerm"
```

---

## 2. Hook System Issues

### 2.1 SessionStart Hook Not Running

**Symptoms:**

```
Compliance checklist not shown
UAP protocol not enforced
```

**Cause:** Hook not installed or not triggered

**Solution:**

```bash
# Check hook status
uap hooks status

# Install hooks
uap hooks install all

# Verify installation
ls -la .factory/hooks/
```

**Manual Test:**

```bash
# Run hook manually
bash .factory/hooks/session-start.sh
```

### 2.2 Hook Script Errors

**Symptoms:**

```
Error executing hook: Permission denied
```

**Cause:** Script permissions or syntax error

**Solution:**

```bash
# Fix permissions
chmod +x .factory/hooks/*.sh

# Test hook
bash -x .factory/hooks/session-start.sh

# Check for syntax errors
shellcheck .factory/hooks/session-start.sh
```

### 2.3 Hook Causes Session to Hang

**Symptoms:**

```
Session hangs at compliance checklist
Agent doesn't proceed
```

**Cause:** Hook waiting for input or infinite loop

**Solution:**

```bash
# Check hook output
cat .factory/hooks/session-start.log

# Temporarily disable hook
mv .factory/hooks/session-start.sh .factory/hooks/session-start.sh.bak

# Fix the hook script
nano .factory/hooks/session-start.sh
```

---

## 3. Worktree Issues

### 3.1 Worktree Creation Failed

**Symptoms:**

```
Error: Failed to create worktree
git: branch 'feature/...' already exists
```

**Cause:** Branch name conflict or Git issue

**Solution:**

```bash
# Check existing worktrees
uap worktree list

# Clean up stale worktrees
uap worktree cleanup <id>

# Try again
uap worktree create <name>
```

**Manual Fix:**

```bash
# Check Git branches
git branch -a

# Delete conflicting branch
git branch -D feature/<name>

# Remove worktree directory
rm -rf .worktrees/<id>-<name>/

# Retry
uap worktree create <name>
```

### 3.2 Worktree Not Pushing

**Symptoms:**

```
git push: Permission denied
fatal: The current branch has no upstream branch
```

**Cause:** Remote not configured or permissions

**Solution:**

```bash
# Check remote
git remote -v

# Add remote if missing
git remote add origin <url>

# Push manually
git push -u origin feature/<branch-name>
```

### 3.3 Worktree Cleanup Failed

**Symptoms:**

```
Error: Cannot remove worktree
branch is checked out elsewhere
```

**Cause:** Worktree in use or not properly closed

**Solution:**

```bash
# Close any sessions using worktree
# Check for locks
ls .worktrees/<id>-<name>/.git/locked

# Force cleanup
uap worktree cleanup <id> --force

# Manual cleanup
git branch -D feature/<branch-name>
rm -rf .worktrees/<id>-<name>/
```

---

## 4. Pattern Router Issues

### 4.1 Patterns Not Loading

**Symptoms:**

```
Pattern Router: No patterns loaded
PATTERN_ROUTER section missing from output
```

**Cause:** Patterns not indexed in Qdrant

**Solution:**

```bash
# Index patterns
python3 agents/scripts/index_patterns_to_qdrant.py

# Check index
uap memory status

# Verify patterns loaded
uap task run test-task 2>&1 | grep -A 5 "PATTERN ROUTER"
```

### 4.2 Wrong Patterns Selected

**Symptoms:**

```
Irrelevant patterns injected
Pattern P12 not selected for verification task
```

**Cause:** Pattern similarity threshold too low or high

**Solution:**

```bash
# Adjust threshold
cat .uap.json | jq '.memory.patternRag.scoreThreshold = 0.4'

# Or adjust top-K
cat .uap.json | jq '.memory.patternRag.topK = 3'

# Re-index patterns
python3 agents/scripts/index_patterns_to_qdrant.py
```

### 4.3 Pattern Router Slow

**Symptoms:**

```
Pattern Router taking >5 seconds
High latency on task start
```

**Cause:** Qdrant performance or large pattern collection

**Solution:**

```bash
# Optimize Qdrant
curl -X PUT http://localhost:6333/collections/agent_patterns/reload

# Check Qdrant performance
curl http://localhost:6333/collections/agent_patterns

# Restart Qdrant
uap memory stop
uap memory start
```

---

## 5. MCP Router Issues

### 5.1 Tool Calls Failing

**Symptoms:**

```
Error: Tool not found: Bash
Tool execution failed
```

**Cause:** MCP server not running or tool not registered

**Solution:**

```bash
# Check MCP server
ps aux | grep mcp-router

# Restart MCP server
uap mcp restart

# Check tool registration
curl http://localhost:8080/tools
```

### 5.2 Output Compression Not Working

**Symptoms:**

```
Large outputs not compressed
Token count higher than expected
```

**Cause:** Compression threshold or FTS5 issue

**Solution:**

```bash
# Check compression settings
cat .uap.json | jq '.mcpRouter.outputCompression'

# Adjust threshold
cat .uap.json | jq '.mcpRouter.outputCompression.threshold = 4096'

# Restart MCP
uap mcp restart
```

### 5.3 High Token Usage

**Symptoms:**

```
Token usage much higher than expected
Output compression not reducing tokens
```

**Solution:**

```bash
# Check token usage
uap stats session

# Enable verbose logging
export UAP_DEBUG=1

# Analyze output
uap stats analyze --details
```

---

## 6. Coordination Issues

### 6.1 Stale Agents in Registry

**Symptoms:**

```
Multiple agents claiming same task
Race conditions
```

**Cause:** Agent heartbeat not updated or stale entries

**Solution:**

```bash
# Check agent registry
sqlite3 agents/data/coordination/coordination.db "SELECT * FROM agent_registry;"

# Clean up stale agents (heartbeat >24h)
sqlite3 agents/data/coordination/coordination.db "
  DELETE FROM agent_registry
  WHERE status IN ('active','idle')
  AND last_heartbeat < datetime('now','-24 hours');
"

# Restart agent to update heartbeat
uap agent restart
```

### 6.2 Work Claim Conflicts

**Symptoms:**

```
Two agents working on same task
Duplicate work
```

**Cause:** Work claim not properly recorded

**Solution:**

```bash
# Check work claims
sqlite3 agents/data/coordination/coordination.db "SELECT * FROM work_claims;"

# Release conflicting claim
sqlite3 agents/data/coordination/coordination.db "
  UPDATE work_claims SET completed_at = datetime('now')
  WHERE task_id = '<task-id>' AND agent_id != '<current-agent>';
"

# Reclaim task
uap task claim <task-id>
```

---

## 7. Performance Issues

### 7.1 Slow Memory Queries

**Symptoms:**

```
uap memory query taking >1 second
High latency on memory access
```

**Solution:**

```bash
# Check database size
sqlite3 agents/data/memory/short_term.db "SELECT COUNT(*) FROM memories;"

# Optimize database
sqlite3 agents/data/memory/short_term.db "VACUUM;"

# Check index
sqlite3 agents/data/memory/short_term.db "EXPLAIN QUERY PLAN SELECT * FROM memories WHERE content MATCH 'test';"

# Rebuild index if needed
sqlite3 agents/data/memory/short_term.db "REINDEX memories_fts;"
```

### 7.2 High Memory Usage

**Symptoms:**

```
UAP using >2GB RAM
High VRAM usage
```

**Solution:**

```bash
# Check memory usage
uap memory status

# Clear cold tier
uap memory cleanup --cold

# Reduce context window
cat .uap.json | jq '.memory.shortTerm.maxEntries = 30'

# Restart UAP
uap stop
uap start
```

---

## 8. Debugging Tips

### 8.1 Enable Debug Logging

```bash
# Enable verbose logging
export UAP_DEBUG=1
export UAP_LOG_LEVEL=debug

# Run task with logging
uap task run <task-id> 2>&1 | tee debug.log

# Analyze log
grep -E "ERROR|WARN" debug.log
```

### 8.2 Check System Health

```bash
# Full system check
uap compliance check --verbose

# Check all components
uap health check

# View all statuses
uap status all
```

### 8.3 Export State for Support

```bash
# Export configuration
uap export config > config-export.json

# Export memory state
sqlite3 agents/data/memory/short_term.db ".dump > memory-export.sql"

# Export coordination state
sqlite3 agents/data/coordination/coordination.db ".dump > coordination-export.sql"

# Archive for support
tar -czf uap-debug.tar.gz \
  config-export.json \
  memory-export.sql \
  coordination-export.sql \
  debug.log
```

---

## 9. Common Error Messages

| Error                      | Cause                | Solution                                                 |
| -------------------------- | -------------------- | -------------------------------------------------------- |
| `Database not found`       | DB file missing      | Run `uap init`                                           |
| `Qdrant connection failed` | Qdrant not running   | Run `uap memory start`                                   |
| `Hook not installed`       | Hooks not installed  | Run `uap hooks install all`                              |
| `Worktree creation failed` | Branch conflict      | Clean up with `uap worktree cleanup`                     |
| `Pattern not loaded`       | Patterns not indexed | Run `python3 agents/scripts/index_patterns_to_qdrant.py` |
| `Tool not found`           | MCP server down      | Run `uap mcp restart`                                    |
| `Stale agent detected`     | Heartbeat expired    | Agent auto-cleanup or manual cleanup                     |

---

## 10. Getting Help

### 10.1 Documentation

- **Full docs:** `docs/` directory
- **CLI help:** `uap --help`
- **Command help:** `uap <command> --help`

### 10.2 Support Channels

- **GitHub Issues:** https://github.com/DammianMiller/universal-agent-protocol/issues
- **Discord:** Join UAP Discord server
- **Email:** support@universal-agent-protocol.dev

### 10.3 Before Opening Issue

1. ✅ Check this troubleshooting guide
2. ✅ Review relevant documentation
3. ✅ Enable debug logging
4. ✅ Export system state
5. ✅ Search existing issues

---

**Last Updated:** 2026-03-13  
**Version:** 1.0.0  
**Status:** ✅ Production Ready
