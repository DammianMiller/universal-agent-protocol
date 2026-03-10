---
name: batch-review
version: '2.0.0'
category: Code Review
priority: 7
triggers:
  - batch
  - review
  - audit
  - analyze
  - documentation
compatibility: CLAUDE.md v2.3.0+
---

# Batch Review (claude-batch-toolkit)

> **Integration**: Load via `@Skill:batch-review.md` in DECISION LOOP step 5  
> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

## Overview

Send non-urgent analysis to Anthropic's Batch API at **50% cost reduction**. Ideal for code reviews, documentation, security audits, and architecture analysis that can wait ~1 hour.

## When to Activate

Use this skill for batch processing when:

- Code reviews or security audits (non-urgent)
- Documentation generation
- Architecture analysis
- Test generation for existing code
- Refactoring plans
- Changelog generation
- Any task where 50% cost savings > immediate results

## Detection Keywords

"batch", "review", "audit", "analyze", "documentation", "architecture", "changelog", "refactoring plan"

## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:batch-review.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```

### Required Pre-Checks

Before using batch review:

- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Task is non-urgent (can wait ~1 hour)
- [ ] Context is self-contained (no interactive debugging needed)
- [ ] Full file contents gathered (batch model has NO codebase access)

## Setup

```bash
git clone git@github.com:s2-streamstore/claude-batch-toolkit.git
cd claude-batch-toolkit && ./install.sh --api-key $ANTHROPIC_API_KEY
```

## Good Batch Candidates

- ✅ Code reviews and security audits
- ✅ Documentation generation
- ✅ Architecture analysis
- ✅ Test generation for existing code
- ✅ Refactoring plans
- ✅ Changelog generation

## Bad Candidates (use real-time instead)

- ❌ Anything needed right now
- ❌ Interactive debugging
- ❌ Quick questions
- ❌ Tasks requiring back-and-forth

## Usage Pattern

1. Gather all context into a self-contained prompt file
2. Include full file contents (batch model has NO codebase access)
3. Submit via MCP tool `send_to_batch` with `packet_path`
4. Check results: `batch_list` then read from `~/.claude/batches/results/`

## Integration with Parallel Review Protocol

Instead of running security-auditor/code-quality-guardian synchronously as subagents,
submit reviews as batch jobs for 50% cost savings when time allows:

```bash
# Assemble review prompt with full diff
git diff --staged > /tmp/review_diff.txt
cat > /tmp/batch_prompt.md << 'EOF'
Review the following diff for security vulnerabilities and code quality issues.
## Diff
EOF
cat /tmp/review_diff.txt >> /tmp/batch_prompt.md

# Submit (via MCP or CLI)
uv run ~/.claude/mcp/claude_batch_mcp.py submit --packet-path /tmp/batch_prompt.md --label "pr-review"
```

## Cost Reference

| Model           | Standard       | Batch (50% off)  |
| --------------- | -------------- | ---------------- |
| Claude Opus 4   | $15/$75 per 1M | **$7.50/$37.50** |
| Claude Sonnet 4 | $3/$15 per 1M  | **$1.50/$7.50**  |

## UAP Protocol Compliance

### Completion Gates Checklist

Before reporting task complete:

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```

### Verifier-First Integration

If tests are involved:

1. **Schema Diff Gate**: Compare output schema against test expectations BEFORE running verifier
2. **Environment Check**: `python3 --version; which pip3 gcc make node npm`
3. **Run Verifier**: After each change, minimum 3 runs with TESTS output format

## Memory Integration

### Store Lessons Learned

```bash
uap memory store "Batch review completed: <task_type> saved $<cost> vs real-time" \
  --tags batch-review,<category> --importance 7
```

### Query Relevant Context

```bash
uap memory query "batch review <task_type>"
```

## Common Pitfalls

1. **Never skip worktree**: ALWAYS use `uap worktree create <slug>` before any file changes
2. **Never batch urgent tasks**: Batch takes ~1 hour, use real-time for urgent needs
3. **Never forget context**: Batch model has NO codebase access, include all file contents
4. **Never forget cleanup**: Run `uap worktree cleanup <id>` after PR merge

## Success Criteria

- [ ] All tests pass (100%, 3+ runs)
- [ ] Schema verified against test expectations
- [ ] Worktree cleanup completed
- [ ] Lessons stored in memory
- [ ] No debug artifacts left behind
- [ ] Cost savings achieved vs real-time review

## References

- CLAUDE.md v2.3.0: Universal Agent Patterns (P1-P39)
- Claude Batch API: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
- Pattern P8: CLI over Libraries
- Pattern P13: Iterative Refinement Loop

---

**Last Updated**: 2026-03-09  
**Compatibility**: CLAUDE.md v2.3.0+  
**RTK Includes**: `@hooks-session-start.md`, `@PreCompact.md`
