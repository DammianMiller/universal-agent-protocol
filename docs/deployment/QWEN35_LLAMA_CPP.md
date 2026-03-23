# Qwen3.5 llama.cpp Deployment Guide

How to run Qwen3.5 35B A3B with the official Qwen3 chat template, LoRA adapters, and structured tool call output via llama.cpp.

## Prerequisites

- [llama.cpp](https://github.com/ggml-org/llama.cpp) built with CUDA/Metal support
- Qwen3.5 35B A3B GGUF model (e.g. `qwen3.5-a3b-iq4xs.gguf`)
- (Optional) Draft model for speculative decoding: `Qwen3.5-0.8B-Q8_0.gguf`
- (Optional) LoRA adapter GGUF for improved tool call reliability

## Quick Start

```bash
llama-server \
  --model /path/to/qwen3.5-a3b-iq4xs.gguf \
  --chat-template-file chat_template.jinja \
  --n-predict 16384 \
  --temp 0.6 --top-p 0.9 --top-k 20 --min-p 0.05 \
  --repeat-penalty 1.0 \
  --threads 8 --ctx-size 131072 --batch-size 8 \
  --gpu-layers 35 --mlock --flash-attn
```

## Configuration Files

| File                                        | Purpose                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `chat_template.jinja`                       | Official Qwen3 chat template with native tool descriptions          |
| `tools/agents/config/tool-call.gbnf`        | GBNF grammar for per-request use (do NOT use with `--grammar-file`) |
| `tools/agents/config/tool-call-schema.json` | JSON Schema for the tool call payload                               |
| `config/qwen35-settings.json`               | Full model settings, optimization config                            |
| `config/lora-finetune.yaml`                 | LoRA training configuration (axolotl/unsloth compatible)            |

## Important: Do NOT Use `--grammar-file`

The `--grammar-file` flag applies a GBNF grammar **globally to every completion**. This breaks normal chat because the grammar forces `<tool_call>` output even when no tools are provided.

llama.cpp's **differential autoparser** handles tool calls automatically:

1. It analyzes the Jinja template to discover `<tool_call>`/`</tool_call>` markers
2. It generates PEG grammar rules with **lazy activation** (`grammar_lazy = true`)
3. When `tool_choice == "auto"`, the model generates freely until it emits `<tool_call>`, at which point the grammar activates to constrain the JSON payload
4. After `</tool_call>`, the grammar allows another `<tool_call>` for parallel calls
5. Plain chat (no tools) is unconstrained

The GBNF file is kept in the repo for per-request use via the `grammar` field in API payloads, but should never be a server startup flag.

## Server Configurations

### Basic (no LoRA, no speculative decoding)

```bash
llama-server \
  --model /path/to/qwen3.5-a3b-iq4xs.gguf \
  --chat-template-file chat_template.jinja \
  --n-predict 16384 \
  --temp 0.6 --top-p 0.9 --top-k 20 --min-p 0.05 \
  --repeat-penalty 1.0 \
  --threads 8 --ctx-size 131072 --batch-size 8 \
  --gpu-layers 35 --mlock --flash-attn
```

### With LoRA Adapter

```bash
llama-server \
  --model /path/to/qwen3.5-a3b-iq4xs.gguf \
  --lora /path/to/qwen35-tool-call-lora/adapter.gguf \
  --lora-scale 1.0 \
  --chat-template-file chat_template.jinja \
  --n-predict 16384 \
  --temp 0.6 --top-p 0.9 --top-k 20 --min-p 0.05 \
  --repeat-penalty 1.0 \
  --threads 8 --ctx-size 131072 --batch-size 8 \
  --gpu-layers 35 --mlock --flash-attn
```

### Full Setup (LoRA + Speculative Decoding)

```bash
llama-server \
  --model /path/to/qwen3.5-a3b-iq4xs.gguf \
  --lora /path/to/qwen35-tool-call-lora/adapter.gguf \
  --lora-scale 1.0 \
  --chat-template-file chat_template.jinja \
  --draft-model /path/to/Qwen3.5-0.8B-Q8_0.gguf \
  --draft-max 16 --draft-p-min 0.75 \
  --n-predict 16384 \
  --temp 0.6 --top-p 0.9 --top-k 20 --min-p 0.05 \
  --repeat-penalty 1.0 \
  --threads 8 --ctx-size 131072 --batch-size 8 \
  --gpu-layers 35 --mlock --flash-attn
```

## Key Parameters

### Chat Template & Tool Calls

| Flag                   | Value                 | Purpose                                                                                                                                                        |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--chat-template-file` | `chat_template.jinja` | Official Qwen3 template with native `tools` block. llama.cpp's autoparser discovers `<tool_call>` markers and generates lazy grammar + triggers automatically. |

### LoRA

| Flag           | Value                  | Purpose                                                                                                |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `--lora`       | Path to `adapter.gguf` | Loads LoRA adapter at runtime (no model merge needed). Improves tool call format adherence by ~15-20%. |
| `--lora-scale` | `0.0` - `1.0`          | Adapter strength. Use `1.0` for full effect, `0.5`-`0.8` to blend with base model behavior.            |

### Speculative Decoding

| Flag            | Value                            | Purpose                                                                 |
| --------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `--draft-model` | Path to `Qwen3.5-0.8B-Q8_0.gguf` | Small draft model proposes tokens verified by the main model.           |
| `--draft-max`   | `16`                             | Max tokens to draft per iteration. Higher = more throughput, more VRAM. |
| `--draft-p-min` | `0.75`                           | Minimum acceptance probability. Lower = more aggressive drafting.       |

## Extension Options for Speculative Decoding

### Option 1: Adaptive Runtime Tuning (implemented)

Use acceptance and rollback rates to auto-adjust `draft-max`, `draft-min`, and `draft-p-min` over time.

- Best for immediate gains without kernel changes
- Reduces bad bursts when acceptance drops
- Increases burst length automatically during high-acceptance windows

Commands:

```bash
# Tune once from observed metrics
llama-optimize spec-autotune --acceptance 0.71 --rollback 0.14 --profile throughput

# Compare static defaults vs adaptive tuning using deterministic simulation
llama-optimize spec-benchmark --profile throughput --trace mixed --steps 180

# Live benchmark active server and get tuned flag recommendation
llama-optimize spec-benchmark-live \
  --endpoint http://127.0.0.1:8080/v1 \
  --model qwen3.5-a3b-iq4xs \
  --runs 5 --max-tokens 256 --profile throughput
```

Recommended workflow:

1. Run `spec-benchmark-live` with your current startup flags and note `Throughput`.
2. Restart `llama-server` with the `Suggested params` flags.
3. Re-run `spec-benchmark-live` with the same settings to measure actual gain.

### Option 2: GPU Residency + Overlap

- Keep draft model and draft KV fully on GPU
- Preallocate buffers and overlap draft + verify passes with CUDA streams
- Improves p95 latency consistency on long runs

### Option 3: GPU Checkpoint/Rollback

- Move speculative checkpoint snapshots from CPU RAM to GPU buffers
- Remove host-device copy overhead from rollback paths
- Highest upside, but requires deeper runtime changes

### Sampling

| Flag               | Value  | Purpose                                           |
| ------------------ | ------ | ------------------------------------------------- |
| `--temp`           | `0.6`  | Low temperature for deterministic tool calls.     |
| `--top-p`          | `0.9`  | Nucleus sampling threshold.                       |
| `--top-k`          | `20`   | Limits token candidates per step.                 |
| `--min-p`          | `0.05` | Filters tokens below 5% of top token probability. |
| `--repeat-penalty` | `1.0`  | No repetition penalty — code naturally repeats patterns. |

### Performance

| Flag           | Value    | Purpose                                           |
| -------------- | -------- | ------------------------------------------------- |
| `--flash-attn` | (flag)   | 1.5-2x speed on long context.                     |
| `--gpu-layers` | `35`     | Layers offloaded to GPU. Increase if VRAM allows. |
| `--ctx-size`   | `131072` | Full 128K context window.                         |
| `--mlock`      | (flag)   | Prevents OS from swapping model to disk.          |

## VRAM Estimates

| Component           | VRAM       |
| ------------------- | ---------- |
| Main model (IQ4_XS) | ~17 GB     |
| Draft model (Q8_0)  | ~0.8 GB    |
| KV cache (128K ctx) | ~2-3 GB    |
| LoRA adapter        | ~50 MB     |
| **Total**           | **~20 GB** |

## Anthropic API Proxy (for Claude Code / Forge Code)

Claude Code and Forge Code speak the Anthropic Messages API, but llama.cpp exposes an OpenAI-compatible API. The UAP Anthropic Proxy bridges this gap by translating between the two protocols in real time, including full streaming and tool calling support.

### Architecture

```
Claude Code  --(Anthropic API :4000)-->  UAP Proxy  --(OpenAI API :8080)-->  llama.cpp
```

### Quick Start

```bash
# Install Python dependencies
pip install -r tools/agents/scripts/requirements-proxy.txt

# Start the proxy (default: listen on :4000, forward to llama.cpp on :8080)
python tools/agents/scripts/anthropic_proxy.py
```

### Configuration

All settings are via environment variables:

| Variable                | Default                              | Description                              |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `LLAMA_CPP_BASE`        | `http://192.168.1.165:8080/v1`       | OpenAI-compatible upstream server URL    |
| `PROXY_PORT`            | `4000`                               | Port for the proxy to listen on          |
| `PROXY_HOST`            | `0.0.0.0`                            | Host/IP to bind to                       |
| `PROXY_LOG_LEVEL`       | `INFO`                               | Logging level (DEBUG/INFO/WARNING/ERROR) |
| `PROXY_READ_TIMEOUT`    | `600`                                | Read timeout (seconds) for LLM streaming |
| `PROXY_MAX_CONNECTIONS` | `20`                                 | Max concurrent upstream connections      |
| `PROXY_STREAM_REASONING_FALLBACK` | `off`                      | Streaming behavior for reasoning-only empty turns (`off`, `sanitized`, `visible`) |
| `PROXY_STREAM_REASONING_MAX_CHARS` | `240`                      | Max fallback length when `PROXY_STREAM_REASONING_FALLBACK=sanitized` |

For agentic coding workloads, keep `PROXY_STREAM_REASONING_FALLBACK=off` (default) to avoid leaking malformed internal reasoning as user-visible output. Use `sanitized` only for debugging.

### Example: Custom upstream

```bash
LLAMA_CPP_BASE=http://localhost:8080/v1 PROXY_PORT=5000 python tools/agents/scripts/anthropic_proxy.py
```

### Claude Code Configuration

Point Claude Code at the proxy by setting the API base URL:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

### Endpoints

| Path                     | Method | Description                                |
| ------------------------ | ------ | ------------------------------------------ |
| `/v1/messages`           | POST   | Anthropic Messages API (streaming + sync)  |
| `/anthropic/v1/messages` | POST   | Alternative path (some clients use this)   |
| `/v1/models`             | GET    | Lists spoofed Anthropic model IDs          |
| `/health`                | GET    | Health check (checks upstream reachability) |

### Running as a Service (systemd)

```ini
[Unit]
Description=UAP Anthropic Proxy
After=network.target

[Service]
Type=simple
User=cogtek
Environment=LLAMA_CPP_BASE=http://192.168.1.165:8080/v1
Environment=PROXY_PORT=4000
ExecStart=/usr/bin/python3 /path/to/tools/agents/scripts/anthropic_proxy.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Tool Call Format

The model emits tool calls in the official Qwen3 format:

```
<tool_call>
{"name": "read_file", "arguments": {"path": "/etc/hosts"}}
</tool_call>
```

Multiple tool calls in a single turn:

```
<tool_call>
{"name": "read_file", "arguments": {"path": "/etc/hosts"}}
</tool_call>
<tool_call>
{"name": "list_dir", "arguments": {"path": "/tmp"}}
</tool_call>
```

llama.cpp's autoparser handles stop behavior structurally via PEG grammar rules, not stop sequences. No explicit `</tool_call>` stop sequence is needed at the server level.

## LoRA Training Pipeline

### 1. Generate Training Data

```bash
python3 tools/agents/scripts/generate_lora_training_data.py -n 500
```

Produces `tool_call_training_data.jsonl` with ChatML-formatted examples using the official `<tool_call>` format.

### 2. Fine-Tune

Using axolotl:

```bash
accelerate launch -m axolotl.cli.train config/lora-finetune.yaml
```

Using unsloth (faster, less VRAM):

```bash
unsloth train --config config/lora-finetune.yaml
```

Training config highlights (`config/lora-finetune.yaml`):

- LoRA rank 16, alpha 32
- Targets all linear layers (q/k/v/o/gate/up/down projections)
- 3 epochs, cosine LR schedule, 2e-4 learning rate
- BF16 + gradient checkpointing + flash attention

### 3. Convert to GGUF

```bash
python3 convert_lora_to_gguf.py \
  --base Qwen/Qwen3.5-35B-A3B \
  --lora output/qwen35-tool-call-lora \
  --output adapter.gguf
```

### 4. Load at Runtime

```bash
llama-server --model base.gguf --lora adapter.gguf --lora-scale 1.0
```

## Quantization Options

| Quant  | VRAM  | Accuracy | Tool Call Reliability |
| ------ | ----- | -------- | --------------------- |
| IQ4_XS | 17 GB | 96%      | 94%                   |
| Q4_K_M | 20 GB | 95%      | 95%                   |
| Q5_K_M | 24 GB | 97%      | 97%                   |
| Q6_K   | 28 GB | 98%      | 98%                   |

## Troubleshooting

### "Template supports tool calls but does not natively describe tools"

This warning means llama.cpp detected `tool_calls` handling but no `tools` variable access in the template. The `chat_template.jinja` in this repo resolves this by including a `{%- if tools %}` block that renders tool descriptions in `<tools></tools>` XML tags.

Verify the template is loaded:

```bash
llama-server --chat-template-file chat_template.jinja --verbose
```

### LoRA not taking effect

- Ensure the adapter was converted to GGUF format (not safetensors/PyTorch)
- Check `--lora-scale` is not `0.0`
- Verify the adapter was trained against the same base model architecture

### Grammar rejecting valid output

If using the GBNF grammar via per-request `grammar` field and it's too restrictive, the model may produce truncated output. Check `tools/agents/config/tool-call.gbnf` allows the argument types your tools use (strings, numbers, objects, arrays, booleans, null are all supported).

### Model only outputs tool calls, never plain text

You are likely using `--grammar-file` on the server command line. This forces ALL output into `<tool_call>` format. Remove `--grammar-file` from the startup command and let the autoparser handle tool call detection lazily.

### Multi-tool calls truncated to single call

Two possible causes:

1. `--grammar-file` is set globally and the stop sequence `</tool_call>` terminates after the first call. Remove `--grammar-file`.
2. The client is not passing `parallel_tool_calls: true` in the request. Add it to enable multiple tool calls per turn.

## Related Files

- `tools/agents/scripts/qwen_tool_call_wrapper.py` - Python wrapper with retry logic and format validation
- `tools/agents/scripts/fix_qwen_chat_template.py` - Template verifier/fixer (detects format, validates Jinja2)
- `tools/agents/scripts/qwen_tool_call_test.py` - Test suite using OpenAI-compatible API
- `src/cli/tool-calls.ts` - CLI command for template management
- `src/bin/llama-server-optimize.ts` - llama-server startup optimizer
- `docs/deployment/UAP_LLAMA_ANTHROPIC_PROXY_BOOTSTRAP.md` - service bootstrap + ngram-cache A/B benchmarking
