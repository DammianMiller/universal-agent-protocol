# P26: Near-Miss Iteration

**Category**: Testing
**Abbreviation**: Near-Miss

## Pattern

When tests fail by small margin, iterate on the specific near-miss. Do not overhaul working logic.

## Rule

```
Small gap (near-miss) → Small adjustment.
Large gap → Different approach.
```

## Implementation

1. Analyze test failure
2. Calculate gap between expected and actual
3. If small gap: tweak existing logic
4. If large gap: reconsider approach

## Gap Analysis

```python
# Small gap examples:
# Expected: 100, Got: 98  → 2% off → tweak
# Expected: "hello", Got: "Hello" → case issue → fix case

# Large gap examples:
# Expected: 100, Got: 0   → 100% off → rethink
# Expected: sorted, Got: random → logic wrong → rewrite
```

## Near-Miss Fix Pattern

1. Identify the small discrepancy
2. Find the specific line causing it
3. Make minimal adjustment
4. Re-test

## Anti-Pattern

❌ Rewriting entire function for 1% error
❌ Ignoring near-misses and claiming "close enough"
❌ Adding hacky patches instead of fixing root cause
