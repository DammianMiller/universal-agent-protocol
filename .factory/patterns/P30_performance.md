# P30: Performance Threshold Tuning

**Category**: Optimization
**Abbreviation**: Perf-Threshold

## Pattern

For optimization tasks with specific thresholds, iteratively tune until threshold is met. Measure, don't guess.

## Rule

```
Performance target → Measure current → Optimize → Re-measure → Iterate.
```

## Implementation

1. Establish baseline measurement
2. Identify target threshold
3. Make optimization
4. Measure impact
5. Iterate until threshold met

## Measurement Commands

```bash
# Execution time
time command

# Memory usage
/usr/bin/time -v command

# Profiling
python -m cProfile script.py
```

## Threshold Example

Task: "Reduce latency to under 100ms"

1. Measure: Current 150ms
2. Optimize: Add caching
3. Measure: Now 80ms ✓

## Anti-Pattern

❌ Optimizing without measuring baseline
❌ Claiming improvement without measurement
❌ Over-optimizing when threshold already met
