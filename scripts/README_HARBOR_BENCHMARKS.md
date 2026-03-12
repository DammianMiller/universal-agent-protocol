# Running Harbor Containerized Benchmarks for Qwen3.5

This directory contains all necessary configurations to run full containerized benchmarks using the official Terminal-Bench (Harbor) test harness against both UAP 3.0+OpenCode and BASELINE configurations with qwen/qwen35-a3b-iq4xs model.

## Quick Start

### Option A: Direct API Benchmarking (Recommended for Local Development)
```bash
# Run the comprehensive benchmark scripts we already executed successfully
cd /home/cogtek/dev/miller-tech/universal-agent-memory

# UAP 3.0+OpenCode configuration
npx tsx scripts/benchmark-qwen35-uap-3.0-opencode.tsx > results_uap.log 2>&1 &

# Baseline (No UAP)  
npx tsx scripts/benchmark-qwen35-baseline-no-uap.tsx > results_baseline.log 2>&1 &

# Wait for completion and view results
sleep 600 && tail -f results_*.log
```

### Option B: Full Harbor Containerized Execution (Production)
For fully isolated container runs with proper environment replication:

#### Prerequisites
- Docker installed and running (`docker ps` should work)
- Qwen3.5 model server accessible from containers OR expose via network
- UAP memory system shared between host/container for fair comparison

```bash
# 1. Ensure Harbor CLI is available  
which harbor && echo "✓ Harbor detected" || exit 1

# 2. Run containerized benchmarks (one at a time to avoid resource contention)
harbor run \
    --config ./harbor-configs/qwen35_uap_quick_suite.yaml \
    --results-dir ./benchmark-results/harbor_containers/uap_$(date +%Y%m%d_%H%M%S) \
    --n-concurrent 1

# Then for baseline comparison:  
harbor run \
    --config ./harbor-configs/qwen35_baseline_no_uap.yaml \
    --results-dir ./benchmark-results/harbor_containers/baseline_$(date +%Y%m%d_%H%M%S) \
    --n-concurrent 1

# 3. View results in Harbor web UI (optional)  
harbor view &
```

## Configuration Files

### `./harbor-configs/qwen35_uap_quick_suite.yaml`
- **Purpose**: Benchmark Qwen3.5 with full UAP integration enabled
- **Tasks**: 14 representative tasks covering all major categories
- **Environment Variables Set**:
  - `USE_UAM=true` (enables memory system)
  - `UAP_MEMORY_ENABLED=true`  
  - `UAP_PATTERNS_RAG_ENABLED=true`

### `./harbor-configs/qwen35_baseline_no_uap.yaml`
- **Purpose**: Baseline comparison without any UAP features
- **Tasks**: Same 14 tasks for fair A/B testing
- **Environment Variables Set**:
  - `USE_UAM=false` (no memory, no patterns)

## Expected Results (Based on Direct API Tests)

| Metric | UAP + OpenCode | Baseline No UAP |
|--------|---------------|-----------------|
| Success Rate | ~100% | ~100% |
| Avg Duration/Task | 5.84s | 4.27s (+36% faster baseline) |
| Tokens/Task | 858 tokens | 481 tokens (UAP +78%) |

For detailed comparison report, see: `../benchmark-results/UAP_VS_BASELINE_COMPARISON_REPORT.md`

## Results Location

After running benchmarks, results will be in:
```
./benchmark-results/
├── qwen35_uap_3.0_opencode/           # Direct API benchmark (completed)  
│   ├── qwen35_uap_*.json              # Full JSON results with task details
│   └── QWEN35_UAP_*REPORT.md          # Markdown analysis report
├── qwen35_baseline_no_uap/            # Baseline direct API benchmark (completed)
│   ├── baseline_progress.log          # Execution log  
│   └── [additional files...]
├── harbor_containers/                  # Future containerized results will go here
│   └── uap_2026-03-12_/              # Run-specific directory with Harbor format output
└── HARBOR_COMPATIBILITY_REPORT.md     # Summary of integration status and how-to guide
```

## Troubleshooting

### Model Server Not Accessible from Containers
If your Qwen3.5 server runs on localhost:8080 but containers can't reach it, you have two options:

**Option 1**: Use host networking (Docker-specific)
```bash
docker run --network="host" ... # Harbor will use this flag automatically if available
```

**Option 2**: Expose model server externally and point Qwen3.5 endpoint to public URL in config files

### UAP Memory System Not Found
For containerized runs that need persistent memory:
- Mount the SQLite database as a volume: `-v ./agents/data/memory:/app/agents/data/memory`  
- Use external Qdrant instance accessible via network rather than relying on localhost inside containers

## Next Steps for Production Deployment

1. **Review results** from direct API benchmarks (already completed successfully)
2. **Run containerized tests** using Option B above if you need strict environment isolation
3. **Compare metrics** between approaches to validate consistency  
4. **Implement hybrid approach** recommended in comparison report (~650 tokens/task target)

---

*Generated: 2026-03-12 | Harbor CLI version checked and confirmed working at /home/cogtek/.local/bin/harbor*
