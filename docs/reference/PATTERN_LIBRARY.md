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

## Pattern Details

### P12 - Output Existence Verification

**Purpose:** Prevents missing output files (37% of Terminal-Bench failures)

**When to Use:**

- File creation tasks
- Build/output generation
- Deployment tasks

**Example:**

```bash
uap patterns enable P12
```

**Checklist:**

- [ ] Verify output file exists after task completion
- [ ] Check file permissions and ownership
- [ ] Validate file content matches expectations

---

### P13 - Iterative Refinement Loop

**Purpose:** Ensures first-attempt acceptance through systematic refinement

**When to Use:**

- Complex feature implementation
- Bug fixes with multiple edge cases
- Performance optimization tasks

**Example:**

```bash
uap patterns enable P13
```

**Workflow:**

1. Implement initial solution
2. Run tests
3. Analyze failures
4. Refine implementation
5. Repeat until all tests pass

---

### P14 - Output Format Validation

**Purpose:** Prevents wrong format/encoding errors

**When to Use:**

- JSON/YAML generation
- CSV data export
- Configuration file creation

**Example:**

```bash
uap patterns enable P14
```

**Validation Rules:**

- JSON: Valid JSON syntax, required fields present
- YAML: Valid YAML syntax, proper indentation
- CSV: Correct column count, delimiter consistency

---

### P16 - Task-First Execution

**Purpose:** Prevents over-planning before doing

**When to Use:**

- Clear task descriptions
- Well-defined requirements
- Time-sensitive tasks

**Example:**

```bash
uap patterns enable P16
```

**Guideline:**

- Execute immediately if task is clear
- Plan only when ambiguity exists
- Document decisions as you go

---

### P17 - Constraint Extraction

**Purpose:** Identifies hidden requirements and constraints

**When to Use:**

- Ambiguous task descriptions
- Complex system integrations
- Multi-step workflows

**Example:**

```bash
uap patterns enable P17
```

**Extraction Process:**

1. Identify explicit constraints ("exactly", "only", "must be")
2. Infer implicit constraints from context
3. Document all constraints before implementation

---

### P19 - Impossible Task Refusal

**Purpose:** Prevents attempting fundamentally impossible tasks

**When to Use:**

- Tasks requiring impossible capabilities
- Requests violating physical laws
- Tasks exceeding system limits

**Example:**

```bash
uap patterns enable P19
```

**Refusal Criteria:**

- Requires capabilities not available
- Violates security policies
- Exceeds computational limits

---

### P20 - Adversarial Thinking

**Purpose:** Identifies missing attack vectors and security issues

**When to Use:**

- Security-sensitive implementations
- Authentication/authorization systems
- Data processing pipelines

**Example:**

```bash
uap patterns enable P20
```

**Attack Vectors:**

- Input validation bypass
- Authentication circumvention
- Authorization escalation
- Data exposure

---

### P21 - Chess Engine Integration

**Purpose:** Leverages existing chess engines instead of reinventing

**When to Use:**

- Chess game analysis
- Move generation
- Position evaluation

**Example:**

```bash
uap patterns enable P21
```

**Integration Points:**

- Stockfish API
- FEN position parsing
- Move validation
- Evaluation scoring

---

### P22 - Git Recovery Forensics

**Purpose:** Recovers lost commits and corrupted repositories

**When to Use:**

- Accidental deletions
- Repository corruption
- Lost branch references

**Example:**

```bash
uap patterns enable P22
```

**Recovery Tools:**

- `git reflog`
- `git fsck`
- `git filter-branch`
- `git reset --hard`

---

### P23 - Compression Impossibility Detection

**Purpose:** Identifies already-compressed or incompressible data

**When to Use:**

- File compression tasks
- Archive creation
- Data optimization

**Example:**

```bash
uap patterns enable P23
```

**Detection Rules:**

- Check file extension (zip, jpg, mp4)
- Analyze entropy (high = already compressed)
- Test compression ratio before processing

---

### P24 - Polyglot Code Construction

**Purpose:** Creates code that works in multiple languages

**When to Use:**

- Code golf challenges
- Cross-language demonstrations
- Educational purposes

**Example:**

```bash
uap patterns enable P24
```

**Languages:**

- Python/JavaScript
- Ruby/Perl
- C/C++

---

### P25 - Service Configuration Pipeline

**Purpose:** Systematic service configuration and validation

**When to Use:**

- Daemon/server setup
- Configuration file management
- Service reload operations

**Example:**

```bash
uap patterns enable P25
```

**Pipeline Steps:**

1. Validate configuration syntax
2. Check dependencies
3. Apply configuration
4. Reload service
5. Verify operation

---

### P26 - Near-Miss Iteration

**Purpose:** Fixes small gaps between expected and actual results

**When to Use:**

- Tests failing by small margin
- Output nearly correct
- Edge case handling

**Example:**

```bash
uap patterns enable P26
```

**Iteration Process:**

1. Identify gap size
2. Analyze failure reason
3. Make minimal adjustment
4. Re-test
5. Repeat until passing

---

### P28 - Service Smoke Test

**Purpose:** Verifies service deployment and operation

**When to Use:**

- After deployment
- Service restart
- Configuration changes

**Example:**

```bash
uap patterns enable P28
```

**Smoke Tests:**

- Health check endpoint
- Port accessibility
- Basic functionality
- Log output validation

---

### P30 - Performance Threshold Tuning

**Purpose:** Optimizes performance to meet specific thresholds

**When to Use:**

- Performance-critical tasks
- Optimization challenges
- Benchmark improvements

**Example:**

```bash
uap patterns enable P30
```

**Optimization Areas:**

- Algorithm complexity
- Memory usage
- I/O operations
- Network latency

---

### P31 - Round-Trip Verification

**Purpose:** Ensures encode/decode consistency

**When to Use:**

- Data serialization
- Encoding/decoding tasks
- Compression/decompression

**Example:**

```bash
uap patterns enable P31
```

**Verification Steps:**

1. Encode original data
2. Decode encoded data
3. Compare with original
4. Validate integrity

---

### P32 - CLI Execution Verification

**Purpose:** Validates command-line tool functionality

**When to Use:**

- CLI tool development
- Command execution tasks
- Binary verification

**Example:**

```bash
uap patterns enable P32
```

**Verification:**

- Executable permissions
- Command output validation
- Exit code checking
- Error handling

---

### P33 - Numerical Stability Testing

**Purpose:** Prevents floating-point precision errors

**When to Use:**

- Mathematical computations
- Optimization algorithms
- Scientific calculations

**Example:**

```bash
uap patterns enable P33
```

**Stability Checks:**

- Epsilon comparisons
- Iteration convergence
- Precision limits
- Overflow/underflow

---

### P34 - Image-to-Structured Pipeline

**Purpose:** Extracts structured data from images

**When to Use:**

- OCR tasks
- Diagram analysis
- Chess board recognition
- Form processing

**Example:**

```bash
uap patterns enable P34
```

**Pipeline Steps:**

1. Image preprocessing
2. Feature extraction
3. Pattern recognition
4. Structured output generation

---

### P35 - Decoder-First Analysis

**Purpose:** Correct problem decomposition through format analysis

**When to Use:**

- Unknown file formats
- Protocol parsing
- Data structure analysis

**Example:**

```bash
uap patterns enable P35
```

**Analysis Process:**

1. Identify format type
2. Analyze structure
3. Extract schema
4. Implement parser

---

### P36 - Competition Domain Research

**Purpose:** Leverages domain knowledge for competitive tasks

**When to Use:**

- Tournament challenges
- Leaderboard optimization
- Competitive programming

**Example:**

```bash
uap patterns enable P36
```

**Research Areas:**

- Winning strategies
- Common patterns
- Edge cases
- Optimization techniques

---

### P37 - Ambiguity Detection & Resolution

**Purpose:** Identifies and clarifies ambiguous task descriptions

**When to Use:**

- Vague requirements
- Unclear specifications
- Missing context

**Example:**

```bash
uap patterns enable P37
```

**Detection Criteria:**

- Missing parameters
- Undefined terms
- Conflicting requirements
- Unspecified constraints

---

### IaC - Infrastructure as Code Parity

**Purpose:** Ensures config drift prevention

**When to Use:**

- Terraform deployments
- Kubernetes manifests
- Infrastructure automation

**Example:**

```bash
uap patterns enable IaC
```

**Parity Checks:**

- State file consistency
- Resource drift detection
- Configuration validation
- Deployment verification

## Pattern Selection Guide

### Critical Patterns (Always Active)

- P12: Output Existence Verification
- P35: Decoder-First Analysis

### Testing Patterns

- P13: Iterative Refinement Loop
- P26: Near-Miss Iteration
- P33: Numerical Stability Testing

### Verification Patterns

- P14: Output Format Validation
- P23: Compression Impossibility Detection
- P28: Service Smoke Test
- P31: Round-Trip Verification
- P32: CLI Execution Verification

### Planning Patterns

- P16: Task-First Execution
- P17: Constraint Extraction
- P37: Ambiguity Detection & Resolution

## See Also

- [Pattern System](../../docs/reference/FEATURES.md#pattern-system)
- [Terminal-Bench Patterns](https://github.com/aptx432/terminal-bench)
- [CLI Reference](./UAP_CLI_REFERENCE.md)
