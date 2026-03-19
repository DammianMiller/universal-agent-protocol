---
title: Completion Gates Policy
version: 1.0
last_updated: 2026-03-20
status: active
---

# Completion Gates - Session Analysis & Phantom Error Investigation

## Overview

This policy enforces three critical behaviors to prevent premature task abandonment and improve session quality:

1. **Plan Validation Required** - Prompt for validation after generating plans
2. **Sudden Stop Analysis** - Document incomplete work before ending sessions  
3. **Phantom Error Investigation** - Thoroughly investigate inconsistent errors before accepting them as blockers

---

## Rule 1: Plan Validation Required [REQUIRED]

### The Problem
Plans represent significant architectural decisions. User validation ensures alignment before implementation begins, preventing wasted effort on incorrect approaches.

### The Rule
**After generating any plan, BEFORE offering options or user interaction, you MUST prompt for plan validation.**

### Implementation

After generating a plan (using `ExitPlanMode` or similar), ALWAYS include:

```markdown
## Plan Validation Required

Before proceeding with implementation, please validate this plan:
- Does this approach meet the requirements?
- Are there any concerns or alternative approaches you'd prefer?
- Should I adjust anything before implementing?

Reply "validate" or "approved" to proceed, or provide feedback for adjustments.
```

**This is mandatory for all non-trivial tasks. No exceptions.**

---

## Rule 2: Sudden Stop Analysis [REQUIRED]

### The Problem
Sudden stops without completion indicate:
- Misunderstood requirements
- Unexpected obstacles not being addressed
- Premature conclusions about task difficulty
- Pattern of giving up when facing challenges

### The Rule
**Before ending a session or stopping work, you MUST analyze and report any incomplete tasks or sudden stops.**

### Implementation

When ending a session, include this analysis section:

```markdown
## Session Analysis

**Completed Tasks:**
- [x] Task 1 description
- [x] Task 2 description

**Incomplete/Stopped Work:**
- [ ] Task 3 - Stopped because: [specific reason]

**Pattern Observation:**
[Note any sudden stops during this session and their causes]
```

---

## Rule 3: Phantom Error Investigation [REQUIRED]

### The Problem
Phantom errors (cache issues, stale reports, false positives) cause:
- Wasted time on non-existent problems
- Premature acceptance of blockers
- Incomplete work due to giving up too easily
- Pattern of accepting surface-level issues

### The Rule
**When encountering errors that don't reproduce on individual files or seem inconsistent, investigate thoroughly before accepting them as valid blockers.**

### Investigation Checklist

1. **Reproduce independently**: Run the command on individual affected files
2. **Clear caches**: Remove `.eslintcache`, `node_modules/.vite`, TypeScript build cache
3. **Check line contents**: Verify the reported lines actually contain the problematic code
4. **Try alternatives**: If lint fails but build/test pass, try direct execution
5. **Document investigation**: If errors persist, document what was tried and why

**Only accept errors as valid after thorough investigation.**

---

## Enforcement

### Pre-Session End Checklist
Before ending any session:
- [ ] Plan validation prompt included (if plan generated)
- [ ] Session Analysis section included
- [ ] All incomplete tasks documented with reasons
- [ ] Pattern observations noted for future reference
- [ ] Phantom errors investigated (if encountered)

### Violation Consequences
Failing to follow these policies constitutes:
- Incomplete work
- Premature task abandonment
- Pattern of not persisting through obstacles

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| Generating plan | Prompt for validation before implementation |
| Stopping session | Include Session Analysis section |
| Phantom error found | Investigate before accepting as blocker |
| Inconsistent errors | Try individual file execution, clear caches |
| All instructions not completed | Document what was left incomplete |
| Pattern of stopping early | Note in pattern observations for improvement |
