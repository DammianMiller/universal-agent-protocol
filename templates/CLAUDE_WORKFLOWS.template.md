# Workflows Guide Template

**Version**: 1.0
**Last Updated**: {{STRUCTURE_DATE}}

---

## Session Start

```bash
uap task ready
sqlite3 ./{{MEMORY_DB_PATH}} "SELECT * FROM memories ORDER BY id DESC LIMIT 10;"
uap agent status
```

---

## Decision Loop

```
1. CLASSIFY  -> complexity? backup? tools?
2. PROTECT   -> cp file file.bak (configs, DBs)
3. MEMORY    -> query context + past failures
4. WORK      -> implement (ALWAYS use worktree)
5. REVIEW    -> self-review diff
6. TEST      -> completion gates pass
7. LEARN     -> store outcome
```

---

## Worktree Workflow (MANDATORY)

**ALL file changes MUST use a worktree.** No exceptions.

```bash
{{WORKTREE_CREATE_CMD}} <slug>
cd {{WORKTREE_DIR}}/NNN-<slug>/
git add -A && git commit -m "type: description"
{{WORKTREE_PR_CMD}} <id>
# After merge:
{{WORKTREE_CLEANUP_CMD}} <id>  # MANDATORY
```

---

## Testing Requirements

1. Create worktree
2. Update/create tests
3. Run `{{TEST_COMMAND}}`
4. Run linting: `{{LINT_COMMAND}}`
5. Create PR

---

## Completion Gates

**CANNOT say "done" until ALL gates pass.**

### GATE 1: Output Existence

```bash
for f in $EXPECTED_OUTPUTS; do
  [ -f "$f" ] && echo "ok $f" || echo "MISSING: $f"
done
```

### GATE 2: Constraint Compliance

Extract ALL constraints from task:
- "exactly", "only", "must be", "no more than"
- Verify EACH constraint

### GATE 3: Tests Pass

```bash
{{TEST_COMMAND}}
```

If < 100%: iterate (fix specific failure, re-run).

---

## Completion Checklist

```
☐ Tests pass
☐ Lint pass
☐ Worktree used (MANDATORY)
☐ Worktree cleaned up after PR merge (MANDATORY)
☐ Self-review completed
☐ Memory updated
☐ PR created
☐ Reviews passed
☐ No secrets in code
```

---

## Parallel Review Protocol

**Before ANY commit/PR, invoke quality droids in PARALLEL:**

```bash
Task(subagent_type: "code-quality-reviewer", prompt: "Review: <files>")
Task(subagent_type: "security-code-reviewer", prompt: "Audit: <files>")
```

---

## Automatic Triggers

| Pattern | Action |
|---------|--------|
| work request | `uap task create --type task` |
| bug report | `uap task create --type bug` |
| feature request | `uap task create --type feature` |
| ANY file change | **create worktree (MANDATORY)** |

---

## Completion Protocol

```
MERGE -> CLEANUP WORKTREE -> DEPLOY -> MONITOR -> FIX (iterate until 100%)
```

**Never "done" until:** PR merged + worktree cleaned up + deployed + verified working

---

## See Also

- `CLAUDE_CODING.md` - Coding standards
- `.factory/droids/worktree-manager.md` - Worktree automation (if applicable)
