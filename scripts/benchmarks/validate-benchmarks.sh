#!/bin/bash
# scripts/validate-benchmarks.sh
#
# Run benchmark validation for UAP token optimization
# Compares baseline (without UAP) vs UAP-enhanced performance
#
# Usage: ./scripts/validate-benchmarks.sh

set -euo pipefail

echo "========================================"
echo "=== UAP Benchmark Validation ==="
echo "========================================"
echo ""

# Create results directory
mkdir -p results/benchmarks

# Check for Python 3
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    echo "   Install Python 3 and try again."
    exit 1
fi

# Run baseline tests (without UAP)
echo "📊 Running baseline tests (without UAP)..."
echo "   This may take several minutes..."
python3 scripts/run_baseline_benchmark.py > results/baseline_results.json 2>&1
echo "✅ Baseline tests complete. Results: results/baseline_results.json"
echo ""

# Run UAP-enhanced tests
echo "📊 Running UAP-enhanced tests..."
echo "   This may take several minutes..."
python3 scripts/run_uap_benchmark.py > results/uap_results.json 2>&1
echo "✅ UAP tests complete. Results: results/uap_results.json"
echo ""

# Compare results
echo "📊 Comparing results..."
python3 scripts/compare_benchmarks.py \
  results/baseline_results.json \
  results/uap_results.json \
  > results/comparison_results.json 2>&1
echo "✅ Comparison complete. Results: results/comparison_results.json"
echo ""

# Generate validation report
echo "📊 Generating validation report..."
python3 scripts/generate_validation_report.py \
  results/baseline_results.json \
  results/uap_results.json \
  results/comparison_results.json \
  > docs/VALIDATION_RESULTS.md 2>&1
echo "✅ Report generated. See: docs/VALIDATION_RESULTS.md"
echo ""

# Print summary
echo "========================================"
echo "=== Validation Summary ==="
echo "========================================"
cat results/comparison_results.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
summary = data.get('summary', {})
print(f\"Average Token Reduction: {summary.get('avg_token_reduction', 0):.1f}%\")
print(f\"Average Time Reduction: {summary.get('avg_time_reduction', 0):.1f}%\")
print(f\"Baseline Success Rate: {summary.get('baseline_success_rate', 0):.0%}\")
print(f\"UAP Success Rate: {summary.get('uap_success_rate', 0):.0%}\")
print()
print('📄 Full report: docs/VALIDATION_RESULTS.md')
print('📊 Comparison data: results/comparison_results.json')
"
echo ""
echo "========================================"
echo "✅ Validation complete!"
echo "========================================"