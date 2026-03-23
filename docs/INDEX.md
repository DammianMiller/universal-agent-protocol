# UAP Documentation

> @miller-tech/uap -- Documentation Hub

---

## Getting Started

- [Overview](getting-started/OVERVIEW.md) -- What is UAP, core concepts, 4-layer memory architecture
- [Setup](getting-started/SETUP.md) -- Installation, dependencies, configuration
- [Integration](getting-started/INTEGRATION.md) -- Claude Code, Factory.AI, OpenCode, ForgeCode, VSCode, Cursor

## Architecture

- [System Analysis](architecture/SYSTEM_ANALYSIS.md) -- Complete UAP feature analysis and architecture
- [Multi-Model Architecture](architecture/MULTI_MODEL.md) -- Planner/executor two-tier design
- [UAP Protocol](architecture/UAP_PROTOCOL.md) -- Protocol specification and compliance requirements
- [UAP Compliance](architecture/UAP_COMPLIANCE.md) -- Protocol enforcement plan
- [Strict Droids](architecture/UAP_STRICT_DROIDS.md) -- JSON schema validation for droid definitions

## Reference

- [API Reference](reference/API_REFERENCE.md) -- CLI commands, DB schema, API endpoints
- [CLI Reference](reference/UAP_CLI_REFERENCE.md) -- Full CLI command reference (25 commands, 109 subcommands)
- [Feature Inventory](reference/FEATURES.md) -- Complete feature status and implementation details
- [Harness Matrix](reference/HARNESS-MATRIX.md) -- Per-harness integration details

## Deployment

- [Deployment Guide](deployment/DEPLOYMENT.md) -- Model providers, IaC, CI/CD pipelines
- [Deployment Strategies](deployment/DEPLOYMENT_STRATEGIES.md) -- Window bucketing, batch processing
- [Deploy Batching](deployment/DEPLOY_BATCHING.md) -- Batch windows and bucketing system
- [Deploy Batcher Analysis](deployment/DEPLOY_BATCHER_ANALYSIS.md) -- DeployBatcher architecture
- [Deploy Bucketing Analysis](deployment/DEPLOY_BUCKETING_ANALYSIS.md) -- Bucketing capability report
- [Qwen3.5 / llama.cpp](deployment/QWEN35_LLAMA_CPP.md) -- Local LLM deployment with LoRA fine-tuning

## Integrations

- [MCP Router](integrations/MCP_ROUTER_SETUP.md) -- 98% token reduction via meta-tool routing
- [RTK Integration](integrations/RTK_INTEGRATION.md) -- Rust Token Killer CLI proxy

## Benchmarks

- [Validation Plan](benchmarks/VALIDATION_PLAN.md) -- Benchmark methodology and test cases
- [Validation Results](benchmarks/VALIDATION_RESULTS.md) -- Benchmark results
- [Speculative Decoding Journey (2026-03)](benchmarks/SPECULATIVE_DECODING_JOURNEY_2026-03.md) -- End-to-end tuning, fixes, and soak outcomes
- [Token Optimization](benchmarks/TOKEN_OPTIMIZATION.md) -- Per-feature token savings analysis
- [Accuracy Analysis](benchmarks/ACCURACY_ANALYSIS.md) -- Internal vs Terminal-Bench comparison

## Research

- [Memory Systems Comparison](research/MEMORY_SYSTEMS_COMPARISON.md) -- MemGPT, LangGraph, Mem0, A-MEM analysis
- [Behavioral Patterns](research/BEHAVIORAL_PATTERNS.md) -- Pattern analysis from Terminal-Bench
- [Terminal-Bench Learnings](research/TERMINAL_BENCH_LEARNINGS.md) -- Universal agent patterns discovered
- [Performance Analysis](research/PERFORMANCE_ANALYSIS_2026-01-18.md) -- UAP vs baseline benchmarking
- [Pattern Analysis](research/PATTERN_ANALYSIS_2026-01-18.md) -- Deep failure study
- [Performance Test Plan](research/PERFORMANCE_TEST_PLAN.md) -- Vanilla vs UAP-enhanced test plan
- [Domain Strategies](research/DOMAIN_STRATEGIES.md) -- CoreWars, specialized task guides

## Operations

- [Troubleshooting](operations/TROUBLESHOOTING.md) -- Common issues, recovery procedures, debugging

---

## Archive

Historical documents preserved for reference in [archive/](archive/).
