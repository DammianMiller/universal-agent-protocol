# Environment

## Machine Resources
- CPU: 32 cores
- RAM: 121GB
- GPU: NVIDIA RTX 3090 24GB

## Key Paths
- UAP project: /home/cogtek/dev/miller-tech/universal-agent-protocol
- llama.cpp: /home/cogtek/llama.cpp
- Models: /home/cogtek/Downloads/*.gguf

## Running Services
- llama-server on port 8080 (raw upstream OpenAI-compatible endpoint)
- Anthropic proxy on port 4000 (preferred coding-agent endpoint)
- Qdrant on 6333/6334

## Coding-Agent Runtime Defaults
- Proxy-first coding agents should use port 4000
- Direct llama.cpp diagnostics and low-level validation use port 8080
- Qwen coding profile timeout: 300000 ms
- Qwen coding profile stop sequence: <|im_end|>
