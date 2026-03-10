# P33: Numerical Stability Testing

**Category**: Testing
**Abbreviation**: Num-Stable

## Pattern

For numerical algorithms, test with edge cases that expose floating-point instability.

## Rule

```
Numerical code → Test edge cases → Verify stability.
```

## Implementation

1. Write normal case test
2. Add edge case tests
3. Verify results are stable
4. Handle precision limits explicitly

## Numerical Edge Cases

- Very large numbers (overflow)
- Very small numbers (underflow)
- Near-zero values (division issues)
- Negative values (if applicable)
- Repeated operations (error accumulation)

## Edge Case Test Values

```python
edge_cases = [
    0.0,           # Zero
    1e-15,         # Near zero
    1e15,          # Very large
    -1.0,          # Negative
    float('inf'),  # Infinity
    float('-inf'), # Negative infinity
]
```

## Stability Patterns

- Use decimal module for exact arithmetic
- Avoid subtracting similar numbers
- Use relative error, not absolute
- Set explicit precision limits

## Anti-Pattern

❌ Testing only "normal" numbers
❌ Ignoring floating-point precision
❌ Assuming math is exact
