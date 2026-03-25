# Environment

## Machine Resources
- CPU: 32 cores
- RAM: 121GB (57GB used, 63GB available)
- GPU: NVIDIA RTX 3090 24GB (20.5GB used by model, 3.6GB free)
- Disk: 3.6TB (210GB free, 94% used)

## Key Paths
- UAP project: /home/cogtek/dev/miller-tech/universal-agent-protocol
- llama.cpp: /home/cogtek/llama.cpp
- Models: /home/cogtek/Downloads/*.gguf
- Systemd user units: ~/.config/systemd/user/
- UAP env files: ~/.config/uap/

## Running Services
- llama-server on port 8080 (currently upstream build 002, no spec)
- Anthropic proxy on port 4000 (systemd managed)
- Qdrant on 6333/6334 (Docker)
- Postgres on 54329 (embedded)

## GPU Memory Budget
- Qwen3.5-35B-A3B-UD-IQ4_XS with q4_0 KV cache at 262k context: ~20.5GB
- Qwen3.5-0.8B-Q8_0 draft model: ~811MB
- Total with both models: ~21.3GB (within 24GB limit)
