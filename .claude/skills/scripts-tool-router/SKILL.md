---
name: scripts-tool-router
description: Intelligent tool routing and pattern matching for automated tasks
---

# Tool Router

Intelligent routing system for matching tasks to appropriate tools and patterns.

## Purpose

Automatically routes tasks to the optimal execution path based on task type, complexity, and available resources.

## Functions

- Pattern matching for task classification
- Tool selection based on task requirements
- Parallel execution orchestration
- Decision pipeline management

## Usage

Automatically invoked by opencode for complex multi-step tasks.

## Location

`src/coordination/pattern-router.ts` (patterns loaded from `.factory/patterns/index.json`)

## Integration

Used by:

- PR Reviewer Agent
- Adaptive Pattern Router
- Parallel Decision Pipeline

## Pattern Types

1. **Sequential** - Step-by-step execution
2. **Parallel** - Concurrent execution of independent tasks
3. **Conditional** - Branching based on results
4. **Adaptive** - Dynamic adjustment based on feedback
