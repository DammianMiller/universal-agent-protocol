# UAP Pattern Library Reference

Complete documentation for all 23 battle-tested patterns from Terminal-Bench 2.0.

## Pattern Index

| ID  | Name                                | Category        | Status      |
| --- | ----------------------------------- | --------------- | ----------- |
| P12 | Output Existence Verification       | Verification    | ✅ Critical |
| P13 | Iterative Refinement Loop           | Testing         | ✅ Active   |
| P14 | Output Format Validation            | Verification    | ✅ Active   |
| P16 | Task-First Execution                | Execution       | ✅ Active   |
| P17 | Constraint Extraction               | Planning        | ✅ Active   |
| P19 | Impossible Task Refusal             | Safety          | ✅ Active   |
| P20 | Adversarial Thinking                | Security        | ✅ Active   |
| P21 | Chess Engine Integration            | Domain-Specific | ✅ Active   |
| P22 | Git Recovery Forensics              | Recovery        | ✅ Active   |
| P23 | Compression Impossibility Detection | Verification    | ✅ Active   |
| P24 | Polyglot Code Construction          | Code-Golf       | ✅ Active   |
| P25 | Service Configuration Pipeline      | DevOps          | ✅ Active   |
| P26 | Near-Miss Iteration                 | Testing         | ✅ Active   |
| P28 | Service Smoke Test                  | Verification    | ✅ Active   |
| P30 | Performance Threshold Tuning        | Optimization    | ✅ Active   |
| P31 | Round-Trip Verification             | Verification    | ✅ Active   |
| P32 | CLI Execution Verification          | Verification    | ✅ Active   |
| P33 | Numerical Stability Testing         | Testing         | ✅ Active   |
| P34 | Image-to-Structured Pipeline        | Domain-Specific | ✅ Active   |
| P35 | Decoder-First Analysis              | Analysis        | ✅ Critical |
| P36 | Competition Domain Research         | Research        | ✅ Active   |
| P37 | Ambiguity Detection & Resolution    | Planning        | ✅ Active   |
| IaC | Infrastructure as Code Parity       | Infrastructure  | ✅ Active   |

## Critical Patterns (Mandatory)

The following patterns are enforced by the \`PatternRouter\` and are mandatory for all high-reliability tasks.

### P12 - Output Existence Verification
**Purpose:** Prevents the "phantom success" failure mode where an agent claims a file was created but it does not exist on disk.
**Enforcement:** The system automatically verifies the existence of any file mentioned in the final output of a task.

### P35 - Decoder-First Analysis
**Purpose:** Prevents incorrect problem decomposition by forcing the agent to analyze the format and structure of the input before proposing a solution.
**Enforcement:** The system requires a "decoder" phase where the agent identifies the schema or protocol of the target data.

---

## Pattern Details

### P13 - Iterative Refinement Loop
**Purpose:** Ensures first-attempt acceptance through systematic refinement.
**Workflow:** Implement $\rightarrow$ Test $\rightarrow$ Analyze $\rightarrow$ Refine $\rightarrow$ Repeat.

### P16 - Task-First Execution
**Purpose:** Prevents over-planning. Execute immediately if the task is clear; plan only when ambiguity exists.

### P17 - Constraint Extraction
**Purpose:** Identifies hidden requirements. Extract explicit and implicit constraints before implementation.

### P26 - Near-Miss Iteration
**Purpose:** Fixes small gaps between expected and actual results. Identify gap size $\rightarrow$ adjust $\rightarrow$ re-test.

### P37 - Ambiguity Detection & Resolution
**Purpose:** Clarifies vague requirements. Detect missing parameters or conflicting constraints before starting.

## See Also
- [Feature Reference](../../docs/reference/FEATURES.md)
- [CLI Reference](../../docs/reference/UAP_CLI_REFERENCE.md)
