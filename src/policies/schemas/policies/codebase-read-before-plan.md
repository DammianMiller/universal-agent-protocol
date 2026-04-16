# codebase-read-before-plan

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: planning, exploration, accuracy

## Rule

Before emitting any implementation plan (plans with ≥2 steps or touching any code path), the agent MUST have read the relevant existing codebase in the same session:

- At least one `Read` of a file in the target service/app, OR
- At least one `Grep` / `Glob` over the target paths, OR
- A completed `Agent(subagent_type=Explore)` for the target domain

Plans produced without this evidence are rejected.

## Why

Planning without reading generates drift-prone, hallucinated plans that conflict with existing conventions. User's directive: ground plans in the actual codebase first.

## Enforcement

Python enforcer `codebase_read_before_plan.py` scans the recent tool-call log for read operations against files within the plan's declared scope; blocks plan emission if none found.

```rules
- title: "Plans must follow codebase reads"
  keywords: [plan, design, propose, architect, implement]
  antiPatterns: [plan-without-read, unread-scope, blind-plan]
```
