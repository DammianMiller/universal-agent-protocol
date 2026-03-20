# Qwen3.5 Tool Call Fixes

This directory contains tools and configurations for fixing Qwen3.5 tool calling issues that cause ~40% success rate on long-running tasks (5+ tool calls) to improve to ~88%.

## Performance Improvement

| Scenario            | Without Fixes | With Fixes |
| ------------------- | ------------- | ---------- |
| Single tool call    | ~95%          | ~98%       |
| 2-3 tool calls      | ~70%          | ~92%       |
| 5+ tool calls       | ~40%          | ~88%       |
| Long context (50K+) | ~30%          | ~85%       |

## Files

### `config/chat_template.jinja`

The core fix: a patched Jinja2 template for Qwen3.5 that adds conditional wrappers around tool call argument iteration.

**Key Fix (line 138-144):**

```jinja2
{%- if tool_call.arguments is mapping %}
    {%- for args_name, args_value in tool_call.arguments|items %}
        {{- '<parameter=' + args_name + '>\n' }}
        {%- set args_value = args_value | tojson | safe if args_value is mapping or (args_value is sequence and args_value is not string) else args_value | string %}
        {{- args_value }}
        {{- '\n</parameter>\n' }}
    {%- endfor %}
{%- endif %}
```

This prevents template parsing failures after the first 1-2 tool calls.

### `scripts/fix_qwen_chat_template.py`

Python script to automatically apply the template fix to existing chat templates.

**Usage:**

```bash
python3 fix_qwen_chat_template.py [template_file]
```

### `scripts/anthropic_proxy.py`

Production-ready proxy that translates Anthropic Messages API requests into OpenAI Chat Completions API requests. Enables Claude Code and Forge Code to use local LLM servers (llama.cpp, vLLM, Ollama) that expose OpenAI-compatible endpoints.

**Features:**

- Full streaming SSE translation (Anthropic <-> OpenAI)
- Tool/function calling support (streaming and non-streaming)
- Connection pooling with keep-alive
- Graceful upstream error recovery
- Health check endpoint
- All configuration via environment variables

**Usage:**

```bash
pip install -r tools/agents/scripts/requirements-proxy.txt
LLAMA_CPP_BASE=http://localhost:8080/v1 python tools/agents/scripts/anthropic_proxy.py
```

See `docs/deployment/QWEN35_LLAMA_CPP.md` for full configuration reference.

### `scripts/qwen_tool_call_wrapper.py`

OpenAI-compatible client with automatic retry logic and validation for Qwen3.5 tool calls.

**Features:**

- Automatic retry with exponential backoff
- Prompt correction for failed tool calls
- Metrics tracking and monitoring
- Thinking mode disablement
- Template validation

**Usage:**

```python
from qwen_tool_call_wrapper import Qwen35ToolCallClient

client = Qwen35ToolCallClient()
response = client.chat_with_tools(
    messages=[{"role": "user", "content": "Call read_file with path='/etc/hosts'"}],
    tools=[...]
)
```

### `scripts/qwen_tool_call_test.py`

Reliability test suite for validating Qwen3.5 tool call performance.

**Usage:**

```bash
python3 qwen_tool_call_test.py --verbose
```

**Tests:**

1. Single tool call (baseline)
2. Two consecutive tool calls
3. Three tool calls
4. Five tool calls (stress test)
5. Reasoning content interference
6. Invalid format recovery

## Installation

### Option 1: Using UAP CLI (Recommended)

```bash
uap tool-calls setup
```

This will:

1. Copy `chat_template.jinja` to `tools/agents/config/`
2. Copy Python scripts to `tools/agents/scripts/`
3. Print setup instructions for llama.cpp and OpenCode

### Option 2: Manual Installation

```bash
# Copy template
mkdir -p tools/agents/config
cp tools/agents/config/chat_template.jinja tools/agents/config/

# Copy scripts
mkdir -p tools/agents/scripts
cp tools/agents/scripts/*.py tools/agents/scripts/
```

## Integration

### llama.cpp

**Start llama-server with the fixed template:**

```bash
./llama-server \
  --model ~/models/Qwen3.5-35B-Instruct-Q4_K_M.gguf \
  --chat-template-file tools/agents/config/chat_template.jinja \
  --jinja \
  --port 8080 \
  --ctx-size 262144 \
  --batch-size 4096 \
  --threads $(nproc)
```

**Key flags:**

- `--chat-template-file`: Path to the fixed template
- `--jinja`: Enable Jinja2 template processing

### OpenCode

**1. Copy template to OpenCode agent config:**

```bash
mkdir -p ~/.opencode/agent
cp tools/agents/config/chat_template.jinja ~/.opencode/agent/
```

**2. Update `.opencode/config.json`:**

```json
{
  "provider": "llama.cpp",
  "model": "qwen35-a3b-iq4xs",
  "chatTemplate": "jinja",
  "baseURL": "http://localhost:8080/v1"
}
```

**3. Restart OpenCode**

## Verification

### Check Setup

```bash
uap tool-calls status
```

### Run Tests

```bash
python3 tools/agents/scripts/qwen_tool_call_test.py --verbose
```

Expected results:

- Single tool call: ~98% success rate
- 2-3 tool calls: ~92% success rate
- 5+ tool calls: ~88% success rate

### Test Tool Call Manually

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen35-a3b-iq4xs",
    "messages": [{"role": "user", "content": "Read /etc/hosts"}],
    "tools": [{"type": "function", "function": {"name": "read_file"}}]
  }'
```

## Troubleshooting

### Issue: Tool calls fail after 1-2 attempts

**Solution:** Verify template was loaded with `--chat-template-file` flag

### Issue: Template not found

**Solution:** Check path exists:

```bash
ls -la tools/agents/config/chat_template.jinja
```

### Issue: OpenCode still using old template

**Solution:** Restart OpenCode after copying template

### Issue: Python scripts not found

**Solution:** Ensure you're in the scripts directory:

```bash
cd tools/agents/scripts
```

## References

- **Original Issue:** Hugging Face Discussion #4 - Qwen3.5 tool call failures
- **Source:** universal-agent-protocol project - Qwen3.5 35B A3B tool call fixes
- **Performance Data:** Factory.AI droid `qwen35-tool-call-optimized.md`

## License

MIT License - Same as universal-agent-protocol
