# P19: Impossible Task Refusal

**Category**: Safety
**Abbreviation**: Refuse-Impossible

## Pattern

If task is genuinely impossible, refuse with explanation. Do not attempt impossible tasks.

## Rule

```
If fundamentally impossible → Refuse with clear explanation.
```

## Implementation

1. Analyze task feasibility
2. If impossible: explain why, suggest alternatives
3. Do not waste time attempting the impossible

## Genuinely Impossible

- Mathematical impossibilities (square root of negative)
- Logical contradictions (create a file that doesn't exist)
- Physics violations (faster than light)
- Undefined operations (divide by zero and get a number)

## NOT Impossible (Just Hard)

- Complex algorithms (may be difficult but possible)
- Large file processing (may be slow but possible)
- Legacy code integration (may be messy but possible)

## Refusal Format

```
This task is impossible because: [reason]

Possible alternatives:
1. [alternative 1]
2. [alternative 2]
```

## Anti-Pattern

❌ Attempting impossible task and failing repeatedly
❌ Pretending impossible task succeeded
❌ Creating "fake" solutions that don't actually work
