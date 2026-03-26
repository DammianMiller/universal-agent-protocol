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

## Hybrid Model Architecture
Qwen3.5-35B-A3B is a hybrid model with BOTH:
- Attention layers (standard transformer, supports partial KV cache removal)
- Recurrent/SSM layers (Mamba-like, state is a running accumulation with NO per-token granularity)

This is why speculative decoding is hard: the attention cache supports partial `seq_rm` for rollback, but the recurrent state does not. The custom checkpoint system saves/restores recurrent R/S tensor snapshots to CPU RAM to enable rollback.

## Speculative Decoding Flow
1. Server generates N draft tokens using ngram-cache prediction
2. Target model evaluates all N draft tokens in a single batch
3. Tokens are accepted/rejected based on probability comparison
4. On rejection at position M: need to roll back model state to position M
5. For attention: `seq_rm(seq_id, M, -1)` removes rejected KV entries
6. For recurrent: must restore checkpoint saved before the speculative batch

## Proxy Guardrails
The Anthropic proxy has extensive stability features for agentic use:
- Loop breaker (detects repetitive tool-loop behavior)
- Malformed tool stream strict mode
- Tool narrowing (reduces tool list to top relevant)
- Forced tool dampener
- Context release threshold
- Session TTL (2h)
