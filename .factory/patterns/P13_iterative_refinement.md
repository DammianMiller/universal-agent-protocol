# P13: Iterative Refinement Loop

**Category**: Testing
**Abbreviation**: Iter-Ref

## Pattern

Run tests, fix failures, re-run until 100% pass. Reserve 20% of time for iteration.

## Rule

```
Test → Fix specific failure → Re-run → Repeat until 100% pass.
```

## Implementation

```bash
# Run tests
pytest 2>&1 | tail -30

# If < 100%: iterate (fix specific failure, re-run)
# Do NOT add new tests until existing tests pass
```

## The 80/20 Rule

- 80% of time: Implementation
- 20% of time: Iteration and fixing

## Examples

1. Run tests → 3 failures
2. Fix first failure specifically
3. Re-run → 2 failures
4. Fix second failure specifically
5. Re-run → 1 failure
6. Fix third failure specifically
7. Re-run → 0 failures ✓

## Anti-Pattern

❌ Adding new tests when existing tests fail
❌ Skipping failing tests instead of fixing them
❌ Claiming "tests mostly pass"
