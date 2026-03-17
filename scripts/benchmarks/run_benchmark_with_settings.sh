#!/bin/bash

# Run benchmarks with Qwen3.5 optimized parameters
set -e

API_ENDPOINT="${API_ENDPOINT:-http://192.168.1.165:8080/v1}"
MODEL_NAME="qwen3.5-a3b-iq4xs"

# Default to general thinking mode for most tasks
PROMPT_MODE="${PROMPT_MODE:-coding_precise_thinking}"

case "$PROMPT_MODE" in
  "general")
    TEMPERATURE=1.0; TOP_P=0.95; PRESENCE_PENALTY=1.5 ;;
  "coding") 
    TEMPERATURE=0.6; TOP_P=0.95; PRESENCE_PENALTY=0 ;;
  "reasoning")
    TEMPERATURE=1.0; TOP_P=1.0; TOP_K=40; PRESENCE_PENALTY=2.0 ;;
  *) 
    TEMPERATURE=0.7; TOP_P=0.8; PRESENCE_PENALTY=1.5 ;;
esac

echo "Running with Qwen3.5 settings:"
echo "  Mode: $PROMPT_MODE"
echo "  Temperature: $TEMPERATURE"
echo "  Top P: $TOP_P"  
echo "  Presence Penalty: $PRESENCE_PENALTY"

# Run the benchmark with these parameters
python3 run_benchmark.py --temperature "$TEMPERATURE" \
                        --top_p "$TOP_P" \
                        --presence_penalty "$PRESENCE_PENALTY" \
                        --api_endpoint "$API_ENDPOINT" \
                        --model_name "$MODEL_NAME"

