# Overnight Benchmark Runner Guide

> **Version:** 1.18.0  
> **Last Updated:** 2026-03-28  
> **Purpose:** Automated overnight benchmark execution

---

## Overview

This guide explains how to set up and run the overnight benchmark suite for comprehensive UAP validation.

### What Gets Run

The overnight suite executes:
- **10 representative tasks** (short benchmark)
- **Token tracking** per task
- **Time measurement** per task
- **Success/failure** tracking
- **Error count** per task
- **Quality scoring** (if enabled)

### Expected Duration

| Suite | Tasks | Duration |
|-------|-------|----------|
| Short | 10 | ~15-20 minutes |
| Full | 14 | ~25-30 minutes |
| Overnight | 10 + extended | ~4 hours |

---

## Quick Start

### Manual Run

```bash
# Run short benchmark suite
npm run benchmark:short

# Run full benchmark suite
npm run benchmark:full

# Run overnight suite
npm run benchmark:overnight
```

### Automated Nightly Run

```bash
# Edit crontab
crontab -e

# Add nightly run at 2:00 AM
0 2 * * * cd /path/to/uap && npm run benchmark:overnight >> /var/log/uap-benchmark.log 2>&1
```

---

## Configuration

### Environment Variables

```bash
# Benchmark configuration
UAP_BENCHMARK_TASKS=T01,T02,T03,T04,T05,T06,T07,T08,T09,T10
UAP_BENCHMARK_UAP_ENABLED=true
UAP_BENCHMARK_OPENCODE_ENABLED=true
UAP_BENCHMARK_TOKEN_TRACKING=true
UAP_BENCHMARK_QUALITY_SCORING=false

# Results location
UAP_BENCHMARK_RESULTS_DIR=./benchmark-results
```

### Task Selection

```typescript
// scripts/benchmark-quick-suite.ts
const TASKS = [
  { id: 'T01', name: 'Git Repository Recovery', category: 'system-admin' },
  { id: 'T02', name: 'Password Hash Recovery', category: 'security' },
  { id: 'T03', name: 'mTLS Certificate Setup', category: 'security' },
  { id: 'T04', name: 'Docker Compose Config', category: 'containers' },
  { id: 'T05', name: 'ML Model Training', category: 'ml' },
  { id: 'T06', name: 'Data Compression', category: 'data-processing' },
  { id: 'T07', name: 'Chess FEN Parser', category: 'games' },
  { id: 'T08', name: 'SQLite WAL Recovery', category: 'database' },
  { id: 'T09', name: 'HTTP Server Config', category: 'networking' },
  { id: 'T10', name: 'Code Compression', category: 'development' },
];
```

---

## Output Format

### Results JSON

```json
[
  {
    "taskId": "T01",
    "taskName": "Git Repository Recovery",
    "category": "system-admin",
    "tokens": 19800,
    "time": 12.34,
    "success": true,
    "errors": 0
  }
]
```

### Markdown Report

```markdown
# UAP Benchmark Report

**Generated:** 2026-03-28
**Version:** 1.18.0

## Summary

| Metric | Value |
|--------|-------|
| Total Tasks | 10 |
| Successful | 10 |
| Avg Tokens/Task | 20,000 |
| Avg Time/Task | 15.5s |
| Success Rate | 100% |
```

---

## Results Location

```
benchmark-results/
├── overnight-2026-03-28-020000/
│   ├── benchmark.log
│   ├── results-2026-03-28.json
│   └── report-2026-03-28.md
├── overnight-2026-03-27-020000/
│   └── ...
└── ...
```

---

## Monitoring

### Check Status

```bash
# Check latest results
ls -lt benchmark-results/overnight-*/ | head -5

# View latest report
cat benchmark-results/overnight-*/report-*.md | tail -50

# Check benchmark log
tail -f benchmark-results/overnight-*/benchmark.log
```

### Alerting

```bash
# Check for failures
grep -r "Failed\|Error" benchmark-results/overnight-*/benchmark.log

# Check success rate
jq -s 'map(select(.success | not)) | length' benchmark-results/overnight-*/results-*.json
```

---

## Troubleshooting

### Benchmark Fails

```bash
# Check logs
cat benchmark-results/overnight-*/benchmark.log

# Check Node.js version
node --version  # Should be >= 18.0.0

# Check dependencies
npm install

# Rebuild project
npm run build
```

### Results Not Generated

```bash
# Check results directory permissions
ls -la benchmark-results/

# Create results directory manually
mkdir -p benchmark-results

# Run with verbose output
npm run benchmark:short -- --verbose
```

### Performance Issues

```bash
# Check system resources
free -h          # Memory
df -h            # Disk space
top              # CPU usage

# Reduce concurrent tasks if needed
export UAP_BENCHMARK_CONCURRENCY=1
```

---

## Advanced Usage

### Custom Task List

```bash
# Create custom tasks file
cat > custom-tasks.json << EOF
[
  {"id": "T01", "name": "Task 1", "category": "test"},
  {"id": "T02", "name": "Task 2", "category": "test"}
]
EOF

# Run with custom tasks
node scripts/benchmark-quick-suite.ts --tasks custom-tasks.json
```

### Quality Scoring

```bash
# Enable quality scoring
export UAP_BENCHMARK_QUALITY_SCORING=true

# Quality score is calculated by:
correctness * 0.3 +
completeness * 0.25 +
efficiency * 0.2 +
security * 0.15 +
maintainability * 0.1
```

### Compare Results

```bash
# Compare two benchmark runs
npm run benchmark:compare \
  -- --before benchmark-results/overnight-2026-03-27/results.json \
     --after benchmark-results/overnight-2026-03-28/results.json

# Generate comparison report
npm run benchmark:report \
  -- --input benchmark-results/overnight-2026-03-28/results.json \
     --output benchmark-results/overnight-2026-03-28/comparison.md
```

---

## Expected Results

### Based on Historical Data

| Metric | Target | Status |
|--------|--------|--------|
| Success Rate | 100% | ✅ |
| Avg Tokens/Task | <25,000 | ✅ |
| Avg Time/Task | <20s | ✅ |
| Error Rate | 0% | ✅ |

### Performance Comparison

| Version | Tokens/Task | Time/Task | Success Rate |
|---------|-------------|-----------|--------------|
| Baseline | 52,000 | 45s | 75% |
| UAP v1.17 | 28,500 | 38s | 92% |
| UAP v1.18 + OpenCode | 23,400 | 32s | 100% |

---

## Best Practices

### 1. Run During Off-Peak Hours
- Avoid running during business hours
- Schedule for 2:00 AM local time
- Ensure no other heavy workloads

### 2. Monitor Resources
- Check disk space before run
- Ensure sufficient memory
- Monitor network connectivity

### 3. Review Results Daily
- Check for failures
- Review token usage trends
- Monitor success rate

### 4. Archive Old Results
```bash
# Archive results older than 30 days
find benchmark-results -minmtime 30 -exec mv {} benchmark-results/archive/ \;
```

### 5. Set Up Alerts
```bash
# Alert on failures
grep -q "Failed" benchmark-results/overnight-*/benchmark.log && \
  echo "Benchmark failures detected!" | mail -s "UAP Benchmark Alert" admin@example.com
```

---

## Next Steps

After overnight run completes:

1. **Review Report**: Check `benchmark-results/overnight-*/report-*.md`
2. **Verify Success**: Ensure 100% success rate
3. **Check Tokens**: Confirm token usage is within targets
4. **Monitor Trends**: Compare with previous runs
5. **Update Documentation**: If significant changes detected

---

<div align="center">

**Related Documentation:**
- [Benchmark Results](COMPREHENSIVE_BENCHMARKS.md)
- [Validation Plan](VALIDATION_PLAN.md)
- [CLI Reference](../reference/UAP_CLI_REFERENCE.md)

</div>
