#!/bin/bash
#
# Run UAP Improved Benchmark using Factory API
#
# This benchmark tests UAP memory impact on coding tasks using droid CLI
# which accesses all models through a single Factory API key.
#
# Models tested:
#   - Claude Opus 4.5 (Anthropic)
#   - GPT 5.2 Codex (OpenAI)
#   - GLM 4.7 (Zhipu)
#
# Usage:
#   export FACTORY_API_KEY="your-factory-api-key"
#   ./scripts/run-uap-benchmark.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=================================================="
echo "UAP Improved Benchmark"
echo "=================================================="

# Check for Factory API key
if [ -z "$FACTORY_API_KEY" ] && [ -z "$DROID_API_KEY" ]; then
    echo "Error: FACTORY_API_KEY or DROID_API_KEY must be set"
    echo ""
    echo "The Factory API key provides unified access to:"
    echo "  - Claude Opus 4.5 (Anthropic)"
    echo "  - GPT 5.2 Codex (OpenAI)"
    echo "  - GLM 4.7 (Zhipu)"
    echo ""
    echo "Get your key at: https://app.factory.ai/settings/api-keys"
    exit 1
fi

echo "Factory API key is set ✓"
echo ""

# Verify droid is available
if ! command -v droid &> /dev/null; then
    echo "Error: droid CLI not found"
    echo "Install with: npm install -g @anthropic-ai/droid"
    exit 1
fi

echo "droid CLI is available ✓"
echo ""

# Build project
echo "Building project..."
cd "$PROJECT_ROOT"
npm run build

# Run benchmark
echo ""
echo "Starting benchmark..."
echo "Models: Claude Opus 4.5, GLM 4.7, GPT 5.2 Codex"
echo "Tasks: 6 coding challenges"
echo "Comparison: With vs Without UAP Memory"
echo ""

npx tsx src/benchmarks/improved-benchmark.ts

echo ""
echo "=================================================="
echo "Benchmark Complete"
echo "=================================================="
echo "Results saved to: IMPROVED_BENCHMARK_RESULTS.md"
