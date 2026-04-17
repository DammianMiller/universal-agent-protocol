# parallel-reads

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: performance, parallelism, exploration

## Rule

Two or more independent read-only operations (`Read`, `Grep`, `Glob`, non-mutating `Bash`, `WebFetch`) with no data dependency MUST be dispatched in a single tool-call batch.

## Why

Serial fan-out multiplies wall-clock by N on every exploration. Claude Code supports parallel tool calls in one message. Measured speed-up on codebase surveys: 2–5×.

## Enforcement

Python enforcer `parallel_reads.py` (post-exec sampler) detects serial read patterns within a tight time window and warns on the next message.

```rules
- title: "Batch independent reads"
  keywords: [read, grep, glob, webfetch, inspect]
  antiPatterns: [serial-read, one-by-one, sequential-survey]
```
