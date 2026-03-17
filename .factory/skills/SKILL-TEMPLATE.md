# UAP Skills System - v2.3.0 Compatible Template

> **Purpose**: Domain-specific guidance for AI agents following CLAUDE.md v2.3.0 protocol
>
> **Integration**: Loaded via `@Skill:skill-name.md` in DECISION LOOP step 5
>
> **Requirements**: Must follow this exact structure for optimal compatibility

```markdown
---
name: <skill-name>
version: '1.0.0'
category: <category>
priority: <1-10>
triggers:
  - keyword1
  - keyword2
---

# <Skill Name>

## Overview

One-sentence description of what this skill does and when to use it.

## When to Activate

List specific scenarios, keywords, or task types that should trigger this skill.

## Core Principles

- Principle 1: Follow CLAUDE.md v2.3.0 patterns
- Principle 2: Respect MANDATORY gates (worktrees, verifier loop)
- Principle 3: Use RTK includes for session context
- Principle 4: Complete all completion gates before reporting done

## Workflow Integration

### DECISION LOOP Position

This skill applies at **step <N>** of the DECISION LOOP:
```

1. CLASSIFY -> ...
2. PROTECT -> ...
3. MEMORY -> query relevant context + past failures
4. AGENTS -> check overlaps (if multi-agent)
5. SKILLS -> @Skill:<skill-name>.md for domain-specific guidance
6. WORK -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW -> self-review diff before testing
8. TEST -> completion gates pass
9. LEARN -> store outcome in memory

````

### Required Pre-Checks

Before applying this skill, ensure:

- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Worktree created (MANDATORY for ANY file changes)
- [ ] Memory queried for relevant past failures

## Domain-Specific Patterns

<Apply universal patterns P1-P39 as needed, with domain-specific examples>

### Pattern Examples

| Pattern | Application | Example |
|---------|-------------|---------|
| P1 | Tool specification | Use `which <tool>` before using |
| P3 | State protection | Backup config files before changes |
| P5 | Impossible detection | Check if task requires pre-computed solution |
| P12 | Output verification | `ls -la` verify all outputs exist |

## Testing & Verification

### Test Commands

```bash
# Run tests with verifier loop (minimum 3 runs)
npm test  # Or appropriate test command

# Verify schema compliance
./verifier.sh  # If available
````

### Completion Gates Checklist

Before reporting task complete:

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] If decoder provided: round-trip tested (BLOCKING)
```

## Memory Integration

### Store Lessons Learned

After completing tasks using this skill:

```bash
uap memory store "<lesson>" --tags <skill-name>,<domain> --importance 8
```

### Query Relevant Context

Before starting work:

```bash
uap memory query "<domain-specific keywords>"
```

## RTK Integration

This skill supports Run-Time Knowledge includes:

- `@hooks-session-start.md` - Session initialization hooks
- `@PreCompact.md` - Pre-compact optimization hooks

## Common Pitfalls

1. **Never skip worktree**: ALWAYS use `uap worktree create <slug>` before any file changes
2. **Never claim done at <100%**: Run verifier minimum 3 times
3. **Never skip schema diff**: Diff output schema against test expectations BEFORE running verifier
4. **Never forget cleanup**: Run `uap worktree cleanup <id>` after PR merge

## Success Criteria

- [ ] All tests pass (100%, 3+ runs)
- [ ] Schema verified against test expectations
- [ ] Worktree cleanup completed
- [ ] Lessons stored in memory
- [ ] No debug artifacts left behind

## References

- CLAUDE.md v2.3.0: Universal Agent Patterns
- UAP Memory System: 4-layer architecture
- Pattern Router: P1-P39 pattern library

---

**Last Updated**: <date>
**Maintained By**: <team/person>
**Compatibility**: CLAUDE.md v2.3.0+
