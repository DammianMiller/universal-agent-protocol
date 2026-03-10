# P16: Task-First Execution

**Category**: Execution
**Abbreviation**: Task-First

## Pattern

Execute the task directly. Do not start with exploration unless necessary.

## Rule

```
If task is clear → Execute immediately.
If task is ambiguous → Clarify first, then execute.
```

## Implementation

1. Parse task requirements
2. If requirements are clear: execute
3. If requirements are ambiguous: ask clarification
4. Never explore "just in case"

## Examples

✅ Task: "Add logging to auth.py" → Add logging directly
✅ Task: "Fix the bug in line 45" → Fix the bug directly
❌ Task: "Add logging to auth.py" → First read all files in project

## When Exploration Is Needed

- Task references "the module" but doesn't specify which
- Task mentions "similar to X" but X isn't defined
- Task asks to "optimize" without specifying what

## Anti-Pattern

❌ Reading entire codebase for a 2-line change
❌ Running exploration commands before attempting task
❌ "Let me understand the architecture first" for simple tasks
