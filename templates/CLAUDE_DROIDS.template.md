# Droids and Skills Guide Template

**Version**: 1.0
**Last Updated**: {{STRUCTURE_DATE}}

---

## Available Droids

Droids are specialized AI agents for specific tasks.

### Language Specialists

| Droid | Purpose |
|-------|---------|
| `cpp-pro` | C++ development, RAII, STL, templates |
| `python-pro` | Python, async/await, decorators |
| `javascript-pro` | JavaScript/TypeScript, ES6+, async |

### Review Droids

| Droid | Purpose | Blocks PR |
|-------|---------|-----------|
| `security-code-reviewer` | OWASP, secrets, injection | CRITICAL/HIGH |
| `code-quality-reviewer` | Naming, complexity, style | CRITICAL only |
| `performance-reviewer` | Algorithms, N+1, caching | Advisory |
| `test-coverage-reviewer` | Test gaps, brittle tests | Advisory |

### Utility Droids

| Droid | Purpose |
|-------|---------|
| `worktree-manager` | Git worktree lifecycle, PR creation |
| `git-summarizer` | Repository context for reviewers |
| `release-notes-writer` | Generate release notes from commits |
| `project-analyzer` | Extract project metadata |

---

## Available Skills

Skills provide domain-specific guidance.

{{#each SKILLS}}
| `{{name}}` | {{purpose}} |
{{/each}}

---

## Agent Routing

| Task Type | Route To |
|-----------|----------|
| Security review | `security-code-reviewer` |
| Performance analysis | `performance-reviewer` |
| Code quality | `code-quality-reviewer` |
| C++ code | `cpp-pro` |
| Python code | `python-pro` |
| JavaScript/TypeScript | `javascript-pro` |

---

## Parallel Execution

When safe, run independent droids in parallel:

```bash
# Before PR - run all reviewers
Task(subagent_type: "security-code-reviewer", prompt: "Audit: <files>")
Task(subagent_type: "code-quality-reviewer", prompt: "Review: <files>")
```

---

## Multi-Agent Coordination

**Skip for single-agent sessions.** Only activate when multiple agents work concurrently.

```bash
# Check for overlaps
uap agent overlaps --resource "<files-or-directories>"
```

| Risk Level | Action |
|------------|--------|
| `none` | Proceed immediately |
| `low` | Proceed, note merge order |
| `medium` | Announce, coordinate sections |
| `high`/`critical` | Wait or split work |

---

## Invoking Droids

```bash
# Via Task tool
Task(subagent_type: "python-pro", prompt: "Refactor this code: <code>")

# Via Skill tool
Skill(skill: "openobserve-expert")
```

---

## See Also

- `.factory/droids/` - Droid definitions
- `.factory/skills/` - Skill definitions
- `CLAUDE_WORKFLOWS.md` - Review protocols
