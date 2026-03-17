---
name: service-config
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: service-config
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| service-config | Use when tasks involve configuring servers, daemons, web servers, databases, or multi-service setups. Includes smoke testing protocol. | service name or configuration goal |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:service-config.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:<skill-name>.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Service Configuration

## Detection
Keywords: "configure", "server", "webserver", "service", "daemon", "nginx", "apache", "systemd", "docker", "database setup"

## Protocol
1. Identify all services needed and their dependency order
2. Check service status: `systemctl status <service>` or `docker ps`
3. Configure in dependency order (base -> dependent):
   - Database before app server
   - App server before reverse proxy
   - All services before integration test
4. Test each service individually before moving to next
5. Verify end-to-end after all configured

## Smoke Test (MANDATORY)
Services must be tested BEFORE claiming completion:
```bash
# Start service
systemctl start <service> || docker-compose up -d

# Test immediately
curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/health
# or
nc -z localhost <port> && echo "open" || echo "closed"

# Check logs for errors
journalctl -u <service> --no-pager -n 20 || docker logs <container> --tail 20
```

**NEVER complete without a successful smoke test.**

## Common Gotchas
- Port conflicts: check `ss -tlnp | grep <port>` before starting
- File permissions: config files often need specific ownership
- SELinux/AppArmor can silently block -- check `audit.log`
- DNS resolution inside containers differs from host
- WAL mode for SQLite: `PRAGMA journal_mode=WAL;` for concurrent access



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```
