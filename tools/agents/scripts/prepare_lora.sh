#!/usr/bin/env bash
# =============================================================================
# Qwen3.5 35B A3B LoRA Tool Call Adapter - Full Automation Script
# =============================================================================
#
# Automates the entire LoRA fine-tuning pipeline from training data generation
# to a ready-to-use GGUF adapter for llama.cpp. One command, one adapter.
#
# Usage:
#   ./tools/agents/scripts/prepare_lora.sh
#   ./tools/agents/scripts/prepare_lora.sh --samples 1000 --epochs 5
#   ./tools/agents/scripts/prepare_lora.sh --trainer unsloth
#   ./tools/agents/scripts/prepare_lora.sh --skip-train  # data gen + convert only
#
# After completion, load in llama.cpp:
#   llama-server --model base.gguf --lora output/qwen35-tool-call-lora/adapter.gguf
#
# Prerequisites:
#   - Python 3.10+ with pip
#   - CUDA GPU with 24GB+ VRAM (for training)
#   - llama.cpp built (for GGUF conversion)
#   - HuggingFace access to Qwen/Qwen3.5-35B-A3B (for base model weights)
#
# =============================================================================

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Defaults (overridable via CLI args or env vars)
SAMPLES="${SAMPLES:-500}"
EPOCHS="${EPOCHS:-3}"
LORA_RANK="${LORA_RANK:-16}"
LORA_ALPHA="${LORA_ALPHA:-32}"
TRAINER="${TRAINER:-unsloth}"          # unsloth | axolotl
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3.5-35B-A3B}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$HOME/llama.cpp}"
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_ROOT/output/qwen35-tool-call-lora}"
TRAINING_DATA="${TRAINING_DATA:-$PROJECT_ROOT/tool_call_training_data.jsonl}"
LORA_CONFIG="${LORA_CONFIG:-$PROJECT_ROOT/config/lora-finetune.yaml}"
SKIP_TRAIN="${SKIP_TRAIN:-false}"
SKIP_CONVERT="${SKIP_CONVERT:-false}"
SEED="${SEED:-42}"
LEARNING_RATE="${LEARNING_RATE:-2e-4}"
BATCH_SIZE="${BATCH_SIZE:-1}"
GRAD_ACCUM="${GRAD_ACCUM:-8}"
SEQ_LEN="${SEQ_LEN:-4096}"

# ── CLI Argument Parsing ──────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Automates Qwen3.5 LoRA tool call adapter preparation.

Options:
  --samples N        Training examples to generate (default: $SAMPLES)
  --epochs N         Training epochs (default: $EPOCHS)
  --rank N           LoRA rank (default: $LORA_RANK)
  --alpha N          LoRA alpha (default: $LORA_ALPHA)
  --trainer NAME     Training framework: unsloth or axolotl (default: $TRAINER)
  --base-model ID    HuggingFace model ID (default: $BASE_MODEL)
  --llama-cpp DIR    Path to llama.cpp repo (default: $LLAMA_CPP_DIR)
  --output DIR       Output directory (default: $OUTPUT_DIR)
  --lr RATE          Learning rate (default: $LEARNING_RATE)
  --batch-size N     Micro batch size (default: $BATCH_SIZE)
  --grad-accum N     Gradient accumulation steps (default: $GRAD_ACCUM)
  --seq-len N        Max sequence length (default: $SEQ_LEN)
  --seed N           Random seed (default: $SEED)
  --skip-train       Skip training, only generate data + convert existing adapter
  --skip-convert     Skip GGUF conversion (output HuggingFace format only)
  --help             Show this help message

Examples:
  # Default: 500 samples, 3 epochs, unsloth trainer
  $(basename "$0")

  # More data, more epochs
  $(basename "$0") --samples 1000 --epochs 5

  # Use axolotl instead of unsloth
  $(basename "$0") --trainer axolotl

  # Just regenerate training data and convert existing adapter
  $(basename "$0") --skip-train

After completion, load in llama.cpp:
  llama-server --model base.gguf \\
    --lora $OUTPUT_DIR/adapter.gguf \\
    --lora-scale 1.0
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --samples)     SAMPLES="$2"; shift 2 ;;
        --epochs)      EPOCHS="$2"; shift 2 ;;
        --rank)        LORA_RANK="$2"; shift 2 ;;
        --alpha)       LORA_ALPHA="$2"; shift 2 ;;
        --trainer)     TRAINER="$2"; shift 2 ;;
        --base-model)  BASE_MODEL="$2"; shift 2 ;;
        --llama-cpp)   LLAMA_CPP_DIR="$2"; shift 2 ;;
        --output)      OUTPUT_DIR="$2"; shift 2 ;;
        --lr)          LEARNING_RATE="$2"; shift 2 ;;
        --batch-size)  BATCH_SIZE="$2"; shift 2 ;;
        --grad-accum)  GRAD_ACCUM="$2"; shift 2 ;;
        --seq-len)     SEQ_LEN="$2"; shift 2 ;;
        --seed)        SEED="$2"; shift 2 ;;
        --skip-train)  SKIP_TRAIN=true; shift ;;
        --skip-convert) SKIP_CONVERT=true; shift ;;
        --help|-h)     usage ;;
        *)             echo "Unknown option: $1"; usage ;;
    esac
done

# ── Logging ───────────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
info() { log "INFO  $*"; }
warn() { log "WARN  $*"; }
err()  { log "ERROR $*" >&2; }
die()  { err "$*"; exit 1; }

# ── Preflight Checks ─────────────────────────────────────────────────────────

preflight() {
    info "=== Preflight Checks ==="

    # Python
    command -v python3 >/dev/null 2>&1 || die "python3 not found"
    PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    info "Python: $PYTHON_VERSION"

    # Training data generator
    [[ -f "$SCRIPT_DIR/generate_lora_training_data.py" ]] || \
        die "generate_lora_training_data.py not found at $SCRIPT_DIR"

    # Trainer
    if [[ "$SKIP_TRAIN" != "true" ]]; then
        case "$TRAINER" in
            unsloth)
                python3 -c "import unsloth" 2>/dev/null || {
                    warn "unsloth not installed. Installing..."
                    pip install unsloth 2>/dev/null || die "Failed to install unsloth"
                }
                info "Trainer: unsloth"
                ;;
            axolotl)
                python3 -c "import axolotl" 2>/dev/null || {
                    warn "axolotl not installed. Installing..."
                    pip install axolotl 2>/dev/null || die "Failed to install axolotl"
                }
                info "Trainer: axolotl"
                ;;
            *)
                die "Unknown trainer: $TRAINER (use 'unsloth' or 'axolotl')"
                ;;
        esac

        # CUDA
        python3 -c "import torch; assert torch.cuda.is_available()" 2>/dev/null || \
            warn "CUDA not available - training will be very slow on CPU"
    fi

    # llama.cpp conversion script
    if [[ "$SKIP_CONVERT" != "true" ]]; then
        CONVERT_SCRIPT="$LLAMA_CPP_DIR/convert_lora_to_gguf.py"
        [[ -f "$CONVERT_SCRIPT" ]] || \
            die "convert_lora_to_gguf.py not found at $CONVERT_SCRIPT"
        info "GGUF converter: $CONVERT_SCRIPT"
    fi

    info "Base model: $BASE_MODEL"
    info "Output: $OUTPUT_DIR"
    info "Preflight OK"
    echo
}

# ── Step 1: Generate Training Data ───────────────────────────────────────────

generate_training_data() {
    info "=== Step 1/4: Generating Training Data ==="
    info "Samples: $SAMPLES | Seed: $SEED"

    python3 "$SCRIPT_DIR/generate_lora_training_data.py" \
        --output "$TRAINING_DATA" \
        --count "$SAMPLES" \
        --seed "$SEED"

    LINES=$(wc -l < "$TRAINING_DATA")
    info "Generated $LINES training examples -> $TRAINING_DATA"

    # Validate a sample
    FIRST=$(head -1 "$TRAINING_DATA")
    python3 -c "
import json, sys
d = json.loads('''$FIRST''')
assert 'messages' in d, 'Missing messages key'
roles = [m['role'] for m in d['messages']]
assert 'user' in roles, 'Missing user role'
assert 'assistant' in roles, 'Missing assistant role'
print('  Validation: OK (roles: ' + ', '.join(set(roles)) + ')')
" || warn "Training data validation failed - check format"

    echo
}

# ── Step 2: Generate Training Config ─────────────────────────────────────────

generate_config() {
    info "=== Step 2/4: Generating Training Config ==="

    mkdir -p "$OUTPUT_DIR"

    # Generate a runtime config with CLI overrides applied
    RUNTIME_CONFIG="$OUTPUT_DIR/train-config.yaml"

    cat > "$RUNTIME_CONFIG" <<YAML
# Auto-generated by prepare_lora.sh at $(date -Iseconds)
# Base config: $LORA_CONFIG

# Base model
base_model: $BASE_MODEL
model_type: AutoModelForCausalLM
tokenizer_type: AutoTokenizer
trust_remote_code: true

# LoRA configuration
adapter: lora
lora_r: $LORA_RANK
lora_alpha: $LORA_ALPHA
lora_dropout: 0.05
lora_target_modules:
  - q_proj
  - k_proj
  - v_proj
  - o_proj
  - gate_proj
  - up_proj
  - down_proj
lora_target_linear: true

# Dataset
datasets:
  - path: $TRAINING_DATA
    type: chat_template
    chat_template: chatml
    field_messages: messages

# Training parameters
num_epochs: $EPOCHS
micro_batch_size: $BATCH_SIZE
gradient_accumulation_steps: $GRAD_ACCUM
learning_rate: $LEARNING_RATE
lr_scheduler: cosine
warmup_ratio: 0.1
optimizer: adamw_torch
weight_decay: 0.01
max_grad_norm: 1.0

# Sequence length
sequence_len: $SEQ_LEN
sample_packing: true
pad_to_sequence_len: true

# Memory optimization
bf16: true
tf32: true
gradient_checkpointing: true
flash_attention: true

# Output
output_dir: $OUTPUT_DIR
save_strategy: epoch
save_total_limit: 2
logging_steps: 10

# Evaluation
val_set_size: 0.05
eval_steps: 50

# Special tokens
special_tokens:
  pad_token: '<|endoftext|>'
YAML

    info "Config written -> $RUNTIME_CONFIG"
    info "  LoRA rank=$LORA_RANK alpha=$LORA_ALPHA"
    info "  Epochs=$EPOCHS LR=$LEARNING_RATE Batch=$BATCH_SIZE GradAccum=$GRAD_ACCUM"
    echo
}

# ── Step 3: Train LoRA Adapter ───────────────────────────────────────────────

train_adapter() {
    if [[ "$SKIP_TRAIN" == "true" ]]; then
        info "=== Step 3/4: Training SKIPPED (--skip-train) ==="
        echo
        return
    fi

    info "=== Step 3/4: Training LoRA Adapter ==="
    info "Trainer: $TRAINER | Epochs: $EPOCHS | Rank: $LORA_RANK"

    RUNTIME_CONFIG="$OUTPUT_DIR/train-config.yaml"
    TRAIN_START=$(date +%s)

    case "$TRAINER" in
        unsloth)
            info "Starting unsloth training..."
            python3 -c "
import sys
sys.path.insert(0, '.')
from unsloth import FastLanguageModel
from datasets import load_dataset
import yaml, json

# Load config
with open('$RUNTIME_CONFIG') as f:
    config = yaml.safe_load(f)

print(f'Loading base model: {config[\"base_model\"]}')
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=config['base_model'],
    max_seq_length=config['sequence_len'],
    dtype=None,
    load_in_4bit=True,
)

print(f'Applying LoRA: rank={config[\"lora_r\"]}, alpha={config[\"lora_alpha\"]}')
model = FastLanguageModel.get_peft_model(
    model,
    r=config['lora_r'],
    lora_alpha=config['lora_alpha'],
    lora_dropout=config.get('lora_dropout', 0.05),
    target_modules=config['lora_target_modules'],
    bias='none',
    use_gradient_checkpointing='unsloth',
)

# Load dataset
print(f'Loading dataset: {config[\"datasets\"][0][\"path\"]}')
dataset = load_dataset('json', data_files=config['datasets'][0]['path'], split='train')

# Format for training
from trl import SFTTrainer
from transformers import TrainingArguments

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=TrainingArguments(
        output_dir=config['output_dir'],
        num_train_epochs=config['num_epochs'],
        per_device_train_batch_size=config['micro_batch_size'],
        gradient_accumulation_steps=config['gradient_accumulation_steps'],
        learning_rate=float(config['learning_rate']),
        lr_scheduler_type=config['lr_scheduler'],
        warmup_ratio=config.get('warmup_ratio', 0.1),
        weight_decay=config.get('weight_decay', 0.01),
        max_grad_norm=config.get('max_grad_norm', 1.0),
        bf16=config.get('bf16', True),
        tf32=config.get('tf32', True),
        logging_steps=config.get('logging_steps', 10),
        save_strategy=config.get('save_strategy', 'epoch'),
        save_total_limit=config.get('save_total_limit', 2),
        seed=$SEED,
    ),
    max_seq_length=config['sequence_len'],
    packing=config.get('sample_packing', True),
)

print('Starting training...')
trainer.train()

print(f'Saving adapter to {config[\"output_dir\"]}')
model.save_pretrained(config['output_dir'])
tokenizer.save_pretrained(config['output_dir'])
print('Training complete.')
"
            ;;
        axolotl)
            info "Starting axolotl training..."
            accelerate launch -m axolotl.cli.train "$RUNTIME_CONFIG"
            ;;
    esac

    TRAIN_END=$(date +%s)
    TRAIN_DURATION=$((TRAIN_END - TRAIN_START))
    info "Training completed in ${TRAIN_DURATION}s"

    # Verify adapter files exist
    if [[ -f "$OUTPUT_DIR/adapter_model.safetensors" ]] || \
       [[ -f "$OUTPUT_DIR/adapter_model.bin" ]]; then
        info "Adapter saved -> $OUTPUT_DIR"
    else
        # Check for checkpoint subdirectories
        LATEST_CHECKPOINT=$(ls -td "$OUTPUT_DIR"/checkpoint-* 2>/dev/null | head -1)
        if [[ -n "$LATEST_CHECKPOINT" ]]; then
            info "Adapter saved in checkpoint -> $LATEST_CHECKPOINT"
            # Copy to output root for conversion
            cp "$LATEST_CHECKPOINT"/adapter_* "$OUTPUT_DIR/" 2>/dev/null || true
            cp "$LATEST_CHECKPOINT"/adapter_config.json "$OUTPUT_DIR/" 2>/dev/null || true
        else
            warn "No adapter files found in $OUTPUT_DIR"
        fi
    fi

    echo
}

# ── Step 4: Convert to GGUF ──────────────────────────────────────────────────

convert_to_gguf() {
    if [[ "$SKIP_CONVERT" == "true" ]]; then
        info "=== Step 4/4: GGUF Conversion SKIPPED (--skip-convert) ==="
        echo
        return
    fi

    info "=== Step 4/4: Converting to GGUF ==="

    CONVERT_SCRIPT="$LLAMA_CPP_DIR/convert_lora_to_gguf.py"
    GGUF_OUTPUT="$OUTPUT_DIR/adapter.gguf"

    # Check for adapter files
    if [[ ! -f "$OUTPUT_DIR/adapter_config.json" ]]; then
        die "No adapter_config.json found in $OUTPUT_DIR - training may have failed"
    fi

    info "Converting HuggingFace adapter -> GGUF"
    info "  Input:  $OUTPUT_DIR"
    info "  Output: $GGUF_OUTPUT"

    python3 "$CONVERT_SCRIPT" \
        --base "$BASE_MODEL" \
        --lora "$OUTPUT_DIR" \
        --outfile "$GGUF_OUTPUT"

    if [[ -f "$GGUF_OUTPUT" ]]; then
        GGUF_SIZE=$(du -h "$GGUF_OUTPUT" | cut -f1)
        info "GGUF adapter created: $GGUF_OUTPUT ($GGUF_SIZE)"
    else
        die "GGUF conversion failed - no output file"
    fi

    echo
}

# ── Summary ──────────────────────────────────────────────────────────────────

print_summary() {
    GGUF_OUTPUT="$OUTPUT_DIR/adapter.gguf"

    echo "=================================================================="
    echo "  LoRA Adapter Preparation Complete"
    echo "=================================================================="
    echo
    echo "  Training data:  $TRAINING_DATA ($SAMPLES examples)"
    echo "  LoRA config:    rank=$LORA_RANK alpha=$LORA_ALPHA"
    echo "  Training:       $EPOCHS epochs, $TRAINER"
    echo "  Output dir:     $OUTPUT_DIR"

    if [[ -f "$GGUF_OUTPUT" ]]; then
        GGUF_SIZE=$(du -h "$GGUF_OUTPUT" | cut -f1)
        echo "  GGUF adapter:   $GGUF_OUTPUT ($GGUF_SIZE)"
        echo
        echo "  Load in llama.cpp:"
        echo "    llama-server \\"
        echo "      --model /path/to/Qwen3.5-35B-A3B.gguf \\"
        echo "      --lora $GGUF_OUTPUT \\"
        echo "      --lora-scale 1.0 \\"
        echo "      --chat-template-file chat_template.jinja"
    else
        echo "  GGUF adapter:   (not generated)"
        echo
        echo "  To convert manually:"
        echo "    python3 $LLAMA_CPP_DIR/convert_lora_to_gguf.py \\"
        echo "      --base $BASE_MODEL \\"
        echo "      --lora $OUTPUT_DIR \\"
        echo "      --outfile $OUTPUT_DIR/adapter.gguf"
    fi

    echo
    echo "  Test the adapter:"
    echo "    python3 tools/agents/scripts/qwen_tool_call_test.py --verbose"
    echo
    echo "=================================================================="
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    info "Qwen3.5 35B A3B LoRA Tool Call Adapter Preparation"
    info "Project root: $PROJECT_ROOT"
    echo

    preflight
    generate_training_data
    generate_config
    train_adapter
    convert_to_gguf
    print_summary
}

main "$@"
