# Architecture

## Stack Overview
```
Agentic Clients (Claude Code, Factory Droid, OpenCode)
        │  Anthropic Messages API (:4000)
        ▼
UAP Anthropic Proxy (Python)
        │  OpenAI-compatible API (:8080)
        ▼
llama.cpp llama-server (CUDA, Qwen3.5 35B A3B)
```

## Routing Guidance
- Proxy-first coding-agent flows should target `http://localhost:4000` or `http://host.docker.internal:4000/v1` from containers.
- Raw llama.cpp health, slots, and direct OpenAI-compatible checks still use port `8080`.
- Do not add explicit `<tool_call>` stop sequences to proxy-first coding clients; rely on the Qwen profile and proxy/tool grammar handling.
