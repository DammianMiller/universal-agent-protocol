---
name: scripts-preload-memory
description: Memory system preloading and context initialization
---

# Memory Preload

Preloads memory context for enhanced agent performance.

## Purpose

Initialize agent memory with relevant context before task execution.

## Functions

- Load short-term memory
- Preload long-term patterns
- Initialize context windows
- Cache frequently accessed data

## Usage

Automatically invoked at session start.

## Location

`scripts/preload-memory.sh`

## Memory Types

- **Short-term**: Recent actions, decisions, context
- **Long-term**: Patterns, preferences, historical data
- **Session**: Current task context, open loops

## Integration

Works with:

- Session start hook
- Memory system database
- Coordination database
