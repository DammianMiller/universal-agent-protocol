# P17: Constraint Extraction

**Category**: Planning
**Abbreviation**: Extract-Constraints

## Pattern

Extract ALL constraints from task before implementation. Verify EACH constraint.

## Rule

```
Words like "exactly", "only", "must be", "no more than" → HARD CONSTRAINTS.
```

## Implementation

1. Read task carefully
2. Extract constraint words
3. List each constraint explicitly
4. Verify output against each constraint
5. Fix any violations before claiming done

## Constraint Words

- "exactly N" → Output must have N items
- "only X" → No other items allowed
- "must be Y" → Y is required
- "no more than Z" → Z is maximum
- "at least W" → W is minimum
- "single file" → One file only

## Examples

Task: "Create exactly 3 routes, no more"

Constraints:
- [ ] Route 1 exists
- [ ] Route 2 exists
- [ ] Route 3 exists
- [ ] Route 4 does NOT exist

## Anti-Pattern

❌ Ignoring "only" or "exactly" constraints
❌ "I added 4 routes instead of 3, that's better"
❌ Treating constraints as suggestions
