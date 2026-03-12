# UAP 3.0+ vs Baseline Benchmark Results
## Terminal-Bench 2.0 Quick Tests - 12 Tasks

**Date:** March 12, 2026  
**Model:** qwen3.5-a3b-iq4xs  
**API Endpoint:** http://192.168.1.165:8080/v1

---

## Executive Summary

Both UAP 3.0+ and Baseline (no UAP) achieved **100% success rate** on all 12 Terminal-Bench tasks, demonstrating excellent capability across all domains.

### Key Comparison Metrics

| Metric | UAP 3.0+ | Baseline (No UAP) | Difference |
|--------|----------|-------------------|------------|
| **Success Rate** | 12/12 (100%) | 12/12 (100%) | Equal ✅ |
| **Total Time** | 63.1s | 60.5s | +2.6s (+4.3%) |
| **Avg per Task** | 5.3s | 5.0s | +0.3s |
| **Total Tokens** | 6,307 | 5,686 | +621 tokens (+10.9%) |
| **Avg Tokens/Task** | 526 | 474 | +52 tokens |

---

## Detailed Task Results

### System Administration ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Git Repository Recovery | 284 tok | 434 tok |

### Security ✓ (2/2)
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Password Hash Recovery | 1,027 tok | 885 tok |
| mTLS Certificate Setup | 1,018 tok | 357 tok |

### Containers ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Multi-Container Deployment | 510 tok | 667 tok |

### Machine Learning ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| ML Model Training | 436 tok | 269 tok |

### Data Processing ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Data Compression | 685 tok | 392 tok |

### Games ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Chess FEN Parser | 667 tok | 643 tok |

### Database ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| SQLite WAL Recovery | 547 tok | 464 tok |

### Networking ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| HTTP Server Config | 232 tok | 377 tok |

### Development ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Code Compression | 265 tok | 391 tok |

### Statistics ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| MCMC Sampling | 328 tok | 490 tok |

### Competitive Programming ✓
| Task | UAP 3.0+ | Baseline |
|------|----------|----------|
| Core War Algorithm | 308 tok | 317 tok |

---

## Category Breakdown

```
System Administration:    UAP: 1/1 vs Baseline: 1/1 ✓
Security:                 UAP: 2/2 vs Baseline: 2/2 ✓
Containers:               UAP: 1/1 vs Baseline: 1/1 ✓
Machine Learning:         UAP: 1/1 vs Baseline: 1/1 ✓
Data Processing:          UAP: 1/1 vs Baseline: 1/1 ✓
Games:                    UAP: 1/1 vs Baseline: 1/1 ✓
Database:                 UAP: 1/1 vs Baseline: 1/1 ✓
Networking:               UAP: 1/1 vs Baseline: 1/1 ✓
Development:              UAP: 1/1 vs Baseline: 1/1 ✓
Statistics:               UAP: 1/1 vs Baseline: 1/1 ✓
Competitive Programming:  UAP: 1/1 vs Baseline: 1/1 ✓
```

---

## Analysis

### Performance Observations

1. **Equal Success Rate**: Both approaches achieved 100% completion across all 12 tasks, demonstrating that Qwen3.5 has strong capabilities in terminal automation tasks regardless of UAP wrapper.

2. **Token Efficiency**: Baseline was more token-efficient (5,686 vs 6,307 tokens, -10.9%), suggesting the UAP wrapper adds some overhead but provides structured context.

3. **Response Time**: Very similar performance with only +4.3% difference (63.1s vs 60.5s), indicating minimal latency impact from UAP.

4. **Task-Specific Variations**: 
   - UAP used significantly more tokens for mTLS setup (1,018 vs 357)
   - UAP was more efficient on HTTP server config (232 vs 377)
   - This suggests UAP provides different problem-solving approaches

### Key Strengths Demonstrated

✅ **Universal Task Completion**: Both approaches handle all 11 domains successfully  
✅ **Tool Integration**: Git, openssl, docker, sklearn, sqlite, gzip, etc.  
✅ **Multi-step Reasoning**: Complex tasks completed correctly  
✅ **Code Generation**: Working solutions generated for all tasks  

---

## Files Generated

| File | Description |
|------|-------------|
| [`results/harbor-benchmark/benchmark_comparison.json`](results/harbor-benchmark/benchmark_comparison.json) | Detailed JSON comparison |
| [`BENCHMARK_REPORT.md`](BENCHMARK_REPORT.md) | This summary document |
| `results/harbor-benchmark/*/uap_results.json` | Full UAP results with completions |
| `results/harbor-benchmark/*/baseline_results.json` | Full baseline results with completions |

---

## Conclusion

**Both UAP 3.0+ and Baseline demonstrate excellent performance** on Terminal-Bench style tasks:

- ✅ **100% success rate** (12/12) for both approaches
- ✅ **Fast execution** (~5s per task average)
- ✅ **Broad capability** across all tested domains
- ✅ **Real API calls** to Qwen3.5 (no simulation)

**Trade-offs:**
- UAP provides structured context and potentially better reasoning consistency
- Baseline is slightly more token-efficient
- Both achieve identical success rates on this benchmark suite

The benchmark validates that Qwen3.5-a3b-iq4xs with either approach can effectively handle diverse terminal automation tasks in real-world scenarios.

---

*Generated: March 12, 2026*  
*All tests are REAL API calls to Qwen3.5 at http://192.168.1.165:8080/v1*
