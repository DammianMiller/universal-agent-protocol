# UAP Strict Droids Architecture

## Overview
Strict Droids are specialized agent configurations within the Universal Agent Protocol (UAP) that adhere to a rigorous validation pipeline. Unlike general-purpose agents, Strict Droids are designed for deterministic behavior in critical paths, ensuring that every invocation is validated against schema, capability, and environment constraints.

## The Validation Pipeline

Every Strict Droid invocation must pass through a three-stage validation pipeline before execution:

### 1. JSON Schema Validation
The system enforces a strict metadata schema for all droids defined in \`.factory/droids/\`. This prevents configuration drift and ensures that all required fields are present and correctly typed.

**Schema Requirements:**
- **Name**: Unique identifier for the droid.
- **Description**: A meaningful description of the droid's specialization.
- **Model**: Either \`inherit\` (use project default) or \`dedicated\` (specific model profile).
- **Coordination**: Optional coordination constraints (e.g., exclusive claims).

**Implementation:** Handled via Zod schemas in \`src/uap-droids-strict.ts\`.

### 2. Decoder-First Gate
The Decoder-First gate ensures that the droid is capable of handling the specific task context before it is invoked. This prevents "hallucinated capabilities" where an agent claims to be an expert but lacks the necessary tools or context.

**Validation Steps:**
- **Schema Integrity**: Confirms metadata matches the required DROID_SCHEMA.
- **Tool Availability**: Verifies that all tools required by the droid's specialization are currently registered and accessible.
- **Coordination Check**: Validates that the droid's required claims do not conflict with other active agents.

### 3. Worktree Enforcement
To prevent race conditions and maintain a clean git history, Strict Droids can be configured to require an active worktree.

- **Logic**: The system verifies the current git state using \`git rev-parse --abbrev-ref HEAD\`.
- **Enforcement**: If \`requireWorktree: true\` is set in the droid configuration, the invocation is blocked unless the agent is operating within a valid worktree/branch.

---

## Compliance Matrix

| Feature | General Agents | Strict Droids | Purpose |
| :--- | :---: | :---: | :--- |
| Schema Validation | Optional | **Mandatory** | Prevent config errors |
| Decoder-First Gate | Implicit | **Explicit** | Ensure capability match |
| Worktree Check | Recommended | **Configurable** | Prevent state corruption |
| Tool Access | Dynamic | **Locked-down** | Deterministic behavior |

## Usage and Integration

### Discovery
Valid droids are discovered using \`discoverDroids()\`, which automatically filters out any configurations that fail the JSON schema validation.

### Invocation
When invoking a strict droid, the system executes the following sequence:
1. \`discoverDroids()\` $\rightarrow$ Validate Schema
2. \`validateDecoderFirst()\` $\rightarrow$ Validate Capabilities
3. \`ensureWorktree()\` $\rightarrow$ Validate Environment

If any stage fails, the system throws a \`DroidValidationError\`, preventing the agent from executing with an invalid state.
