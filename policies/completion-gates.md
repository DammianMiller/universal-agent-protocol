---
name: Completion Gates Policy
description: Mandatory validation and prompting requirements before claiming task completion
type: feedback
---

# Completion Gates [REQUIRED]

## Rule 1: Validate Plan Prompt Required

**Before offering options or user interaction after generating a plan, the AI MUST prompt for plan validation.**

### Why:
Plans represent significant architectural decisions that affect the entire codebase. User validation ensures alignment before implementation begins, preventing wasted effort on incorrect approaches.

### How to apply:
After generating a plan (using `ExitPlanMode` or similar), ALWAYS include a validation prompt like:

```
## Plan Validation Required

Before proceeding with implementation, please validate this plan:
- Does this approach meet the requirements?
- Are there any concerns or alternative approaches you'd prefer?
- Should I adjust anything before implementing?

Reply "validate" or "approved" to proceed, or provide feedback for adjustments.
```

**This is mandatory for all non-trivial tasks.** No exceptions.

---

## Rule 2: Sudden Stop Analysis and Reporting

**Before ending a session or stopping work, the AI MUST analyze and report any incomplete tasks or sudden stops.**

### Why:
Sudden stops without completion indicate potential issues: misunderstood requirements, unexpected obstacles, or premature conclusions. Documenting these patterns helps improve future task completion.

### How to apply:
When ending a session, before claiming completion, check:

1. **Were all instructions fully executed?** If not, document what was left incomplete.
2. **Did I stop mid-task?** Report any tasks that were in-progress when stopping.
3. **What blocked me?** Document obstacles encountered (policy blocks, unclear requirements, technical issues).
4. **Pattern analysis**: Have I stopped abruptly before? What caused it?

Include a "Session Analysis" section in the final response:

```
## Session Analysis

**Completed Tasks:**
- [x] Task 1 description
- [x] Task 2 description

**Incomplete/Stopped Work:**
- [ ] Task 3 - Stopped because: [reason]

**Pattern Observation:**
[Note any sudden stops during this session and their causes]
```

---

## Rule 3: No Phantom Error Acceptance

**When encountering errors that don't reproduce on individual files or seem inconsistent, investigate thoroughly before accepting them as valid blockers.**

### Why:
Phantom errors (cache issues, stale reports, false positives) waste time and prevent legitimate work. Blindly accepting them as real blockers is a form of giving up.

### How to apply:
When encountering suspicious errors:

1. **Reproduce independently**: Run the command on individual affected files
2. **Clear caches**: Remove `.eslintcache`, `node_modules/.vite`, etc.
3. **Check line contents**: Verify the reported lines actually contain the problematic code
4. **Try alternatives**: If lint fails but build/test pass, try direct execution
5. **Document investigation**: If errors persist, document what was tried

**Only accept errors as valid after thorough investigation.**

---

## Enforcement

These gates are REQUIRED level policies. Violating them constitutes incomplete work.

### Pre-Commit Checklist:
- [ ] Plan was validated by user before implementation
- [ ] Session analysis documented any sudden stops
- [ ] Phantom errors were investigated, not accepted blindly
- [ ] All instructions fully executed (nothing left incomplete)

### Post-Task Validation:
Before claiming DONE/COMPLETE/CLOSED:
1. Review session for any sudden stops or incomplete work
2. Document lessons learned from obstacles encountered
3. Confirm all gates passed
4. Only then mark task complete

---

## Examples

### GOOD - Plan Validation:
```
[Generates plan]

## Plan Validation Required

Before proceeding, please validate this plan:
- Does the multi-worktree approach meet requirements?
- Are there any concerns?

Reply "validate" to proceed or provide feedback.
```

### BAD - No Validation:
```
[Generates plan]

Now implementing...
```

### GOOD - Sudden Stop Analysis:
```
## Session Analysis

**Completed:**
- [x] Fixed lint errors in web-browser.ts
- [x] Added worktree enforcement gate

**Stopped Work:**
- [ ] Publish to npm - Stopped because: Phantom lint errors in planner.ts (lines don't contain reported code)

**Pattern Observation:**
This is the second time stopping on phantom errors. Need to investigate eslint cache issues earlier.
```

### BAD - No Analysis:
```
## Status

Build and tests are passing.
```
